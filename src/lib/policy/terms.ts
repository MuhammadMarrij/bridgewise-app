/**
 * Canonical terms and their hash.
 *
 * The hash binds consent to an EXACT transaction. Change any material term — the
 * beneficiary, the amount, a fee, the rate, the deadline, the reserve, the source
 * account, the environment — and the hash changes, which voids the approval.
 *
 * A hash is an integrity binding, not a signature and not an authorisation
 * credential. It proves the terms did not drift between review and execution.
 * It does not prove who approved them: that is the session plus the one-use nonce.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface CanonicalTerms {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly planKind: 'tuition_remittance';
  readonly obligationId: string;
  readonly obligationVersion: number;
  readonly beneficiaryId: string;
  readonly beneficiaryVersion: number;
  readonly beneficiaryReference: string;
  readonly sourceAccountId: string;
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  /** Decimal strings, so the hashed form is exactly what the user was shown. */
  readonly targetAmount: string;
  readonly principalAmount: string;
  readonly feeAmount: string;
  readonly totalDebitAmount: string;
  readonly rate: string;
  readonly routeId: string;
  readonly providerLabel: string;
  readonly quoteId: string;
  readonly quoteExpiresAt: string;
  readonly expectedDeliveryAt: string;
  readonly expectedPostingAt: string;
  readonly deadlineAt: string;
  readonly reserveAmount: string;
  readonly projectedLowAmount: string;
  readonly executionMode: string;
  readonly policyVersion: string;
}

export const POLICY_VERSION = 'policy-1';

/**
 * Stable serialisation: keys sorted, no whitespace, no floats anywhere. Two
 * processes on two machines must produce byte-identical output for equal terms.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error('a non-integer number must not appear in canonical terms');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize a value of type ${typeof value}`);
}

export function hashTerms(terms: CanonicalTerms): string {
  return createHash('sha256').update(canonicalize(terms)).digest('hex');
}

/** A high-entropy, one-use approval nonce. Only its hash is ever stored. */
export function mintNonce(): { nonce: string; nonceHash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, nonceHash: hashSecret(nonce) };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison, so a hash check cannot be probed byte by byte. */
export function secretMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hash of a confirmation request body, so a reused key with changed terms conflicts. */
export function hashRequest(parts: Record<string, string>): string {
  return createHash('sha256').update(canonicalize(parts)).digest('hex');
}
