import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { beneficiaries, obligations, transfers } from '@/lib/db/schema';
import { createWorkspace, resolveSession } from '@/lib/services/workspace';
import { createPlan } from '@/lib/services/planning';
import { approvePlan, confirmAndExecute } from '@/lib/services/execution';

const pool: pg.Pool = testPool(6);
const db = dbFor(pool);

beforeEach(async () => {
  process.env.EXECUTION_ENABLED = 'true';
  await truncateAll(pool);
});
afterAll(async () => { await pool.end(); });

describe('T06 the beneficiary cannot change under an approval', () => {
  it('refuses execution when the payee was edited after approval', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);
    const plan = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    const grant = await approvePlan(db, session, {
      planId: plan.planId, expectedTermsHash: plan.termsHash,
    });

    // The payee is redirected AFTER the user approved. This is the attack that
    // matters most: the user consented to paying the university, not this.
    const ob = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    await db.update(beneficiaries)
      .set({ reference: 'ATTACKER-ACCOUNT-9910', version: 1 })
      .where(eq(beneficiaries.id, ob.beneficiaryId));

    await expect(
      confirmAndExecute(db, session, {
        planId: plan.planId,
        expectedTermsHash: plan.termsHash,
        nonce: grant.nonce,
        idempotencyKey: 'redirect-1',
      }),
    ).rejects.toThrow(/changed/i);

    expect(await db.select().from(transfers)).toHaveLength(0);
  });
});

describe('T06b a silent payee edit is also caught', () => {
  it('refuses when the reference changes but the version was not bumped', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);
    const plan = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    const grant = await approvePlan(db, session, {
      planId: plan.planId, expectedTermsHash: plan.termsHash,
    });

    // The version counter is deliberately left alone: an attacker who can edit
    // the row can also decline to increment it, so the reference itself is
    // compared, not only its version.
    const ob = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    await db.update(beneficiaries)
      .set({ reference: 'ATTACKER-ACCOUNT-9910' })
      .where(eq(beneficiaries.id, ob.beneficiaryId));

    await expect(
      confirmAndExecute(db, session, {
        planId: plan.planId,
        expectedTermsHash: plan.termsHash,
        nonce: grant.nonce,
        idempotencyKey: 'silent-redirect-1',
      }),
    ).rejects.toThrow(/payee changed/i);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });
});
