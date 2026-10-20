import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import {
  SimulatorError,
  advance,
  lookup,
  submit,
  type SubmitRequest,
} from '@/lib/simulation/simulator';

const pool: pg.Pool = testPool();
const db = dbFor(pool);

const request = (overrides: Partial<SubmitRequest> = {}): SubmitRequest => ({
  clientKey: 'key-1',
  sourceCurrency: 'GBP',
  targetCurrency: 'USD',
  debitMinor: 643500n,
  creditMinor: 800000n,
  beneficiaryReference: 'NG-TUITION-4417',
  ...overrides,
});

beforeEach(async () => {
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('simulator submission', () => {
  it('accepts a transfer and persists it', async () => {
    const record = await submit(db, request());
    expect(record.status).toBe('ACCEPTED');
    expect(record.simulated).toBe(true);
    expect(record.debitMinor).toBe(643500n);
    expect(await lookup(db, 'key-1')).toMatchObject({ id: record.id, status: 'ACCEPTED' });
  });

  it('T50 returns the original record when the same key and payload are resent', async () => {
    const first = await submit(db, request());
    const second = await submit(db, request());
    expect(second.id).toBe(first.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
  });

  it('T20 conflicts when the same key carries a different payload', async () => {
    await submit(db, request());
    await expect(submit(db, request({ debitMinor: 1n }))).rejects.toThrow(SimulatorError);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
  });

  it('T18 produces exactly one transfer under 20 concurrent identical submissions', async () => {
    // Each submission gets its own connection from the pool, so these genuinely
    // overlap rather than running one after another.
    const attempts = Array.from({ length: 20 }, () => submit(db, request()));
    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled.length).toBe(20);

    const ids = new Set(fulfilled.map((s) => (s as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
  });
});

describe('simulator state transitions', () => {
  it('runs ACCEPTED to DELIVERED to POSTED', async () => {
    await submit(db, request());
    const delivered = await advance(db, 'key-1', 'deliver', new Date('2026-10-21T10:00:00Z'));
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.postedAt).toBeNull();

    const posted = await advance(db, 'key-1', 'post', new Date('2026-10-22T10:00:00Z'));
    expect(posted.status).toBe('POSTED');
    expect(posted.postedAt).not.toBeNull();
  });

  it('T27 refuses to post a transfer that was never delivered', async () => {
    await submit(db, request());
    await expect(advance(db, 'key-1', 'post', new Date())).rejects.toThrow(/delivered/);
    expect((await lookup(db, 'key-1'))!.status).toBe('ACCEPTED');
  });

  it('T24 absorbs a duplicate delivery and never moves backwards', async () => {
    await submit(db, request());
    const first = await advance(db, 'key-1', 'deliver', new Date('2026-10-21T10:00:00Z'));
    const again = await advance(db, 'key-1', 'deliver', new Date('2026-10-21T18:00:00Z'));
    expect(again.deliveredAt?.toISOString()).toBe(first.deliveredAt?.toISOString());

    await advance(db, 'key-1', 'post', new Date('2026-10-22T10:00:00Z'));
    const outOfOrder = await advance(db, 'key-1', 'deliver', new Date('2026-10-23T10:00:00Z'));
    expect(outOfOrder.status).toBe('POSTED');
  });

  it('T25 rejects before delivery and will not then deliver', async () => {
    await submit(db, request());
    const rejected = await advance(db, 'key-1', 'reject', new Date(), 'insufficient provider liquidity');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectedReason).toBe('insufficient provider liquidity');
    await expect(advance(db, 'key-1', 'deliver', new Date())).rejects.toThrow(/rejected/);
  });

  it('reports an unknown key rather than inventing a record', async () => {
    await expect(advance(db, 'nope', 'deliver', new Date())).rejects.toThrow(SimulatorError);
    expect(await lookup(db, 'nope')).toBeNull();
  });
});

describe('T21 recovering an unknown outcome', () => {
  it('finds the accepted transfer by its key after a lost response', async () => {
    // The application submitted, then lost the reply. It must NOT resubmit with a
    // new identity; it asks the provider what happened under the original key.
    await submit(db, request({ clientKey: 'lost-response' }));
    const found = await lookup(db, 'lost-response');
    expect(found).not.toBeNull();
    expect(found!.status).toBe('ACCEPTED');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
  });
});
