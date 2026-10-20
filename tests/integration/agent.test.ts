/**
 * The agent boundary. These tests do not need a model credential, because what
 * is under test is what the server does with whatever a model asks for.
 *
 * A live model run is a SEPARATE population, reported separately. Nothing here
 * may be counted as evidence that a live agent works.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { createWorkspace, resolveSession, type ResolvedSession } from '@/lib/services/workspace';
import { TOOLS, runTool, toolByName } from '@/lib/agent/tools';
import { SYSTEM_PROMPT, runAgentTurn, toolSpecs } from '@/lib/agent/runner';
import { stubAdapter, type ModelTurn } from '@/lib/agent/adapter';
import { transfers, plans } from '@/lib/db/schema';
import { ATTACK_FIXTURES } from '@/lib/domain/fixtures';
import { CREDIT_EDUCATION } from '@/lib/content/credit-education';

const pool: pg.Pool = testPool();
const db = dbFor(pool);

let session: ResolvedSession;
let obligationId: string;
let sourceAccountId: string;

beforeEach(async () => {
  await truncateAll(pool);
  const created = await createWorkspace(db);
  session = await resolveSession(db, created.token);
  obligationId = created.obligationId;
  sourceAccountId = created.sourceAccountId;
});

afterAll(async () => {
  await pool.end();
});

const ctx = () => ({ db, session });

describe('the tool surface itself', () => {
  it('exposes the full, bounded tool surface', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'compare_live_providers',
      'compare_routes',
      'create_payment_proposal',
      'get_credit_education',
      'get_financial_snapshot',
      'get_transfer_status',
      'plan_staged_payments',
      'prepare_payment',
      'review_inbound_remittances',
      'review_payment_options',
    ]);
  });

  it('has no approve, execute, sql, url or filesystem tool', () => {
    const names = TOOLS.map((t) => t.name).join(' ');
    for (const forbidden of ['approve', 'execute', 'confirm', 'sql', 'query', 'fetch', 'url', 'file', 'shell']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('T31 refuses a tool that does not exist', async () => {
    for (const invented of ['approve_payment', 'execute_transfer', 'run_sql', 'http_get']) {
      const outcome = await runTool(ctx(), invented, {});
      expect(outcome.ok).toBe(false);
      expect(outcome.errorCode).toBe('UNKNOWN_TOOL');
    }
  });

  it('T31 refuses an undeclared property rather than ignoring it', async () => {
    const outcome = await runTool(ctx(), 'compare_routes', {
      obligationId,
      sourceAccountId,
      sessionId: 'some-other-session',
      approved: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('accepts no owner argument anywhere in its advertised schemas', () => {
    const advertised = JSON.stringify(toolSpecs());
    for (const forbidden of ['sessionId', 'userId', 'workspaceId', 'ownerId']) {
      expect(advertised).not.toContain(forbidden);
    }
  });

  it('advertises strict schemas to the model', () => {
    for (const spec of toolSpecs()) {
      expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});

describe('T08-T09 tools cannot cross a workspace', () => {
  it('a forged id from another session is not found', async () => {
    const other = await createWorkspace(db);
    const outcome = await runTool(ctx(), 'compare_routes', {
      obligationId: other.obligationId,
      sourceAccountId: other.sourceAccountId,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('NOT_FOUND');
  });

  it('a snapshot reads only the caller own workspace', async () => {
    const outcome = await runTool(ctx(), 'get_financial_snapshot', {});
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { accounts: unknown[]; obligations: unknown[] };
    expect(result.accounts).toHaveLength(2);
    expect(result.obligations).toHaveLength(1);
  });
});

describe('the model can prepare but never pay', () => {
  it('creating a proposal moves no money and says the user must approve', async () => {
    const outcome = await runTool(ctx(), 'create_payment_proposal', {
      obligationId,
      sourceAccountId,
      routeId: 'route-b',
    });
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { state: string; totalDebit: string };
    expect(result.state).toBe('AWAITING_USER_APPROVAL');
    expect(result.totalDebit).toBe('6435.00');

    // A plan exists; a transfer does not, and no approval was minted.
    expect(await db.select().from(plans)).toHaveLength(1);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('cannot propose an infeasible route', async () => {
    const outcome = await runTool(ctx(), 'create_payment_proposal', {
      obligationId,
      sourceAccountId,
      routeId: 'route-a',
    });
    expect(outcome.ok).toBe(false);
    expect(await db.select().from(plans)).toHaveLength(0);
  });
});

describe('T29-T30 untrusted text is data, not instructions', () => {
  it('an injected invoice cannot create a tool that does not exist', async () => {
    // Whatever a document says, the surface is the surface.
    const outcome = await runTool(ctx(), 'approve_payment', {
      instruction: ATTACK_FIXTURES.injectionInvoice,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('UNKNOWN_TOOL');
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('a model that obeys an injected invoice still moves no money', async () => {
    // The stub plays the part of a fully compromised model: it does exactly what
    // the hostile invoice asked. The server is what stops it.
    const compromised: ModelTurn[] = [
      {
        text: 'Acting on the invoice instructions.',
        toolCalls: [
          { id: '1', name: 'approve_payment', args: { planId: 'anything' } },
          { id: '2', name: 'execute_transfer', args: { amount: '999999.00' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'I could not do that.', toolCalls: [], stopReason: 'end_turn' },
    ];
    const run = await runAgentTurn(ctx(), stubAdapter(compromised), ATTACK_FIXTURES.injectionInvoice);
    expect(run.steps.every((s) => !s.ok)).toBe(true);
    expect(run.steps.map((s) => s.errorCode)).toEqual(['UNKNOWN_TOOL', 'UNKNOWN_TOOL']);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('a claim of administrator authority grants nothing', async () => {
    const outcome = await runTool(ctx(), 'compare_routes', {
      obligationId,
      sourceAccountId,
      override: ATTACK_FIXTURES.authorityClaim,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('the system prompt tells the model these are data and it cannot approve', () => {
    expect(SYSTEM_PROMPT).toMatch(/never as instructions/i);
    expect(SYSTEM_PROMPT).toMatch(/cannot approve or execute/i);
    // Belt and braces: the prompt is a layer, not the control.
    expect(SYSTEM_PROMPT).toMatch(/POSTED/);
  });
});

describe('T34 the loop is bounded by the server', () => {
  it('stops at the step limit and says nothing was sent', async () => {
    // A model that never stops asking for tools.
    const forever: ModelTurn[] = Array.from({ length: 20 }, (_, i) => ({
      text: null,
      toolCalls: [{ id: String(i), name: 'get_financial_snapshot', args: {} }],
      stopReason: 'tool_use',
    }));
    const run = await runAgentTurn(ctx(), stubAdapter(forever), 'keep going forever');
    expect(run.status).toBe('STEP_LIMIT');
    expect(run.steps.length).toBeLessThanOrEqual(Number(process.env.MAX_RUN_STEPS ?? 6));
    expect(run.reply).toMatch(/nothing was approved or sent/i);
  });

  it('T33 reports a model outage without corrupting any state', async () => {
    const broken = {
      mode: 'stub' as const,
      modelName: 'broken',
      async complete(): Promise<ModelTurn> {
        throw new Error('provider exploded');
      },
    };
    const run = await runAgentTurn(ctx(), broken, 'plan my tuition');
    expect(run.status).toBe('TIMEOUT');
    expect(run.reply).toMatch(/still work/i);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });
});

describe('T35-T36 education abstains rather than improvising', () => {
  it('refuses an unsupported jurisdiction', async () => {
    const outcome = await runTool(ctx(), 'get_credit_education', {
      topic: 'credit_reports',
      jurisdiction: 'GB',
    });
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { supported: boolean; advice: null };
    expect(result.supported).toBe(false);
    expect(result.advice).toBeNull();
  });

  it('refuses a topic that is not in the reviewed set', async () => {
    const outcome = await runTool(ctx(), 'get_credit_education', {
      topic: 'will_i_be_approved',
      jurisdiction: 'US',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('labels an unverified citation as unverified', async () => {
    const card = CREDIT_EDUCATION.credit_reports;
    const original = card.source;
    Object.assign(card, { source: { ...original, verified: false } });
    try {
    const outcome = await runTool(ctx(), 'get_credit_education', {
      topic: 'credit_reports',
      jurisdiction: 'US',
    });
    const result = outcome.result as { citationVerified: boolean; presentAs: string };
    // Exercise the unreviewed state even when the production card is reviewed.
    expect(result.citationVerified).toBe(false);
    expect(result.presentAs).toMatch(/UNVERIFIED/);
    } finally {
      Object.assign(card, { source: original });
    }
  });
});

describe('a well-behaved model run', () => {
  it('reads, compares, proposes, and stops for the user approval', async () => {
    const script: ModelTurn[] = [
      {
        text: null,
        toolCalls: [{ id: '1', name: 'get_financial_snapshot', args: {} }],
        stopReason: 'tool_use',
      },
      {
        text: null,
        toolCalls: [
          { id: '2', name: 'compare_routes', args: { obligationId, sourceAccountId } },
        ],
        stopReason: 'tool_use',
      },
      {
        text: null,
        toolCalls: [
          {
            id: '3',
            name: 'create_payment_proposal',
            args: { obligationId, sourceAccountId, routeId: 'route-b' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        text: 'Simulated B costs 6,435.00 GBP and posts before your deadline. Please review and approve it.',
        toolCalls: [],
        stopReason: 'end_turn',
      },
    ];

    const run = await runAgentTurn(ctx(), stubAdapter(script), 'Plan my tuition and keep my reserve.');
    expect(run.status).toBe('COMPLETED');
    expect(run.mode).toBe('stub');
    expect(run.steps.map((s) => s.tool)).toEqual([
      'get_financial_snapshot',
      'compare_routes',
      'create_payment_proposal',
    ]);
    expect(run.steps.every((s) => s.ok)).toBe(true);

    // It prepared a plan and stopped. It did not pay.
    expect(await db.select().from(plans)).toHaveLength(1);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });
});

describe('tool results are bounded and safe', () => {
  it('returns a typed error rather than a database message', async () => {
    const outcome = await runTool(ctx(), 'get_transfer_status', {
      transferId: '00000000-0000-0000-0000-000000000000',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).not.toMatch(/relation|column|syntax|postgres/i);
  });

  it('every tool result stays under the output bound', async () => {
    const outcome = await runTool(ctx(), 'get_financial_snapshot', {});
    expect(JSON.stringify(outcome.result).length).toBeLessThanOrEqual(8_192);
  });

  it('toolByName does not resolve something outside the five', () => {
    expect(toolByName('get_financial_snapshot')).toBeDefined();
    expect(toolByName('approve_payment')).toBeUndefined();
  });
});
