/**
 * The guided agent.
 *
 * A deterministic, rule-based planner that drives the SAME real tools the live
 * model uses. It is not a language model and it is labelled "guided" everywhere
 * it appears: it fetches the real snapshot, route comparisons, inbound
 * remittances and staged plans, and explains only what those tools returned.
 *
 * Why it exists:
 *   - the assistant must work in a judge's browser with no API key;
 *   - outages must not reduce the product to a form;
 *   - a guided run is honest evidence that the TOOL PLANE works, and it is
 *     reported separately from any live model run (never merged).
 *
 * It never invents a number (it quotes tool results), and it cannot approve or
 * execute a payment: there is no such tool.
 */
import type {
  ConversationMessage,
  ModelAdapter,
  ModelToolCall,
  ModelTurn,
} from './adapter';

type Json = Record<string, unknown>;

const id = (name: string) => `call-${name}`;
const call = (name: string, args: unknown = {}): ModelToolCall => ({ id: id(name), name, args });

function classifyIntent(message: string): {
  credit: boolean;
  prepare: boolean;
  staged: boolean;
  remittance: boolean;
  status: boolean;
} {
  const m = message.toLowerCase();
  const has = (...words: string[]) => words.some((w) => m.includes(w));
  return {
    credit: has('credit', 'score', 'report', 'borrow', 'loan history'),
    prepare: has('prepare', 'set up', 'create a proposal', 'start the payment', 'go with', 'choose route', "let's pay", 'lets pay', 'proceed'),
    staged: has('stage', 'installment', 'split', 'part payment', 'instalment', 'deposit', 'in full', 'until my family', 'family money', 'when it arrives'),
    remittance: has('remittance', 'family', 'scholarship', 'refund', 'coming', 'arrive', 'arrival', 'expected', 'receive', 'incoming'),
    status: has('status', 'where is', 'posted', 'delivered', 'on its way', 'track'),
  };
}

/** Reads every tool result so far, keyed by tool name (last result wins). */
function collectResults(messages: readonly ConversationMessage[]): Map<string, Json> {
  const callIdToName = new Map<string, string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) callIdToName.set(c.id, c.name);
  }
  const out = new Map<string, Json>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      const name = callIdToName.get(m.toolCallId);
      if (!name) continue;
      try {
        const parsed = JSON.parse(m.content) as Json;
        out.set(name, parsed);
      } catch {
        /* ignore malformed tool content */
      }
    }
  }
  return out;
}

function hasCall(messages: readonly ConversationMessage[], name: string): boolean {
  return messages.some((m) => (m.toolCalls ?? []).some((c) => c.name === name));
}

/* ------------------------------------------------------------ text synthesis */

function money(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function lineForExclusion(reasons: unknown): string {
  const r = Array.isArray(reasons) ? (reasons as string[]) : [];
  const labels: Record<string, string> = {
    MISSES_DEADLINE: 'would arrive after the deadline',
    INCOMPLETE_FEES: 'has an undisclosed fee, so its total cost is unknown',
    INSUFFICIENT_BALANCE: 'needs more available money than you have',
    BREACHES_RESERVE: 'would breach your emergency reserve',
    QUOTE_EXPIRED: 'quote expired',
    UNSUPPORTED_CORRIDOR: 'is not on this corridor',
    CURRENCY_MISMATCH: 'currency mismatch',
  };
  return r.map((x) => labels[x] ?? x).join('; ');
}

function buildBillSummary(obl: Json, includeExcluded: boolean): string[] {
  const lines: string[] = [];
  const desc = money(obl.description);
  const outstanding = money(obl.outstanding);
  const cur = money(obl.currency);
  const deadline = new Date(money(obl.deadlineAt));
  const comparison = obl.comparison as Json | undefined;
  const hasComparison = comparison && !('error' in comparison);

  if (!hasComparison) {
    lines.push(`• ${desc}: ${outstanding} ${cur} — ${money((comparison as Json)?.error)}.`);
    return lines;
  }

  const cmp = comparison as Json;
  const rec = cmp.recommended as Json | null;
  const outcome = money(cmp.outcome);

  if (rec) {
    const fx = rec.fxMarginBasisPoints;
    lines.push(
      `• ${desc}: ${outstanding} ${cur} due ${deadline.toUTCString().slice(0, 16)}. ` +
        `Recommended: ${money(rec.provider)} — all-in ${money(rec.totalDebit)} ${money(rec.from)} to send ` +
        `${money(rec.recipientAmount)} ${money(rec.to)} (fee ${money(rec.fee)}, embedded FX margin ` +
        `${fx === null ? 'n/a' : `~${fx} bps`}). It posts ${new Date(money(rec.expectedPostingAt)).toUTCString().slice(0, 16)}, ` +
        `leaving a reserve margin of ${money(rec.reserveMargin)} ${money(rec.from)}.`,
    );
  } else if (outcome === 'NO_FEASIBLE_PLAN') {
    const short = cmp.shortfall;
    lines.push(
      `• ${desc}: ${outstanding} ${cur} due ${deadline.toUTCString().slice(0, 16)} cannot be paid in full today` +
        `${short ? ` (about ${money(short)} short on the cheapest route)` : ''}.`,
    );
  }

  if (includeExcluded && Array.isArray(cmp.excluded)) {
    for (const ex of cmp.excluded as Json[]) {
      const reason = lineForExclusion(ex.exclusions);
      if (reason) lines.push(`   – ${money(ex.provider)} excluded: ${reason}.`);
    }
  }

  return lines;
}

function buildStaged(staged: Json | undefined): string[] {
  if (!staged || !Array.isArray(staged.plans)) return [];
  const lines: string[] = [];
  for (const plan of staged.plans as Json[]) {
    if (plan.feasible === true && Array.isArray(plan.installments) && (plan.installments as unknown[]).length > 0) {
      lines.push(`A staged plan covers ${money(plan.description)}:`);
      for (const ins of plan.installments as Json[]) {
        const fund = ins.fundedBy ? ` after releasing “${money(ins.fundedBy)}”` : '';
        lines.push(
          `   ${ins.sequence}. Send ${money(ins.amount)} via ${money(ins.routeId)} (about ${money(ins.expectedDebit)}), ` +
            `dispatch ${new Date(money(ins.dispatchOnOrAfter)).toUTCString().slice(0, 16)}${fund}, posts ` +
            `${new Date(money(ins.expectedPostingAt)).toUTCString().slice(0, 16)}.`,
        );
      }
    }
  }
  return lines;
}

function buildRemittance(rem: Json | undefined): string[] {
  const list = rem?.remittances;
  if (!Array.isArray(list) || list.length === 0) return [];
  const lines: string[] = [];
  for (const r of list as Json[]) {
    if (r.status === 'AVAILABLE') continue;
    lines.push(
      `• Incoming ${money(r.amount)} ${money(r.currency)} from ${money(r.sender)} (${money(r.label)}) — status ` +
        `${money(r.status)}, clears ${new Date(money(r.expectedAvailableAt)).toUTCString().slice(0, 16)}. ` +
        (r.releasable ? 'Use “Receive incoming money” to credit it; it is not spendable until then.' :
          'It is not available yet and is not counted in your balance.'),
    );
  }
  return lines;
}

function buildCredit(edu: Json | undefined): string[] {
  if (!edu) return [];
  if (edu.supported === false) {
    return [`Credit education: ${money(edu.reason)} I will not guess eligibility from nationality or visa.`];
  }
  const lines = [`${money(edu.title)} (${money(edu.jurisdiction)}, ${edu.citationVerified ? 'reviewed source' : 'UNVERIFIED citation'}):`];
  for (const p of (edu.points as string[]) ?? []) lines.push(`• ${p}`);
  return lines;
}

function synthesize(messages: readonly ConversationMessage[], results: Map<string, Json>, user: string): string {
  const intent = classifyIntent(user);
  const snap = results.get('get_financial_snapshot');
  const options = results.get('review_payment_options');
  const remittance = results.get('review_inbound_remittances') ?? results.get('plan_staged_payments');
  const staged = results.get('plan_staged_payments');
  const edu = results.get('get_credit_education');

  const out: string[] = [];

  if (intent.credit) {
    out.push(...buildCredit(edu));
    out.push(
      '\nEducation is not eligibility. I cannot tell you whether you qualify for a product, and I never ask for ' +
        'passport, card or password details. Ask me about a specific reviewed topic (credit reports, correcting ' +
        'errors, responsible repayment, or starting without a history).',
    );
    return out.join('\n');
  }

  // Opening financial picture.
  if (snap && Array.isArray(snap.accounts)) {
    const balances = (snap.accounts as Json[])
      .map((a) => `${money(a.balance)} ${money(a.currency)} (${money(a.available)} available)`)
      .join('; ');
    out.push(`Your balances, each in its own currency: ${balances}.`);
  }

  if (options && Array.isArray(options.obligations)) {
    const focused = (options.obligations as Json[]).filter((o) => o.paid !== true);
    for (const o of focused) out.push(...buildBillSummary(o, true));
  }

  // Staged plan when a single payment is not feasible.
  const anyInfeasible =
    options && Array.isArray(options.obligations) &&
    (options.obligations as Json[]).some((o) => {
      const cmp = o.comparison as Json | undefined;
      return cmp && cmp.outcome === 'NO_FEASIBLE_PLAN';
    });
  if (anyInfeasible || intent.staged) out.push(...buildStaged(staged));

  out.push(...buildRemittance(remittance));

  // What the student should do next.
  const actionable: string[] = [];
  const remitList = (remittance?.remittances ?? staged?.remittances) as Json[] | undefined;
  if (Array.isArray(remitList) && remitList.some((r) => r.releasable === true)) {
    actionable.push('tap “Receive incoming money” to credit the family transfer');
  }
  if (options && Array.isArray(options.obligations)) {
    const recExists = (options.obligations as Json[]).some((o) => (o.comparison as Json)?.recommended);
    if (recExists) actionable.push('open the review screen and approve the exact terms yourself (I cannot approve or send anything)');
  }
  if (actionable.length > 0) {
    out.push(`Next: ${actionable.join('; then ')}.`);
  }

  out.push('(This is a simulation: no real money or providers, and all figures are quoted from the planning tools.)');
  return out.join('\n');
}

/* ----------------------------------------------------------------- adapter */

/** Plain-language summary of a live comparison, quoting only tool figures. */
function describeLive(r: Json): string {
  const best = r.best as Json | null;
  const ref = r.referenceRate as Json | undefined;
  if (!best) {
    const short = r.shortfall ? ` You are ${r.shortfall} short of paying it while keeping your reserve.` : '';
    return (
      `I checked ${r.providersChecked} real providers and none of them works for this bill.${short} ` +
      'I will not suggest using your living reserve; if you choose to, that is a separate decision.'
    );
  }
  const alts = (r.alternatives as Json[] | undefined) ?? [];
  const runnerUp = alts[0];
  const parts = [
    `Out of ${r.providersChecked} real providers, ${best.provider} is the cheapest one that can be relied on to arrive in time: you send ${best.youSend}, with a fee of ${best.fee} and ${best.marginPercent}% hidden in the exchange rate.`,
    `Afterwards you would have ${best.leftAfterwards} left.`,
  ];
  if (runnerUp) parts.push(`The next best is ${runnerUp.provider} at ${runnerUp.youSend}.`);
  if (r.arrivalCaveat) parts.push(String(r.arrivalCaveat));
  if (ref) parts.push(`Reference rate ${ref.mid} from ${ref.source}.`);
  parts.push('BridgeWise does not move money: you pay the provider yourself.');
  return parts.join(' ');
}

export function guidedAdapter(): ModelAdapter {
  return {
    mode: 'guided',
    modelName: 'guided-tools-1',
    async complete({ messages }) {
      // The most recent user message is the request.
      const userMsg = [...messages].reverse().find((m) => m.role === 'user' && !m.toolCallId);
      const user = userMsg?.content ?? '';
      const intent = classifyIntent(user);
      const results = collectResults(messages);

      // The student's own figures, when the form supplied them. With these the
      // guided agent can answer the real question against live provider quotes.
      const marker = 'STUDENT_FIGURES_JSON:';
      const at = user.indexOf(marker);
      let figures: Record<string, string> | null = null;
      if (at >= 0) {
        try {
          figures = JSON.parse(user.slice(at + marker.length).split('\n')[0] ?? '');
        } catch {
          figures = null;
        }
      }

      const live = results.get('compare_live_providers') as Json | undefined;
      if (figures && !live && !intent.credit) {
        return {
          text: null,
          toolCalls: [call('compare_live_providers', figures)],
          stopReason: 'tool_use',
        };
      }
      if (live) {
        return { text: describeLive(live), toolCalls: [], stopReason: 'end_turn' };
      }

      // Turn 1: gather the real data with id-free tools.
      if (results.size === 0) {
        const calls: ModelToolCall[] = [call('get_financial_snapshot')];
        if (!intent.credit) {
          calls.push(call('review_payment_options'));
          calls.push(call('review_inbound_remittances'));
          if (intent.staged || intent.prepare) calls.push(call('plan_staged_payments'));
        }
        if (intent.credit) {
          const topic = user.toLowerCase().includes('error')
            ? 'correcting_errors'
            : user.toLowerCase().includes('repay')
              ? 'responsible_repayment'
              : user.toLowerCase().includes('start') || user.toLowerCase().includes('history')
                ? 'starting_without_history'
                : 'credit_reports';
          calls.push(call('get_credit_education', { topic, jurisdiction: 'US' }));
        }
        return { text: null, toolCalls: calls, stopReason: 'tool_use' };
      }

      // Turn 2 (optional): if the user asked to prepare and a feasible route is
      // available, prepare the proposal — but never approve it.
      if (intent.prepare && !hasCall(messages, 'prepare_payment')) {
        const options = results.get('review_payment_options');
        const ready =
          options &&
          Array.isArray(options.obligations) &&
          (options.obligations as Json[]).some((o) => (o.comparison as Json)?.recommended);
        if (ready) {
          return { text: null, toolCalls: [call('prepare_payment')], stopReason: 'tool_use' };
        }
      }

      const proposal = results.get('prepare_payment');
      if (proposal) {
        return {
          text:
            `I have prepared a proposal for ${money(proposal.description)}: all-in ${money(proposal.totalDebit)} ` +
            `${money(proposal.sourceCurrency)}, expected to post ${new Date(money(proposal.expectedPostingAt)).toUTCString().slice(0, 16)}. ` +
            'It is not approved and nothing was sent. Please open the review screen and approve the exact terms yourself — ' +
            'I cannot do that for you.\n\n(This is a simulation; figures are quoted from the planning tools.)',
          toolCalls: [],
          stopReason: 'end_turn',
        };
      }

      return {
        text: synthesize(messages, results, user),
        toolCalls: [],
        stopReason: 'end_turn',
      };
    },
  };
}
