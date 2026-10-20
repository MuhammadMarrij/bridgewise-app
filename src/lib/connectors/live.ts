/**
 * Real provider integrations: Alipay (official open-platform SDK, sandbox
 * gateway by default) and Stripe (official SDK, test-mode keys).
 *
 * Both follow the same rule: the wallet is credited only after the PROVIDER
 * confirms the payment, by a server-side query (or a signature-verified Alipay
 * notification), exactly once per out_trade_no. A return URL or a client claim
 * of success is never trusted on its own.
 *
 * Nothing here runs until the keys are present in the environment.
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AlipaySdk } from 'alipay-sdk';
import Stripe from 'stripe';
import { externalPayments } from '../db/schema';
import { formatAmount, parseAmount, type Currency } from '../domain/money';
import { AppError } from '../services/errors';
import { appendAudit } from '../services/audit';
import { topUp } from '../services/money-ops';
import type { ResolvedSession } from '../services/workspace';

type Db = NodePgDatabase<Record<string, never>>;

const ALIPAY_SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

function alipayPrivateKey(): string | null {
  if (process.env.ALIPAY_PRIVATE_KEY) return process.env.ALIPAY_PRIVATE_KEY.replace(/\\n/g, '\n');
  const file = 'secrets/alipay_app_private.pem';
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function providerConfig() {
  return {
    alipay: !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PUBLIC_KEY && alipayPrivateKey()),
    alipaySandbox: (process.env.ALIPAY_GATEWAY ?? ALIPAY_SANDBOX_GATEWAY).includes('sandbox'),
    stripe: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY),
    stripeTestMode: (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_'),
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
  };
}

let alipayClient: AlipaySdk | null = null;
function alipay(): AlipaySdk {
  if (!providerConfig().alipay) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Alipay is not configured: add ALIPAY_APP_ID and ALIPAY_PUBLIC_KEY');
  alipayClient ??= new AlipaySdk({
    appId: process.env.ALIPAY_APP_ID!,
    privateKey: alipayPrivateKey()!,
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY!,
    gateway: process.env.ALIPAY_GATEWAY ?? ALIPAY_SANDBOX_GATEWAY,
    keyType: 'PKCS8',
  });
  return alipayClient;
}

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (!providerConfig().stripe) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Stripe is not configured: add STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY');
  stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY!);
  return stripeClient;
}

const tradeNo = () => `BW${Date.now()}${randomBytes(4).toString('hex')}`;

/** Credits the wallet once the provider has confirmed. Safe to call repeatedly. */
async function settle(db: Db, session: ResolvedSession, provider: 'alipay' | 'stripe', outTradeNo: string, providerRef: string, paidMinor: bigint) {
  const row = (await db.select().from(externalPayments).where(and(
    eq(externalPayments.provider, provider), eq(externalPayments.outTradeNo, outTradeNo), eq(externalPayments.sessionId, session.id),
  )))[0];
  if (!row) throw new AppError('NOT_FOUND', 'no such payment');
  if (paidMinor !== row.amountMinor) {
    await db.update(externalPayments).set({ status: 'FAILED', providerRef }).where(eq(externalPayments.id, row.id));
    throw new AppError('TERMS_CHANGED', 'the provider confirmed a different amount; nothing was credited');
  }
  const cur = row.currency as Currency;
  // The idempotency key IS the trade number, so a notify and a return page
  // racing each other still credit once.
  const out = await topUp(db, session, {
    currency: cur, amount: formatAmount(row.amountMinor, cur),
    source: `${provider === 'alipay' ? 'Alipay' : 'Card via Stripe'} · ${providerRef}`,
    idempotencyKey: `${provider}:${outTradeNo}`,
  });
  await db.update(externalPayments).set({ status: 'PAID', providerRef, settledAt: new Date() }).where(eq(externalPayments.id, row.id));
  return { ...out, status: 'PAID' as const };
}

/* ------------------------------------------------------------------ Alipay */

export async function createAlipayTopUp(db: Db, session: ResolvedSession, amount: string, origin: string) {
  const minor = parseAmount(amount, 'CNY');
  if (minor <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  const outTradeNo = tradeNo();
  await db.insert(externalPayments).values({ sessionId: session.id, provider: 'alipay', outTradeNo, currency: 'CNY', amountMinor: minor });
  const url = alipay().pageExecute('alipay.trade.page.pay', 'GET', {
    bizContent: {
      out_trade_no: outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: formatAmount(minor, 'CNY'),
      subject: 'BridgeWise wallet top-up',
    },
    returnUrl: `${origin}/?pay=alipay&trade=${outTradeNo}`,
    notifyUrl: `${origin}/api/pay/alipay/notify`,
  });
  await appendAudit(db, { sessionId: session.id, correlationId: outTradeNo, type: 'alipay.created', actor: 'user', outcome: 'allowed', payload: { amount } });
  return { outTradeNo, payUrl: url };
}

/** Asks Alipay what happened. Credits only on TRADE_SUCCESS / TRADE_FINISHED. */
export async function confirmAlipay(db: Db, session: ResolvedSession, outTradeNo: string) {
  const res = (await alipay().exec('alipay.trade.query', { bizContent: { out_trade_no: outTradeNo } })) as Record<string, string>;
  const status = res.tradeStatus;
  if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
    return { status: status ?? res.subCode ?? 'NOT_PAID', credited: false };
  }
  const out = await settle(db, session, 'alipay', outTradeNo, res.tradeNo ?? outTradeNo, parseAmount(res.totalAmount ?? '0', 'CNY'));
  return { ...out, credited: true };
}

/** Alipay's asynchronous notification. Signature verified before anything is read. */
export async function alipayNotify(db: Db, form: Record<string, string>, sessionFor: (sessionId: string) => Promise<ResolvedSession>) {
  if (!alipay().checkNotifySign(form)) throw new AppError('VALIDATION_FAILED', 'bad signature');
  if (form.app_id !== process.env.ALIPAY_APP_ID) throw new AppError('VALIDATION_FAILED', 'wrong app');
  if (form.trade_status !== 'TRADE_SUCCESS' && form.trade_status !== 'TRADE_FINISHED') return;
  const row = (await db.select().from(externalPayments).where(and(eq(externalPayments.provider, 'alipay'), eq(externalPayments.outTradeNo, form.out_trade_no ?? ''))))[0];
  if (!row) return;
  await settle(db, await sessionFor(row.sessionId), 'alipay', row.outTradeNo, form.trade_no ?? row.outTradeNo, parseAmount(form.total_amount ?? '0', 'CNY'));
}

/* ------------------------------------------------------------------ Stripe */

export async function createStripeTopUp(db: Db, session: ResolvedSession, amount: string, currency: Currency) {
  const minor = parseAmount(amount, currency);
  if (minor <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  const outTradeNo = tradeNo();
  await db.insert(externalPayments).values({ sessionId: session.id, provider: 'stripe', outTradeNo, currency, amountMinor: minor });
  const pi = await stripe().paymentIntents.create(
    {
      amount: Number(minor),
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      description: 'BridgeWise wallet top-up',
      metadata: { outTradeNo, sessionId: session.id },
    },
    { idempotencyKey: outTradeNo },
  );
  await db.update(externalPayments).set({ providerRef: pi.id }).where(and(eq(externalPayments.provider, 'stripe'), eq(externalPayments.outTradeNo, outTradeNo)));
  return { outTradeNo, clientSecret: pi.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY };
}

/** Retrieves the PaymentIntent from Stripe; credits only if Stripe says it succeeded. */
export async function confirmStripe(db: Db, session: ResolvedSession, outTradeNo: string) {
  const row = (await db.select().from(externalPayments).where(and(
    eq(externalPayments.provider, 'stripe'), eq(externalPayments.outTradeNo, outTradeNo), eq(externalPayments.sessionId, session.id),
  )))[0];
  if (!row) throw new AppError('NOT_FOUND', 'no such payment');
  if (!row.providerRef) return { status: 'NOT_FOUND', credited: false };
  // Retrieve by id: Stripe's search index lags, retrieval does not.
  const pi = await stripe().paymentIntents.retrieve(row.providerRef);
  if (pi.metadata?.outTradeNo !== outTradeNo) throw new AppError('TERMS_CHANGED', 'payment does not match this top-up');
  if (pi.status !== 'succeeded') return { status: pi.status, credited: false };
  const out = await settle(db, session, 'stripe', outTradeNo, pi.id, BigInt(pi.amount_received));
  return { ...out, credited: true };
}
