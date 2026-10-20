/**
 * The model's entire capability surface. Five tools, all read-or-prepare.
 *
 * What is deliberately ABSENT, and must stay absent:
 *   - any approve or execute tool
 *   - any SQL, filesystem, shell or arbitrary-URL tool
 *   - any argument naming a user, session or workspace
 *
 * Ownership is resolved from the SESSION the server already authenticated, never
 * from a tool argument, so a model that invents an id simply cannot reach another
 * workspace. Every schema is strict: an undeclared property is a rejected call.
 */
import { z } from 'zod';
import { planTuitionPayment } from '../domain/planner';
import { liveMidRate } from '../rates/live';
import { realRoutesForTarget } from '../rates/real-routes';
import { transitFor } from '../domain/transit';
import { resolveDeadline } from '../services/intake';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { comparePlan, createPlan, settledCreditMinor } from '../services/planning';
import { storedTransferStatus } from '../services/execution';
import { accountsFor, obligationsFor } from '../services/planning';
import {
  preparePayment,
  reviewPaymentOptions,
  reviewStagedPlans,
} from '../services/advisor';
import { listRemittances } from '../services/remittance';
import { sessionNow, type ResolvedSession } from '../services/workspace';
import { SUPPORTED_CURRENCIES, formatAmount, parseAmount, type Currency } from '../domain/money';
import { AppError } from '../services/errors';
import { CREDIT_EDUCATION, type EducationTopic } from '../content/credit-education';

type Db = NodePgDatabase<Record<string, never>>;

export interface ToolContext {
  readonly db: Db;
  readonly session: ResolvedSession;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly handler: (ctx: ToolContext, args: unknown) => Promise<unknown>;
}

/** Bounded output: a tool result can never be large enough to flood the context. */
const MAX_RESULT_BYTES = 8_192;

function bound(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text.length <= MAX_RESULT_BYTES) return value;
  return { truncated: true, reason: 'result too large', bytes: text.length };
}

const uuid = z.string().uuid();

const snapshotTool: ToolDefinition = {
  name: 'get_financial_snapshot',
  description:
    'Read the student balances, reserves, obligations and the current session clock. ' +
    'Takes no arguments: it always reads the signed-in workspace and no other.',
  // No owner argument exists, so none can be forged.
  schema: z.object({}).strict(),
  handler: async ({ db, session }) => {
    const accounts = await accountsFor(db, session.id);
    const obligations = await obligationsFor(db, session.id);
    const remittances = await listRemittances(db, session);
    return bound({
      asOf: sessionNow(session).toISOString(),
      clockKind: session.clockKind,
      scenario: session.scenarioVersion,
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        currency: a.currency,
        balance: formatAmount(a.balanceMinor, a.currency as Currency),
        available: formatAmount(a.balanceMinor - a.reservedMinor, a.currency as Currency),
      })),
      // Money expected from family/scholarships that is NOT yet available. It is
      // never counted in balances until the user releases it.
      inboundRemittances: remittances.map((r) => ({
        label: r.label,
        sender: r.senderLabel,
        currency: r.currency,
        amount: r.amount,
        status: r.status,
        expectedAvailableAt: r.expectedAvailableAt,
        releasable: r.releasable,
      })),
      obligations: await Promise.all(
        obligations.map(async (o) => {
          const settled = await settledCreditMinor(db, o.id);
          return {
            id: o.id,
            description: o.description,
            currency: o.currency,
            target: formatAmount(o.targetMinor, o.currency as Currency),
            settled: formatAmount(settled, o.currency as Currency),
            outstanding: formatAmount(o.targetMinor - settled, o.currency as Currency),
            deadlineAt: o.deadlineAt.toISOString(),
            deadlineTimezone: o.deadlineTimezone,
            reserve: formatAmount(o.reserveMinor, o.reserveCurrency as Currency),
          };
        }),
      ),
      simulated: true,
    });
  },
};

const compareTool: ToolDefinition = {
  name: 'compare_routes',
  description:
    'Compare every supported route for an obligation. Returns the recommendation, the ' +
    'alternatives, and every excluded route WITH its reason. Moves no money and writes nothing. ' +
    'These figures are authoritative: never recalculate or round them yourself.',
  schema: z.object({ obligationId: uuid, sourceAccountId: uuid }).strict(),
  handler: async ({ db, session }, args) => {
    const { obligationId, sourceAccountId } = args as { obligationId: string; sourceAccountId: string };
    const { result } = await comparePlan(db, session, { obligationId, sourceAccountId });
    return bound({
      outcome: result.outcome,
      recommended: result.recommended && {
        routeId: result.recommended.pricing.routeId,
        provider: result.recommended.pricing.providerLabel,
        totalDebit: formatAmount(result.recommended.pricing.totalDebitMinor, result.recommended.pricing.from),
        recipientAmount: formatAmount(result.recommended.pricing.targetMinor, result.recommended.pricing.to),
        fee: formatAmount(result.recommended.pricing.feeMinor, result.recommended.pricing.from),
        rate: result.recommended.pricing.rate,
        expectedPostingAt: result.recommended.pricing.postedAt.toISOString(),
        // Both numbers, because the agent is asked "what will I have left?" and
        // without this it would have to invent the answer. A tool that omits a
        // fact the user will ask for is a hallucination waiting to happen.
        projectedLow: formatAmount(result.recommended.projectedLowMinor, result.recommended.pricing.from),
        reserveMargin: formatAmount(result.recommended.reserveMarginMinor, result.recommended.pricing.from),
      },
      alternatives: result.alternatives.map((c) => ({
        routeId: c.pricing.routeId,
        totalDebit: formatAmount(c.pricing.totalDebitMinor, c.pricing.from),
        projectedLow: formatAmount(c.projectedLowMinor, c.pricing.from),
      })),
      excluded: result.excluded.map((c) => ({
        routeId: c.pricing.routeId,
        totalDebit: formatAmount(c.pricing.totalDebitMinor, c.pricing.from),
        exclusions: c.exclusions,
      })),
      shortfall: result.shortfallMinor === null ? null : formatAmount(result.shortfallMinor, 'GBP'),
      simulated: true,
    });
  },
};

const createPlanTool: ToolDefinition = {
  name: 'create_payment_proposal',
  description:
    'Freeze a chosen route into an immutable proposal for the user to review. This does NOT ' +
    'approve or send anything: it only prepares terms. The user must approve it themselves on ' +
    'the review screen, and you cannot do that for them.',
  // The model picks a ROUTE. It cannot name an amount, a fee or a rate.
  schema: z
    .object({ obligationId: uuid, sourceAccountId: uuid, routeId: z.string().min(1).max(64) })
    .strict(),
  handler: async ({ db, session }, args) => {
    const input = args as { obligationId: string; sourceAccountId: string; routeId: string };
    const plan = await createPlan(db, session, input);
    return bound({
      planId: plan.planId,
      termsHash: plan.termsHash,
      totalDebit: plan.terms.totalDebitAmount,
      recipientAmount: plan.terms.targetAmount,
      expiresAt: plan.expiresAt.toISOString(),
      // Said plainly so the model cannot imply it has done more than this.
      state: 'AWAITING_USER_APPROVAL',
      nextStep: 'The user must open the review screen and approve these exact terms.',
      simulated: true,
    });
  },
};

const statusTool: ToolDefinition = {
  name: 'get_transfer_status',
  description:
    'Read the stored status of one of your own transfers. SUBMITTED, DELIVERED and POSTED are ' +
    'different facts: only POSTED means the tuition has been credited.',
  schema: z.object({ transferId: uuid }).strict(),
  handler: async ({ db, session }, args) => {
    const { transferId } = args as { transferId: string };
    const t = await storedTransferStatus(db, session, transferId);
    return bound({
      transferId: t.id,
      status: t.status,
      debit: formatAmount(t.debitAmountMinor, t.sourceCurrency),
      credit: formatAmount(t.creditAmountMinor, t.targetCurrency),
      deliveredAt: t.deliveredAt?.toISOString() ?? null,
      postedAt: t.postedAt?.toISOString() ?? null,
      tuitionPosted: t.status === 'POSTED',
      simulated: true,
    });
  },
};

const educationTool: ToolDefinition = {
  name: 'get_credit_education',
  description:
    'Retrieve reviewed, source-backed credit education for a supported topic. If the topic or ' +
    'jurisdiction is not supported, it says so: answer from this tool or abstain, never from memory.',
  schema: z
    .object({
      topic: z.enum([
        'credit_reports',
        'correcting_errors',
        'responsible_repayment',
        'starting_without_history',
      ]),
      jurisdiction: z.string().min(2).max(2),
    })
    .strict(),
  handler: async (_ctx, args) => {
    const { topic, jurisdiction } = args as { topic: EducationTopic; jurisdiction: string };
    if (jurisdiction.toUpperCase() !== 'US') {
      // Abstention is a correct answer. Eligibility is never inferred from a
      // nationality, a visa or an institution name.
      return bound({
        supported: false,
        jurisdiction,
        reason: 'Only US credit education has been reviewed for this release.',
        advice: null,
      });
    }
    const card = CREDIT_EDUCATION[topic];
    return bound({
      ...card,
      supported: true,
      jurisdiction: 'US',
      // Served with the truth about its own provenance. An unverified citation
      // must be presented as unverified, never as a reviewed source.
      citationVerified: card.source.verified,
      presentAs: card.source.verified
        ? 'reviewed source'
        : 'UNVERIFIED: tell the user this citation has not yet been confirmed by a human',
    });
  },
};

/**
 * Id-free comparison of every bill: recommended route, alternatives, excluded
 * routes with reasons, plus the explicit fee / embedded FX-margin split and the
 * business-day posting estimate. The tool resolves the signed-in workspace and
 * the funding account itself, so the model cannot name a wrong account.
 */
const reviewOptionsTool: ToolDefinition = {
  name: 'review_payment_options',
  description:
    'Compare routes for EVERY bill in the signed-in workspace, with the all-in cost split into an ' +
    'explicit fee and an embedded FX margin, the business-day posting estimate, the reserve margin, ' +
    'and why each excluded route was excluded. Takes no arguments. These figures are authoritative: ' +
    'never recalculate or round them yourself.',
  schema: z.object({}).strict(),
  handler: async ({ db, session }) => bound(await reviewPaymentOptions(db, session)),
};

/** Expected inbound money (family support, scholarship, refund) and its status. */
const reviewRemittancesTool: ToolDefinition = {
  name: 'review_inbound_remittances',
  description:
    'List inbound remittances the student is expecting (family, scholarship, refund), with amount, ' +
    'currency, status and when they clear. Expected money is NOT spendable and must not be counted in ' +
    'a balance until it is released. Takes no arguments. Read-only: you cannot release the money yourself.',
  schema: z.object({}).strict(),
  handler: async ({ db, session }) => bound({ remittances: await listRemittances(db, session) }),
};

/** A deterministic, dated staged-payment plan when one bill cannot be paid in full today. */
const stagedPlanTool: ToolDefinition = {
  name: 'plan_staged_payments',
  description:
    'Propose a dated, staged-payment plan for each unpaid bill that cannot be paid in full today, ' +
    'using expected inbound money and the reserve. Each leg names the route, the amount, when it can be ' +
    'sent and when it posts; every leg still posts by the deadline and preserves the reserve. Takes no ' +
    'arguments. Read-only; it prepares no proposal and moves no money.',
  schema: z.object({}).strict(),
  handler: async ({ db, session }) => bound(await reviewStagedPlans(db, session)),
};

/**
 * Prepare a proposal without naming object ids. Defaults to the earliest
 * unpaid bill and its recommended route. Still requires the user to approve.
 */
const prepareTool: ToolDefinition = {
  name: 'prepare_payment',
  description:
    'Prepare a payment proposal for the earliest unpaid bill (or a specified bill/route). This only ' +
    'PREPARES terms: it never approves or sends money, and the user must approve the exact terms on the ' +
    'review screen. Use after review_payment_options shows a feasible route.',
  schema: z
    .object({
      obligationId: uuid.optional(),
      routeId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  handler: async ({ db, session }, args) => {
    const { obligationId, routeId } = args as { obligationId?: string; routeId?: string };
    return bound(await preparePayment(db, session, { obligationId, routeId }));
  },
};


/**
 * The tool that answers the real question, with no stored workspace at all.
 *
 * It takes what the student would type into the form and returns live quotes
 * from named providers. The model does not compute any of it: every figure here
 * was produced by the deterministic planner from a provider's own quote, and
 * the model's job is to explain the result, not to derive it.
 */
const liveCompareTool: ToolDefinition = {
  name: 'compare_live_providers',
  description:
    'Compare what real banks and transfer providers would charge TODAY to pay a bill in another ' +
    'currency by a deadline, without exceeding what the student can afford. Returns live quotes ' +
    'with each provider name, what the student sends, the fee, the margin hidden in the exchange ' +
    'rate, the arrival estimate, and whether the option is usable. These figures are authoritative: ' +
    'quote them exactly and never recalculate or round them.',
  schema: z
    .object({
      targetAmount: z.string().min(1).max(20),
      targetCurrency: z.enum(SUPPORTED_CURRENCIES),
      sourceCurrency: z.enum(SUPPORTED_CURRENCIES),
      balance: z.string().min(1).max(20),
      reserve: z.string().min(1).max(20),
      deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      deadlineTime: z.string().regex(/^\d{2}:\d{2}$/),
      deadlineTimezone: z.string().min(3).max(64),
    })
    .strict(),
  handler: async (_ctx, args) => {
    const a = args as Record<string, string>;
    const from = a.sourceCurrency as Currency;
    const to = a.targetCurrency as Currency;
    if (from === to) {
      return bound({ usable: false, reason: 'No conversion is needed when both currencies match.' });
    }

    const target = parseAmount(a.targetAmount!, to);
    const deadlineAt = resolveDeadline(a.deadlineDate!, a.deadlineTime!, a.deadlineTimezone!);
    const now = new Date();
    if (deadlineAt.getTime() <= now.getTime()) {
      return bound({ usable: false, reason: 'That deadline has already passed.' });
    }

    const mid = await liveMidRate(from, to);
    const set = await realRoutesForTarget(from, to, formatAmount(target, to), mid.mid);
    const plan = planTuitionPayment({
      now,
      targetMinor: target,
      targetCurrency: to,
      deadlineAt,
      account: { currency: from, balanceMinor: parseAmount(a.balance!, from), reservedMinor: 0n },
      reserveMinor: parseAmount(a.reserve!, from),
      cashFlows: [],
      horizonDays: 90,
      routes: set.routes,
    });

    const describe = (c: (typeof plan.excluded)[number]) => {
      const q = set.comparison.quotes.find((x) => x.id === c.pricing.routeId);
      return {
        provider: c.pricing.providerLabel,
        youSend: formatAmount(c.pricing.totalDebitMinor, from),
        fee: formatAmount(c.pricing.feeMinor, from),
        marginPercent: q
          ? (((Number(mid.mid) - Number(q.rate)) / Number(mid.mid)) * 100).toFixed(2)
          : null,
        arrival: transitFor(q?.deliveryHours ?? null, q?.providerType).label,
        leftAfterwards: formatAmount(c.projectedLowMinor, from),
        usable: c.feasible,
        problems: c.exclusions,
        warnings: c.warnings,
      };
    };

    return bound({
      outcome: plan.outcome,
      best: plan.recommended ? describe(plan.recommended) : null,
      alternatives: plan.alternatives.slice(0, 4).map(describe),
      rejected: plan.excluded.slice(0, 4).map(describe),
      shortfall: plan.shortfallMinor === null ? null : formatAmount(plan.shortfallMinor, from),
      referenceRate: { mid: mid.mid, source: mid.source, asOf: mid.asOf },
      providersChecked: set.routes.length,
      arrivalCaveat:
        set.withPublishedArrival === 0
          ? 'No provider publishes an arrival time; arrival figures are our conservative assumption and must be verified with the provider.'
          : null,
      // Said plainly so the model cannot imply otherwise.
      note: 'This is advice only. BridgeWise does not move money; the student pays their provider themselves.',
    });
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  liveCompareTool,
  snapshotTool,
  reviewOptionsTool,
  reviewRemittancesTool,
  stagedPlanTool,
  compareTool,
  createPlanTool,
  prepareTool,
  statusTool,
  educationTool,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'UNAVAILABLE';

export interface ToolOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly errorCode?: ToolErrorCode;
  readonly errorMessage?: string;
}

/**
 * Executes one tool call. A model may request anything at all; this is where
 * reality is applied. Schema validity is NOT authorisation: every handler
 * re-checks ownership through the service layer.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
  // The toolset is passed in, so the bank assistant and the original tuition
  // agent each see exactly their own surface and nothing else.
  tools: readonly ToolDefinition[] = TOOLS,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    // Includes every attempt to call something that does not exist, such as an
    // approve_payment or execute_transfer the model may have imagined.
    return { ok: false, errorCode: 'UNKNOWN_TOOL', errorMessage: `no tool named ${name}` };
  }
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGUMENTS',
      errorMessage: parsed.error.issues.map((i) => `${i.path.join('.') || '_'}: ${i.message}`).join('; '),
    };
  }
  try {
    return { ok: true, result: await tool.handler(ctx, parsed.data) };
  } catch (error) {
    if (error instanceof AppError) {
      // A typed, safe error. Never a raw database message.
      return { ok: false, errorCode: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'REFUSED', errorMessage: error.message };
    }
    return { ok: false, errorCode: 'UNAVAILABLE', errorMessage: 'the tool is temporarily unavailable' };
  }
}
