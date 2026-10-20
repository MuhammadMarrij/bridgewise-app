/**
 * Append-only, tamper-EVIDENT audit.
 *
 * Each event stores the hash of the previous one (a hash chain) and its own
 * hash. A single altered row breaks the chain and {@link verifyAuditChain}
 * detects it. This is honest about its limit: it is not tamper-proof against a
 * database administrator who rewrites the whole chain, and it is not an external
 * write-only log. It makes silent edits detectable, which is what the security
 * report promises.
 */
import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../db/schema';

type Db = NodePgDatabase<Record<string, never>>;

export interface AuditInput {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly type: string;
  readonly actor: 'user' | 'system' | 'model';
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly reason?: string | null;
  /** Safe structured evidence only: ids, amounts, codes. Never secrets or personal data. */
  readonly payload: Record<string, unknown>;
}

const FORBIDDEN_KEYS = /^(token|nonce|secret|password|apikey|api_key|cookie|authorization)$/i;
export const GENESIS_HASH = 'GENESIS';

/** Strips anything that must never be written to evidence, at depth. */
export function redact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEYS.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>);
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Deterministic JSON with sorted object keys, so the hash never depends on insertion order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/** The exact hash for one event; verifier and writer must agree on this formula. */
export function hashAuditEntry(input: {
  prevHash: string;
  seq: number;
  correlationId: string;
  type: string;
  actor: string;
  outcome: string;
  reason: string | null;
  payload: Record<string, unknown>;
}): string {
  const material = [
    input.prevHash,
    input.seq,
    input.correlationId,
    input.type,
    input.actor,
    input.outcome,
    input.reason ?? '',
    canonicalize(input.payload),
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Appends an event and extends the chain. The session row is locked for the
 * duration so two concurrent writers cannot both extend from the same head;
 * the unique (session, seq) index is the final guard.
 */
export async function appendAudit(db: Db, input: AuditInput): Promise<void> {
  const safePayload = redact(input.payload);
  await db.transaction(async (tx) => {
    // Serialise chain extension for this session by taking a row lock.
    await tx.execute(sql`SELECT id FROM sessions WHERE id = ${input.sessionId}::uuid FOR UPDATE`);

    // The audit volume per demo session is tiny, so reading the ordered head is
    // cheap and keeps the sequence/hash link authoritative.
    const existing = await tx
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.sessionId, input.sessionId))
      .orderBy(asc(auditEvents.seq));
    const nextSeq = existing.length + 1;
    // The last HASHED event is the predecessor; a legacy (unhashed) prefix links
    // to GENESIS and the verifier tolerates it.
    let prevHash = GENESIS_HASH;
    for (let i = existing.length - 1; i >= 0; i -= 1) {
      const hash = existing[i]!.entryHash;
      if (hash) {
        prevHash = hash;
        break;
      }
    }
    const entryHash = hashAuditEntry({
      prevHash,
      seq: nextSeq,
      correlationId: input.correlationId,
      type: input.type,
      actor: input.actor,
      outcome: input.outcome,
      reason: input.reason ?? null,
      payload: safePayload,
    });

    await tx
      .insert(auditEvents)
      .values({
        sessionId: input.sessionId,
        seq: nextSeq,
        correlationId: input.correlationId,
        type: input.type,
        actor: input.actor,
        outcome: input.outcome,
        reason: input.reason ?? null,
        payload: safePayload,
        prevHash,
        entryHash,
      });
  });
}

/**
 * A denial or failure recorded OUTSIDE the failed transaction, so a rolled-back
 * financial attempt still leaves a trace. Never claims an operation succeeded.
 */
export async function appendAuditSafely(db: Db, input: AuditInput): Promise<void> {
  try {
    await appendAudit(db, input);
  } catch {
    // Audit storage is unavailable. We do not pretend the event was logged, and
    // the caller's financial decision has already failed closed.
  }
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly hashedEvents: number;
  /** Sequence of the first event whose link or hash fails, if any. */
  readonly brokenAtSeq: number | null;
  readonly problem: string | null;
}

/**
 * Recomputes the chain for a session and returns the first break it finds.
 * Rows written before the hash-chain migration (entry_hash is null) form a
 * tolerated legacy prefix; the chain is verified from the first hashed event.
 */
export async function verifyAuditChain(db: Db, sessionId: string): Promise<ChainVerification> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.sessionId, sessionId))
    .orderBy(asc(auditEvents.seq));

  let expectedPrev = GENESIS_HASH;
  let hashed = 0;
  for (const row of rows) {
    if (!row.entryHash) continue; // legacy prefix
    hashed += 1;
    if (row.prevHash !== expectedPrev) {
      return {
        ok: false,
        hashedEvents: hashed,
        brokenAtSeq: row.seq,
        problem: 'prev_hash does not link to the previous event (a row was inserted or removed)',
      };
    }
    const recomputed = hashAuditEntry({
      prevHash: row.prevHash ?? GENESIS_HASH,
      seq: row.seq,
      correlationId: row.correlationId,
      type: row.type,
      actor: row.actor,
      outcome: row.outcome,
      reason: row.reason,
      payload: row.payload as Record<string, unknown>,
    });
    if (recomputed !== row.entryHash) {
      return {
        ok: false,
        hashedEvents: hashed,
        brokenAtSeq: row.seq,
        problem: 'entry_hash does not match the stored content (a field was altered)',
      };
    }
    expectedPrev = row.entryHash;
  }
  return { ok: true, hashedEvents: hashed, brokenAtSeq: null, problem: null };
}
