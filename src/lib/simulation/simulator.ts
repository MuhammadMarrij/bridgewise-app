/**
 * The independent payment simulator.
 *
 * It stands in for a provider and it is deliberately NOT part of the application's
 * own bookkeeping: it keeps its own records in its own table, and the application
 * learns a transfer's fate by ASKING it, never by assuming its optimistic write
 * was the truth. That separation is what makes UNKNOWN_OUTCOME recoverable and
 * what makes "delivered" a fact we received rather than a fact we invented.
 *
 * It moves no real money and it is labelled simulated in every record it returns.
 */
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { simulatorTransfers } from '../db/schema';
import type { Currency } from '../domain/money';

export type SimulatorStatus = 'ACCEPTED' | 'DELIVERED' | 'POSTED' | 'REJECTED';

export interface SubmitRequest {
  /** Provider-side idempotency key. A resend with this key returns the original. */
  readonly clientKey: string;
  readonly sourceCurrency: Currency;
  readonly targetCurrency: Currency;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly beneficiaryReference: string;
}

export interface SimulatorRecord {
  readonly id: string;
  readonly clientKey: string;
  readonly status: SimulatorStatus;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly beneficiaryReference: string;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly postedAt: Date | null;
  readonly rejectedReason: string | null;
  /** Always true. The evidence bundle must never show this as a live provider. */
  readonly simulated: true;
}

export type SimulatorErrorCode = 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION';

export class SimulatorError extends Error {
  constructor(readonly code: SimulatorErrorCode, message: string) {
    super(message);
    this.name = 'SimulatorError';
  }
}

export function payloadHashOf(req: SubmitRequest): string {
  // Field order is fixed here so the hash is stable across callers and releases.
  const canonical = JSON.stringify([
    req.sourceCurrency,
    req.targetCurrency,
    req.debitMinor.toString(),
    req.creditMinor.toString(),
    req.beneficiaryReference,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

type Db = NodePgDatabase<Record<string, never>>;

function toRecord(row: typeof simulatorTransfers.$inferSelect): SimulatorRecord {
  return {
    id: row.id,
    clientKey: row.clientKey,
    status: row.status as SimulatorStatus,
    debitMinor: row.debitMinor,
    creditMinor: row.creditMinor,
    beneficiaryReference: row.beneficiaryReference,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    postedAt: row.postedAt,
    rejectedReason: row.rejectedReason,
    simulated: true,
  };
}

/**
 * Accept a transfer, or return the one already accepted under this key.
 *
 * Same key and same payload returns the original record: a retry after a dropped
 * response can never produce a second transfer. Same key with a DIFFERENT payload
 * is a conflict, because it means the caller changed the terms behind a key that
 * already authorised something else.
 */
export async function submit(db: Db, req: SubmitRequest): Promise<SimulatorRecord> {
  const payloadHash = payloadHashOf(req);
  const existing = await db
    .select()
    .from(simulatorTransfers)
    .where(eq(simulatorTransfers.clientKey, req.clientKey))
    .limit(1);

  const prior = existing[0];
  if (prior) {
    if (prior.payloadHash !== payloadHash) {
      throw new SimulatorError(
        'IDEMPOTENCY_CONFLICT',
        'this key was already used for a different payload',
      );
    }
    return toRecord(prior);
  }

  try {
    const inserted = await db
      .insert(simulatorTransfers)
      .values({
        clientKey: req.clientKey,
        payloadHash,
        status: 'ACCEPTED',
        sourceCurrency: req.sourceCurrency,
        targetCurrency: req.targetCurrency,
        debitMinor: req.debitMinor,
        creditMinor: req.creditMinor,
        beneficiaryReference: req.beneficiaryReference,
      })
      .returning();
    return toRecord(inserted[0]!);
  } catch (error) {
    // Two concurrent submits with the same key: the unique index rejects one.
    // The loser re-reads rather than failing, so the caller still sees one transfer.
    const raced = await db
      .select()
      .from(simulatorTransfers)
      .where(eq(simulatorTransfers.clientKey, req.clientKey))
      .limit(1);
    const row = raced[0];
    if (!row) throw error;
    if (row.payloadHash !== payloadHash) {
      throw new SimulatorError('IDEMPOTENCY_CONFLICT', 'this key was already used for a different payload');
    }
    return toRecord(row);
  }
}

export type SimulatorEvent = 'deliver' | 'post' | 'reject';

/**
 * Advance a transfer. Terminal states are terminal, and the sequence cannot run
 * backwards: a duplicate or out-of-order event is absorbed, never applied twice.
 */
export async function advance(
  db: Db,
  clientKey: string,
  event: SimulatorEvent,
  at: Date,
  reason?: string,
): Promise<SimulatorRecord> {
  return db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const rows = await db
      .select()
      .from(simulatorTransfers)
      .where(eq(simulatorTransfers.clientKey, clientKey))
      .for('update');
    const row = rows[0];
    if (!row) throw new SimulatorError('NOT_FOUND', `no simulated transfer for key ${clientKey}`);

    const status = row.status as SimulatorStatus;

    if (event === 'deliver') {
      // Already delivered or posted: absorb. A duplicate provider webhook must not
      // produce a second delivery or move a posted transfer backwards.
      if (status === 'DELIVERED' || status === 'POSTED') return toRecord(row);
      if (status === 'REJECTED') {
        throw new SimulatorError('ILLEGAL_TRANSITION', 'a rejected transfer cannot be delivered');
      }
      const updated = await db
        .update(simulatorTransfers)
        .set({ status: 'DELIVERED', deliveredAt: at })
        .where(eq(simulatorTransfers.clientKey, clientKey))
        .returning();
      return toRecord(updated[0]!);
    }

    if (event === 'post') {
      if (status === 'POSTED') return toRecord(row);
      if (status !== 'DELIVERED') {
        // An institution cannot post a credit it has not received. This is the
        // invariant behind "DELIVERED does not mean PAID".
        throw new SimulatorError('ILLEGAL_TRANSITION', 'only a delivered transfer can be posted');
      }
      const updated = await db
        .update(simulatorTransfers)
        .set({ status: 'POSTED', postedAt: at })
        .where(eq(simulatorTransfers.clientKey, clientKey))
        .returning();
      return toRecord(updated[0]!);
    }

    if (status === 'REJECTED') return toRecord(row);
    if (status !== 'ACCEPTED') {
      throw new SimulatorError('ILLEGAL_TRANSITION', 'only an accepted transfer can be rejected');
    }
    const updated = await db
      .update(simulatorTransfers)
      .set({ status: 'REJECTED', rejectedReason: reason ?? 'simulated rejection' })
      .where(eq(simulatorTransfers.clientKey, clientKey))
      .returning();
    return toRecord(updated[0]!);
  });
}

/** The reconciliation read. This is how an UNKNOWN_OUTCOME is resolved. */
export async function lookup(db: Db, clientKey: string): Promise<SimulatorRecord | null> {
    const rows = await db
    .select()
    .from(simulatorTransfers)
    .where(eq(simulatorTransfers.clientKey, clientKey))
    .limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}
