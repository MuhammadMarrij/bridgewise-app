import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import {
  assertSameOrigin,
  clientKey,
  fail,
  json,
  parseBody,
  rateLimit,
  requireSession,
} from '@/lib/api/http';
import { liveModelConfigured, selectLiveAdapter } from '@/lib/agent/adapter';
import { guidedAdapter } from '@/lib/agent/guided';
import { recordRun, runAgentTurn } from '@/lib/agent/runner';
import { safeText } from '@/lib/security/sanitize';

const Body = z.object({
  message: safeText(4000),
  // "guided" (default, works with no key) or "live" (only when a model is configured).
  mode: z.enum(['guided', 'live']).optional(),
  // The figures the student entered in the form. Passed through verbatim so the
  // agent works on the student's real numbers rather than asking for them again.
  context: z
    .object({
      targetAmount: z.string().max(20),
      targetCurrency: z.string().max(3),
      sourceCurrency: z.string().max(3),
      balance: z.string().max(20),
      reserve: z.string().max(20),
      deadlineDate: z.string().max(10),
      deadlineTime: z.string().max(5),
      deadlineTimezone: z.string().max(64),
    })
    .strict()
    .optional(),
}).strict();

/** Marker the guided adapter looks for; the live model just reads it as text. */
export const CONTEXT_MARKER = 'STUDENT_FIGURES_JSON:';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    // The comparison tool needs no account, so neither does the assistant. A
    // signed-in session is used when present; without one, tools that need a
    // stored workspace simply report they have nothing to read.
    const session = await requireSession(req).catch(() => null);
    // The model is the expensive part. Bound it per session and per client so a
    // public demo cannot be used as somebody's free API.
    if (session) await rateLimit(`agent:${session.id}`, 10, 60_000);
    await rateLimit(`agent-ip:${clientKey(req)}`, 30, 60_000);
    const body = await parseBody(req, Body);
    const db = getDb();

    // Adapter selection. The default is the clearly-labelled GUIDED agent: a
    // deterministic planner that drives the real tool surface and needs no key.
    // A live model is used only when explicitly requested AND actually
    // configured; we never silently present a scripted answer as a live one.
    let adapter;
    if (body.mode === 'live') {
      if (!liveModelConfigured()) {
        return json(
          {
            mode: 'unavailable',
            status: 'MODEL_UNAVAILABLE',
            reply:
              'No live model is configured in this environment, so I am answering in guided mode: the ' +
              'deterministic planner that reads the same real tools. Send mode "guided" to use it, or ' +
              'configure MODEL_API_KEY/MODEL_NAME for a live run.',
            steps: [],
            simulated: true,
          },
          { status: 200 },
        );
      }
      adapter = selectLiveAdapter();
    } else {
      adapter = guidedAdapter();
    }

    const message = body.context
      ? `${body.message}\n\n${CONTEXT_MARKER}${JSON.stringify(body.context)}\n(Use compare_live_providers with exactly these figures.)`
      : body.message;
    const run = await runAgentTurn({ db, session: session as never }, adapter, message);
    if (session) await recordRun(db, session.id, run);

    return json({
      runId: run.runId,
      // Stated on every response so a live run can never be confused with a stub.
      mode: run.mode,
      modelName: run.modelName,
      status: run.status,
      reply: run.reply,
      // The trace is shown to the user in plain language, not hidden reasoning.
      steps: run.steps.map((s) => ({ tool: s.tool, ok: s.ok, errorCode: s.errorCode })),
      latencyMs: run.latencyMs,
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
