/**
 * Funding connectors: the boundary between BridgeWise's ledger and the outside
 * payment world — bank cards, Alipay, WeChat Pay and bank accounts.
 *
 * Every connector has the same three operations:
 *   link  — verify and tokenise the source; returns what we may store
 *   pull  — take money FROM the source into the wallet (a top-up)
 *   push  — send money from the wallet TO the source (a withdrawal)
 *
 * Mode is explicit. `sandbox` connectors validate exactly as production would
 * and simulate the provider's answer, including declines; `live` connectors call
 * the provider and require the merchant agreement and credentials each provider
 * issues (Alipay Open Platform, WeChat Pay merchant ID, CCB/ICBC open banking,
 * a card acquirer). Live mode with no credentials refuses rather than pretending.
 *
 * Card rule, non-negotiable: the full card number and the security code are used
 * to validate and tokenise, then dropped. Only the token, the brand and the last
 * four digits are ever returned for storage.
 */
import { createHmac } from 'node:crypto';

export type SourceKind = 'card' | 'wallet' | 'bank';

export interface LinkResult {
  readonly token: string;
  readonly label: string;
  readonly last4: string | null;
  readonly brand: string | null;
  readonly currency: string;
  readonly holder: string | null;
  readonly expiry: string | null;
}

export interface MovementResult {
  readonly ok: boolean;
  readonly reference: string;
  readonly declineReason?: string;
}

export class ConnectorError extends Error {
  constructor(readonly code: 'INVALID' | 'DECLINED' | 'NOT_CONFIGURED' | 'UNSUPPORTED', message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export const CONNECTOR_MODE = (process.env.CONNECTOR_MODE ?? 'sandbox') as 'sandbox' | 'live';

const SECRET = process.env.SESSION_SECRET ?? 'dev-only-token-secret';
const tokenFor = (kind: string, identity: string) =>
  `tok_${kind}_${createHmac('sha256', SECRET).update(`${kind}:${identity}`).digest('hex').slice(0, 24)}`;
const ref = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function requireSandbox(provider: string) {
  if (CONNECTOR_MODE === 'live') {
    throw new ConnectorError('NOT_CONFIGURED', `${provider} live connector needs merchant credentials; none are configured`);
  }
}

/* ------------------------------------------------------------------- cards */

export function luhnValid(pan: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = pan.length - 1; i >= 0; i -= 1) {
    let d = pan.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return pan.length > 0 && sum % 10 === 0;
}

export function cardBrand(pan: string): string | null {
  if (/^4\d{12}(\d{3}){0,2}$/.test(pan)) return 'visa';
  if (/^(5[1-5]\d{14}|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)\d{12})$/.test(pan)) return 'mastercard';
  if (/^62\d{14,17}$/.test(pan)) return 'unionpay';
  if (/^3[47]\d{13}$/.test(pan)) return 'amex';
  if (/^35(2[89]|[3-8]\d)\d{12,15}$/.test(pan)) return 'jcb';
  return null;
}

const BRAND_NAME: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', unionpay: 'UnionPay', amex: 'Amex', jcb: 'JCB' };

/** Published test numbers that a sandbox treats as declining, like real acquirers' sandboxes. */
const DECLINE_TEST_CARDS = new Set(['4000000000000002', '4000000000009995']);

export function linkCard(input: { number: string; expiry: string; cvc: string; holder: string; currency: string }): LinkResult {
  const pan = input.number.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(pan)) throw new ConnectorError('INVALID', 'card number must be 13 to 19 digits');
  if (!luhnValid(pan)) throw new ConnectorError('INVALID', 'that card number is not valid — check the digits');
  const brand = cardBrand(pan);
  if (!brand) throw new ConnectorError('UNSUPPORTED', 'we accept Visa, Mastercard, UnionPay, Amex and JCB');
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(input.expiry.trim());
  if (!m) throw new ConnectorError('INVALID', 'expiry must be MM/YY');
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) throw new ConnectorError('INVALID', 'expiry month must be 01 to 12');
  const now = new Date();
  if (year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)) {
    throw new ConnectorError('INVALID', 'that card has expired');
  }
  if (!/^\d{3,4}$/.test(input.cvc) || (brand === 'amex') !== (input.cvc.length === 4)) {
    throw new ConnectorError('INVALID', brand === 'amex' ? 'Amex security codes are 4 digits' : 'security code must be 3 digits');
  }
  requireSandbox(brand);
  // From here on, the PAN and CVC are gone. Only the token and safe display data leave.
  return {
    token: tokenFor('card', pan),
    label: `${BRAND_NAME[brand] ?? brand} ••${pan.slice(-4)}`,
    last4: pan.slice(-4),
    brand,
    currency: input.currency,
    holder: input.holder.trim().slice(0, 60) || null,
    expiry: `${m[1]}/${m[2]}`,
  };
}

/* --------------------------------------------------------- mobile wallets */

export const WALLET_PROVIDERS = {
  alipay: { name: 'Alipay', currency: 'CNY' },
  wechatpay: { name: 'WeChat Pay', currency: 'CNY' },
} as const;

export function linkWallet(input: { provider: keyof typeof WALLET_PROVIDERS; account: string; holder: string }): LinkResult {
  const p = WALLET_PROVIDERS[input.provider];
  if (!p) throw new ConnectorError('UNSUPPORTED', 'unsupported wallet');
  const acct = input.account.trim();
  // Alipay accounts are a mainland mobile number or an email; WeChat Pay binds a mobile number.
  const phone = /^(\+?86)?1[3-9]\d{9}$/.test(acct.replace(/[\s-]/g, ''));
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acct);
  if (!phone && !(input.provider === 'alipay' && email)) {
    throw new ConnectorError('INVALID', input.provider === 'alipay'
      ? 'enter the mobile number or email on your Alipay account'
      : 'enter the mobile number bound to your WeChat Pay');
  }
  requireSandbox(p.name);
  const digits = acct.replace(/\D/g, '');
  const masked = phone ? `••${digits.slice(-4)}` : `${acct[0]}•••@${acct.split('@')[1]}`;
  return {
    token: tokenFor(input.provider, acct.toLowerCase()),
    label: `${p.name} ${masked}`,
    last4: phone ? digits.slice(-4) : null,
    brand: input.provider,
    currency: p.currency,
    holder: input.holder.trim().slice(0, 60) || null,
    expiry: null,
  };
}

/* ------------------------------------------------------------------- banks */

export const BANKS = {
  ccb: { name: 'China Construction Bank', short: 'CCB', currency: 'CNY' },
  icbc: { name: 'Industrial and Commercial Bank of China', short: 'ICBC', currency: 'CNY' },
  boc: { name: 'Bank of China', short: 'BOC', currency: 'CNY' },
  abc: { name: 'Agricultural Bank of China', short: 'ABC', currency: 'CNY' },
  cmb: { name: 'China Merchants Bank', short: 'CMB', currency: 'CNY' },
  hsbc_uk: { name: 'HSBC UK', short: 'HSBC', currency: 'GBP' },
  barclays: { name: 'Barclays', short: 'Barclays', currency: 'GBP' },
  hbl: { name: 'Habib Bank Limited', short: 'HBL', currency: 'PKR' },
  meezan: { name: 'Meezan Bank', short: 'Meezan', currency: 'PKR' },
  chase: { name: 'Chase', short: 'Chase', currency: 'USD' },
} as const;
export type BankId = keyof typeof BANKS;

export function linkBank(input: { bank: BankId; account: string; holder: string }): LinkResult {
  const b = BANKS[input.bank];
  if (!b) throw new ConnectorError('UNSUPPORTED', 'unsupported bank');
  const acct = input.account.replace(/[\s-]/g, '').toUpperCase();
  if (b.currency === 'CNY') {
    // Mainland debit cards are 16–19 digit UnionPay numbers with a Luhn check.
    if (!/^\d{16,19}$/.test(acct) || !luhnValid(acct)) {
      throw new ConnectorError('INVALID', `enter the 16–19 digit ${b.short} debit card number`);
    }
  } else if (b.currency === 'GBP') {
    if (!/^(\d{6}\d{8}|GB\d{2}[A-Z]{4}\d{14})$/.test(acct)) {
      throw new ConnectorError('INVALID', 'enter sort code + account number (14 digits) or a GB IBAN');
    }
  } else if (b.currency === 'PKR') {
    if (!/^(PK\d{2}[A-Z]{4}\d{16}|\d{10,16})$/.test(acct)) throw new ConnectorError('INVALID', 'enter a PK IBAN or account number');
  } else if (!/^\d{8,17}$/.test(acct)) {
    throw new ConnectorError('INVALID', 'enter the account number');
  }
  if (!input.holder.trim()) throw new ConnectorError('INVALID', 'enter the account holder name');
  requireSandbox(b.short);
  return {
    token: tokenFor(input.bank, acct),
    label: `${b.short} ••${acct.slice(-4)}`,
    last4: acct.slice(-4).replace(/\D/g, '0'),
    brand: input.bank,
    currency: b.currency,
    holder: input.holder.trim().slice(0, 60),
    expiry: null,
  };
}

/* --------------------------------------------------------------- movements */

export function pull(kind: SourceKind, token: string, last4: string | null, _amountMinor: bigint): MovementResult {
  requireSandbox(kind);
  // A sandbox decline is triggered by the published decline test cards, whose
  // tokens we cannot recompute here, so the decline rule keys on last4.
  if (kind === 'card' && last4 && ['0002', '9995'].includes(last4) && DECLINE_TEST_CARDS.size) {
    return { ok: false, reference: ref('dcl'), declineReason: 'card declined by issuer (insufficient funds)' };
  }
  void token;
  return { ok: true, reference: ref(kind === 'card' ? 'ch' : kind === 'wallet' ? 'wpay' : 'dd') };
}

export function push(kind: SourceKind, _token: string, _amountMinor: bigint): MovementResult {
  requireSandbox(kind);
  if (kind === 'card') throw new ConnectorError('UNSUPPORTED', 'withdrawals go to a bank account or mobile wallet, not a card');
  return { ok: true, reference: ref('po') };
}
