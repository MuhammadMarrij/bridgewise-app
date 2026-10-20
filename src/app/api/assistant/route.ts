import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, clientKey, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { liveModelConfigured, selectLiveAdapter } from '@/lib/agent/adapter';
import { liveBudget } from '@/lib/agent/budget';
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
    lang: z.enum(['en', 'zh']).optional(),
  })
  .strict();

// Chinese words the guided planner's English intents understand. The live model needs none of this.
const ZH_HINTS: Array<[RegExp, string]> = [
  [/学费/, 'pay my tuition'], [/汇率|走势/, 'exchange rate'], [/兑换|换汇|换成/, 'convert'], [/汇款|寄钱|转账/, 'send'],
  [/最便宜|比较/, 'cheapest compare providers'], [/预算/, 'budget'], [/花了|支出|开销|还能用/, 'spending'],
  [/流水|交易记录|最近交易/, 'transactions'], [/提醒/, 'alert'], [/提现|转出/, 'withdraw'], [/状况|情况|余额/, 'overview'],
];
const withHints = (m: string) => { const h = ZH_HINTS.filter(([re]) => re.test(m)).map(([, w]) => w); return h.length ? `${m} (${h.join(', ')})` : m; };

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
    await rateLimit(`assistant:${session.id}`, 15, 60_000);
    await rateLimit(`assistant-ip:${clientKey(req)}`, 40, 60_000);
    const body = await parseBody(req, Body);
    const db = getDb();
    const zh = body.lang === 'zh';
    const opts = {
      tools: BANK_TOOLS,
      system: zh ? `${BANK_SYSTEM_PROMPT}\n\nThe student is using the Chinese interface: reply in Simplified Chinese (简体中文). Keep amounts, currency codes and provider names as they are.` : BANK_SYSTEM_PROMPT,
      history: body.history ?? [],
    };

    const budget = liveModelConfigured() ? await liveBudget(db, session.id) : null;
    let run = budget?.allowed
      ? await runAgentTurn({ db, session }, selectLiveAdapter(), body.message, opts)
      : null;
    let fellBack: string | null = budget && !budget.allowed ? 'BUDGET' : null;
    if (!run || run.status === 'MODEL_UNAVAILABLE' || run.status === 'TIMEOUT') {
      fellBack = run ? run.errorClass ?? run.status : fellBack;
      run = await runAgentTurn({ db, session }, bankGuidedAdapter(), zh ? withHints(body.message) : body.message, opts);
    }
    await recordRun(db, session.id, run);

    const proposals = run.steps
      .filter((s) => s.ok && ['propose_conversion', 'propose_bill_payment', 'propose_transfer', 'propose_withdrawal'].includes(s.tool))
      .map((s) => (s.resultSummary as { proposalId?: string })?.proposalId)
      .filter(Boolean);

    return json({
      reply: run.reply,
      mode: run.mode,
      model: run.modelName,
      liveFallbackReason: fellBack,
      budgetNote: budget && !budget.allowed ? `Guided mode: ${budget.reason}. It resets at 08:00 Beijing time.` : null,
      steps: run.steps.map((s) => ({ tool: s.tool, ok: s.ok })),
      proposals,
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
    });
  } catch (error) {
    return fail(error);
  }
}
