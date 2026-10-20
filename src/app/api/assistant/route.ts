import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, clientKey, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { liveModelConfigured, selectLiveAdapter } from '@/lib/agent/adapter';
import { bankGuidedAdapter } from '@/lib/agent/bank-guided';
import { BANK_SYSTEM_PROMPT, BANK_TOOLS } from '@/lib/agent/bank-tools';
import { recordRun, runAgentTurn } from '@/lib/agent/runner';
import { safeText } from '@/lib/security/sanitize';

const Body = z
  .object({
    message: safeText(2000),
    // Prior turns, text only, held by the client. Bounded server-side too.
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict())
      .max(12)
      .optional(),
  })
  .strict();

/**
 * One assistant turn. The live model is used when configured; otherwise the
 * guided planner runs the same tools. Either way the response says which, and
 * a live attempt that fails falls back to guided rather than leaving the student
 * with nothing — and reports that it did.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    rateLimit(`assistant:${session.id}`, 15, 60_000);
    rateLimit(`assistant-ip:${clientKey(req)}`, 40, 60_000);
    const body = await parseBody(req, Body);
    const db = getDb();
    const opts = { tools: BANK_TOOLS, system: BANK_SYSTEM_PROMPT, history: body.history ?? [] };

    let run = liveModelConfigured()
      ? await runAgentTurn({ db, session }, selectLiveAdapter(), body.message, opts)
      : null;
    let fellBack: string | null = null;
    if (!run || run.status === 'MODEL_UNAVAILABLE' || run.status === 'TIMEOUT') {
      fellBack = run ? run.errorClass ?? run.status : null;
      run = await runAgentTurn({ db, session }, bankGuidedAdapter(), body.message, opts);
    }
    await recordRun(db, session.id, run);

    const proposals = run.steps
      .filter((s) => s.ok && (s.tool === 'propose_conversion' || s.tool === 'propose_bill_payment'))
      .map((s) => (s.resultSummary as { proposalId?: string })?.proposalId)
      .filter(Boolean);

    return json({
      reply: run.reply,
      mode: run.mode,
      model: run.modelName,
      liveFallbackReason: fellBack,
      steps: run.steps.map((s) => ({ tool: s.tool, ok: s.ok })),
      proposals,
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
    });
  } catch (error) {
    return fail(error);
  }
}
