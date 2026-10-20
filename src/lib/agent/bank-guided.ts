/**
 * Guided mode for the BridgeWise assistant.
 *
 * A deterministic planner that drives the SAME bank tools the live model uses,
 * for when no model is reachable. It is not a language model and is labelled
 * "guided" wherever it appears. It understands a narrow set of requests —
 * balances, rates, conversions, alerts, provider comparison — and quotes only
 * what the tools return.
 */
import type { ConversationMessage, ModelAdapter, ModelToolCall, ModelTurn } from './adapter';

type Json = Record<string, any>;

const CODES: Record<string, string> = {
  pound: 'GBP', pounds: 'GBP', gbp: 'GBP', sterling: 'GBP',
  dollar: 'USD', dollars: 'USD', usd: 'USD',
  yuan: 'CNY', rmb: 'CNY', renminbi: 'CNY', cny: 'CNY',
  rupee: 'PKR', rupees: 'PKR', pkr: 'PKR', inr: 'INR',
  euro: 'EUR', euros: 'EUR', eur: 'EUR',
};

function currenciesIn(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const c = CODES[w];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function amountIn(text: string): string | null {
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)\s*(k)?\b/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

function results(messages: readonly ConversationMessage[]): Map<string, Json> {
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
  const out = new Map<string, Json>();
  for (const m of messages) {
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const name = names.get(m.toolCallId);
    if (name) {
      try { out.set(name, JSON.parse(m.content)); } catch { /* ignore */ }
    }
  }
  return out;
}

const call = (name: string, args: unknown = {}): ModelToolCall => ({ id: `g-${name}-${Math.random().toString(36).slice(2, 7)}`, name, args });
const use = (...calls: ModelToolCall[]): ModelTurn => ({ text: null, toolCalls: calls, stopReason: 'tool_use' });
const say = (text: string): ModelTurn => ({ text, toolCalls: [], stopReason: 'end_turn' });

function briefing(o: Json): string {
  if (o.error) return `I couldn't read your accounts: ${o.message ?? o.error}.`;
  const pockets = (o.pockets as Json[]).map((p) => `${p.balance} ${p.currency}`).join(', ');
  const parts = [`You hold ${pockets}${o.totalInStudyCurrency ? ` — about ${o.totalInStudyCurrency} ${o.studyCurrency} in total at today's rates` : ''}.`];
  const due = (o.bills as Json[]).filter((b) => b.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft)[0];
  if (due) parts.push(`${due.description} of ${due.amount} ${due.currency} is due in ${due.daysLeft} days.`);
  if ((o.awaitingApproval as Json[]).length) parts.push(`${o.awaitingApproval.length} action(s) are waiting for your approval.`);
  parts.push('Ask me to convert money, check a rate, set an alert, or compare ways to send money.');
  return parts.join(' ');
}

export function bankGuidedAdapter(): ModelAdapter {
  return {
    mode: 'guided' as never,
    modelName: 'bridgewise-guided-1',
    async complete({ messages }) {
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const t = user.toLowerCase();
      const got = results(messages);
      const cur = currenciesIn(user);
      const amount = amountIn(user);

      // Every request starts from the student's real position.
      if (!got.has('get_overview')) return use(call('get_overview'));
      const o = got.get('get_overview')!;
      const home = o.homeCurrency ?? 'USD';
      const study = o.studyCurrency ?? 'GBP';

      // A pasted invoice: read it with the parser, save it, prepare the payment.
      const looksLikeInvoice = /invoice|amount due|balance due|tuition fee|student (id|number)/i.test(user) && user.length > 60;
      if (looksLikeInvoice) {
        if (!got.has('read_invoice')) return use(call('read_invoice', { text: user }));
        const inv = got.get('read_invoice')!;
        if (inv.missing?.length) {
          return say(`I read the invoice but could not find: ${inv.missing.join(', ')}. ` +
            `I did find ${['amount','currency','dueDate','reference','payee'].filter((k) => inv[k]).map((k) => `${k} ${inv[k]}`).join(', ')}. Tell me the rest and I'll set it up.`);
        }
        if (!got.has('add_bill')) {
          return use(call('add_bill', {
            description: 'Tuition', amount: inv.amount, currency: inv.currency, payee: inv.payee,
            reference: inv.reference, dueDate: inv.dueDate,
          }));
        }
        const bill = got.get('add_bill')!;
        if (bill.error) return say(`I couldn't save that bill: ${bill.message}.`);
        if (!got.has('propose_bill_payment')) return use(call('propose_bill_payment', { billId: bill.billId }));
        const p = got.get('propose_bill_payment')!;
        if (p.error) return say(`I saved the bill (${inv.amount} ${inv.currency} to ${inv.payee}, due ${inv.dueDate}) but can't pay it yet: ${p.message}.`);
        return say(`I read your invoice: ${inv.amount} ${inv.currency} to ${inv.payee}, reference ${inv.reference}, due ${inv.dueDate}. Paying it would cost ${p.costs}${p.rate ? ` at ${p.rate} (mid ${p.midMarketRate})` : ''}, leaving ${p.leftInPocketAfter}. Review the card — nothing is paid until you approve.`);
      }

      // "Pay my tuition" with a saved, unpaid bill.
      const unpaid = (o.bills as Json[]).filter((b) => !b.paid).sort((a, b) => a.daysLeft - b.daysLeft)[0];
      if (/pay/.test(t) && unpaid && !/compare|cheapest|provider/.test(t)) {
        if (!got.has('propose_bill_payment')) {
          return use(call('propose_bill_payment', { billId: unpaid.id, ...(cur[0] ? { fromCurrency: cur[0] } : {}) }));
        }
        const p = got.get('propose_bill_payment')!;
        if (p.error) return say(`I can't pay ${unpaid.description} yet: ${p.message}.`);
        return say(`Ready to pay ${unpaid.description} (${unpaid.amount} ${unpaid.currency}, due in ${unpaid.daysLeft} days): it costs ${p.costs}, leaving ${p.leftInPocketAfter}. Approve the card to send it.`);
      }

      // "Convert 5000 CNY to GBP", "change 2k yuan into pounds".
      if (/\b(convert|change|exchange|swap|move)\b/.test(t) && amount) {
        if (!got.has('propose_conversion')) {
          const from = cur[0] ?? home;
          const to = cur[1] ?? (from === study ? home : study);
          return use(call('propose_conversion', { from, to, sellAmount: amount }));
        }
        const p = got.get('propose_conversion')!;
        if (p.error) return say(`I couldn't prepare that: ${p.message}.`);
        return say(`I've prepared it: you sell ${p.youSell} and get ${p.youGet} at ${p.rate} (mid-market ${p.midMarketRate}; our fee ${p.ourFee}). Review and approve the card — nothing moves until you do. The quote expires in 10 minutes.`);
      }

      // "Tell me when CNY/GBP goes above 0.11".
      if (/\b(alert|notify|tell me when|let me know)\b/.test(t)) {
        const level = user.match(/(\d+\.\d+)/)?.[1];
        if (!level) return say('What rate should I watch for? For example: "alert me when CNY/GBP goes above 0.1050".');
        if (!got.has('set_rate_alert')) {
          return use(call('set_rate_alert', {
            base: cur[0] ?? home, quote: cur[1] ?? study,
            direction: /below|under|drops|falls/.test(t) ? 'below' : 'above', threshold: level,
          }));
        }
        const a = got.get('set_rate_alert')!;
        return say(`Done — I'm watching ${a.watching}. It's at ${a.currentRate} now, ${a.distancePercent}% away.`);
      }

      // "How's the rate", "GBP vs CNY this month".
      if (/\b(rate|fx|exchange rate|trend|history)\b/.test(t)) {
        if (!got.has('get_fx')) return use(call('get_fx', { base: cur[0] ?? home, quote: cur[1] ?? study, days: 30 }));
        const f = got.get('get_fx')!;
        if (f.error) return say(`I couldn't fetch that rate: ${f.message}.`);
        const h = f.history;
        return say(
          `${f.pair} is ${f.live.rate} right now (${f.live.source}).` +
            (h ? ` Over 30 days it moved ${h.changePercent}%${h.change7dPercent ? `, ${h.change7dPercent}% in the last week` : ''}; the high was ${h.high.rate} on ${h.high.date} and the low ${h.low.rate} on ${h.low.date}.` : '') +
            ' That is history, not a forecast.',
        );
      }

      // "Cheapest way to send 8000 USD", "pay my tuition".
      if (/\b(send|compare|cheapest|provider|transfer|remit|pay|tuition)\b/.test(t)) {
        const bill = (o.bills as Json[])[0];
        const targetAmount = amount ?? bill?.amount;
        const targetCurrency = cur.find((c) => c !== home) ?? bill?.currency ?? study;
        const source = (o.pockets as Json[]).find((p) => p.currency === home) ?? (o.pockets as Json[])[0];
        if (!targetAmount) return say('How much needs to arrive, and in which currency?');
        if (!source) return say('Open a pocket first so I know what you are paying from.');
        if (!got.has('compare_live_providers')) {
          const due = bill?.dueAt ? new Date(bill.dueAt) : new Date(Date.now() + 21 * 86_400_000);
          return use(call('compare_live_providers', {
            targetAmount, targetCurrency, sourceCurrency: source.currency === targetCurrency ? home : source.currency,
            balance: source.balance, reserve: '0.00',
            deadlineDate: due.toISOString().slice(0, 10), deadlineTime: '17:00', deadlineTimezone: 'UTC',
          }));
        }
        const c = got.get('compare_live_providers')!;
        if (c.error || !c.best) return say(c.message ?? `None of the ${c.providersChecked ?? ''} providers works for that.`);
        const alt = c.alternatives?.[0];
        return say(
          `Of ${c.providersChecked} real providers, ${c.best.provider} is cheapest for this: you'd send ${c.best.youSend} (fee ${c.best.fee}, ${c.best.marginPercent}% in the rate).` +
            (alt ? ` Next is ${alt.provider} at ${alt.youSend}.` : '') +
            (c.arrivalCaveat ? ` ${c.arrivalCaveat}` : ''),
        );
      }

      return say(briefing(o));
    },
  };
}
