/**
 * Building credit in China as a foreign student.
 *
 * China has three systems a student meets:
 *   - the PBOC Credit Reference Center (征信), the official credit report built
 *     from bank cards and loans;
 *   - Sesame Credit (芝麻信用) inside Alipay;
 *   - WeChat Pay Score (微信支付分) inside WeChat.
 *
 * BridgeWise cannot read any of those scores and never claims to. What it can do
 * is give the student a plan, detect the steps it can see in its own data
 * (a Chinese bank card linked, Alipay and WeChat Pay linked, bills paid on time,
 * money kept in reserve), and keep a readiness measure that is labelled as OURS.
 * Eligibility rules change and differ by bank and city: every step says to check
 * the current rule with the provider rather than stating it as fact.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { creditProgress, linkedSources, obligations, walletTransactions } from '../db/schema';
import { listBudgets, spendingSummary } from './money-ops';
import type { ResolvedSession } from './workspace';
import type { Currency } from '../domain/money';

type Db = NodePgDatabase<Record<string, never>>;

const CN_BANKS = ['ccb', 'icbc', 'boc', 'abc', 'cmb'];

export interface CreditStep {
  readonly id: string;
  readonly system: '征信 PBOC' | '芝麻信用 Sesame' | '微信支付分 WeChat Pay Score' | 'Foundations';
  readonly title: string;
  readonly why: string;
  readonly how: string;
  readonly done: boolean;
  /** 'auto' = BridgeWise saw it in your data; 'you' = you marked it; null = not done. */
  readonly detectedBy: 'auto' | 'you' | null;
  readonly weight: number;
}

export async function creditPlan(db: Db, session: ResolvedSession, study: Currency) {
  const linked = await db.select().from(linkedSources)
    .where(and(eq(linkedSources.sessionId, session.id), eq(linkedSources.status, 'ACTIVE')));
  const marked = new Set((await db.select().from(creditProgress).where(eq(creditProgress.sessionId, session.id))).map((r) => r.stepId));

  const paidBills = await db.select().from(obligations)
    .where(and(eq(obligations.sessionId, session.id), isNotNull(obligations.paidAt)));
  const onTime = paidBills.filter((b) => b.paidAt! <= b.deadlineAt).length;
  const late = paidBills.length - onTime;
  const billSpends = (await db.select().from(walletTransactions)
    .where(and(eq(walletTransactions.sessionId, session.id), eq(walletTransactions.category, 'bills')))).length;

  const budgets = await listBudgets(db, session.id);
  const summary = await spendingSummary(db, session.id, study, 30).catch(() => null);

  const has = (p: string) => linked.some((l) => l.provider === p);
  const cnBank = linked.find((l) => CN_BANKS.includes(l.provider));

  const step = (s: Omit<CreditStep, 'done' | 'detectedBy'>, auto: boolean): CreditStep => ({
    ...s,
    done: auto || marked.has(s.id),
    detectedBy: auto ? 'auto' : marked.has(s.id) ? 'you' : null,
  });

  const steps: CreditStep[] = [
    step({
      id: 'cn-bank', system: '征信 PBOC', weight: 20,
      title: 'Open a Chinese bank account and link its debit card',
      why: 'Your official credit file (征信) is built from accounts at Chinese banks. Without one there is nothing to report.',
      how: 'Visit CCB, BOC, ICBC, ABC or CMB with your passport, residence permit and student ID. Requirements differ by branch — ask the branch. Then link the card in Cards & accounts.',
    }, !!cnBank),
    step({
      id: 'alipay-realname', system: '芝麻信用 Sesame', weight: 15,
      title: 'Link Alipay and complete real-name verification (实名认证) with your passport',
      why: 'Sesame Credit only scores real-name verified accounts. A score unlocks deposit-free bikes, power banks and some rentals.',
      how: 'Alipay → 我的 → 设置 → 账户与安全 → 实名认证. Foreign passports are accepted; follow the in-app steps. Link Alipay here so BridgeWise can track it.',
    }, has('alipay')),
    step({
      id: 'wechat-realname', system: '微信支付分 WeChat Pay Score', weight: 10,
      title: 'Link WeChat Pay with real-name verification',
      why: 'WeChat Pay Score (支付分) needs a verified account and builds from using services and paying on time.',
      how: 'WeChat → 我 → 服务 → 钱包 → 身份信息. Then link WeChat Pay in Cards & accounts.',
    }, has('wechatpay')),
    step({
      id: 'on-time', system: 'Foundations', weight: 25,
      title: 'Build a record of paying bills on time',
      why: 'Every system rewards the same thing most: obligations paid by their due date, every time.',
      how: onTime > 0
        ? `${onTime} bill${onTime > 1 ? 's' : ''} paid on time through BridgeWise${late ? `, ${late} late` : ''}. Keep going — let the assistant schedule each one before its deadline.`
        : 'Pay tuition, phone and utilities through BridgeWise or Alipay before the due date. Paste an invoice into the assistant and it will set up the payment.',
    }, onTime >= 1 && late === 0 || billSpends >= 3),
    step({
      id: 'budget', system: 'Foundations', weight: 10,
      title: 'Stay within your monthly budgets',
      why: 'Lenders look at whether you live within your means. Overspending is the habit that turns into missed payments.',
      how: budgets.length ? (budgets.some((b) => b.over) ? 'You are over budget this month — ask the assistant where to cut back.' : 'You are within every budget this month.') : 'Set a budget for food and transport in Budget.',
    }, budgets.length > 0 && !budgets.some((b) => b.over)),
    step({
      id: 'reserve', system: 'Foundations', weight: 10,
      title: 'Keep at least two months of living costs in reserve',
      why: 'A buffer is what keeps one late transfer from home from becoming a missed payment.',
      how: summary?.runwayDays != null ? `At your current pace your money lasts about ${summary.runwayDays} days.` : 'Record your spending so BridgeWise can tell you how long your money lasts.',
    }, (summary?.runwayDays ?? 0) >= 60),
    step({
      id: 'pboc-report', system: '征信 PBOC', weight: 5,
      title: 'Check your PBOC credit report once a year',
      why: 'Errors happen. Checking is how you find them before a landlord or bank does.',
      how: 'The Credit Reference Center (征信中心) offers free personal report enquiries through its website and many bank apps; availability for foreign passports varies — check with your bank. Mark this done when you have checked.',
    }, false),
    step({
      id: 'credit-card', system: '征信 PBOC', weight: 5,
      title: 'After a few months of history, ask your bank about a student or secured credit card',
      why: 'A credit card used lightly and repaid in full every month is the main way a 征信 record grows.',
      how: 'Eligibility for foreign students depends on the bank, your residence permit length and your account history. Ask the bank that holds your account. Never carry a balance you cannot repay in full.',
    }, false),
  ];

  const total = steps.reduce((a, s) => a + s.weight, 0);
  const got = steps.filter((s) => s.done).reduce((a, s) => a + s.weight, 0);
  const next = steps.find((s) => !s.done) ?? null;
  return {
    readiness: Math.round((got / total) * 100),
    readinessNote: 'BridgeWise credit-readiness: our own measure of the habits each system rewards. It is not your 征信, Sesame or WeChat Pay Score.',
    steps,
    next,
    onTimePayments: onTime,
    latePayments: late,
  };
}

const MANUAL = new Set(['alipay-realname', 'wechat-realname', 'pboc-report', 'credit-card', 'cn-bank']);

export async function markCreditStep(db: Db, session: ResolvedSession, stepId: string, done: boolean) {
  if (!MANUAL.has(stepId)) return;
  if (done) {
    await db.insert(creditProgress).values({ sessionId: session.id, stepId }).onConflictDoNothing();
  } else {
    await db.delete(creditProgress).where(and(eq(creditProgress.sessionId, session.id), eq(creditProgress.stepId, stepId)));
  }
}
