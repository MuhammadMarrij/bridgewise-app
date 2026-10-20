/**
 * Obligation intake: the student types in their own bill.
 *
 * Until this existed the only tuition bill in the system was the one the seeder
 * created, which made the product look hardcoded because functionally it was.
 *
 * Two rules shape this file:
 *
 *   1. A field that affects what gets paid must be CONFIRMED before the
 *      obligation is executable. Typing a number is not the same as meaning it,
 *      and a typo in a beneficiary reference sends money to the wrong place.
 *   2. A deadline with no time is ambiguous, and a planner that guesses midnight
 *      is a planner that will one day miss a 09:00 cutoff. We ask instead.
 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { beneficiaries, cashFlowEvents, obligations } from '../db/schema';
import { SUPPORTED_CURRENCIES, parseAmount, formatAmount, type Currency } from '../domain/money';
import { AppError } from './errors';
import { type ResolvedSession, sessionNow } from './workspace';

type Db = NodePgDatabase<Record<string, never>>;

export interface ObligationDraft {
  readonly description: string;
  readonly amount: string;
  readonly currency: Currency;
  readonly beneficiaryName: string;
  readonly beneficiaryReference: string;
  /** ISO date, e.g. 2026-11-30. */
  readonly deadlineDate: string;
  /** 24-hour local time, e.g. 17:00. Required: see rule 2 above. */
  readonly deadlineTime: string;
  /** IANA zone, e.g. America/New_York. */
  readonly deadlineTimezone: string;
  readonly reserveAmount: string;
  readonly reserveCurrency: Currency;
}

/** Resolves a wall-clock time in a named zone to an instant, without guessing. */
export function resolveDeadline(date: string, time: string, timezone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError('VALIDATION_FAILED', 'date must be YYYY-MM-DD', { deadlineDate: 'use YYYY-MM-DD' });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new AppError('VALIDATION_FAILED', 'time must be HH:MM', { deadlineTime: 'use HH:MM, 24-hour' });
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    throw new AppError('VALIDATION_FAILED', `unknown timezone ${timezone}`, {
      deadlineTimezone: 'use an IANA zone such as America/New_York',
    });
  }

  const target = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== `${date}T${time}`) {
    throw new AppError('VALIDATION_FAILED', 'that is not a real date and time');
  }
  const wallTime = (instant: number): number => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
  };
  // Try offsets on both sides of a transition; reject gaps and repeated hours.
  const candidates = new Set<number>();
  for (const days of [-2, -1, 0, 1, 2]) {
    const probe = target + days * 86_400_000;
    const instant = target - (wallTime(probe) - probe);
    if (wallTime(instant) === target) candidates.add(instant);
  }
  if (candidates.size !== 1) {
    throw new AppError('VALIDATION_FAILED', 'that local time is nonexistent or ambiguous; choose an unambiguous time');
  }
  return new Date([...candidates][0]!);
}

export interface CreatedObligation {
  readonly details: ObligationDraft;
  readonly obligationId: string;
  readonly beneficiaryId: string;
  /** False until the student confirms the terms they typed. */
  readonly confirmed: boolean;
  readonly deadlineAt: Date;
}

export async function createObligation(
  db: Db,
  session: ResolvedSession,
  draft: ObligationDraft,
): Promise<CreatedObligation> {
  const now = sessionNow(session);

  if (!SUPPORTED_CURRENCIES.includes(draft.currency)) {
    throw new AppError('UNSUPPORTED', `${draft.currency} is not supported in this release`);
  }
  if (!SUPPORTED_CURRENCIES.includes(draft.reserveCurrency)) {
    throw new AppError('UNSUPPORTED', `${draft.reserveCurrency} is not supported in this release`);
  }

  const targetMinor = parseAmount(draft.amount, draft.currency);
  if (targetMinor <= 0n) {
    throw new AppError('VALIDATION_FAILED', 'the amount must be greater than zero', { amount: 'must be positive' });
  }
  const reserveMinor = parseAmount(draft.reserveAmount, draft.reserveCurrency);

  const deadlineAt = resolveDeadline(draft.deadlineDate, draft.deadlineTime, draft.deadlineTimezone);
  if (deadlineAt.getTime() <= now.getTime()) {
    // A bill already overdue is a real situation, but it is not one this planner
    // can help with, and pretending otherwise would produce a confident wrong plan.
    throw new AppError('VALIDATION_FAILED', 'that deadline has already passed', {
      deadlineDate: 'the deadline must be in the future',
    });
  }

  const reference = draft.beneficiaryReference.trim();
  if (reference.length < 3 || reference.length > 64) {
    throw new AppError('VALIDATION_FAILED', 'the payment reference looks wrong', {
      beneficiaryReference: 'between 3 and 64 characters',
    });
  }

  const beneficiaryRows = await db
    .insert(beneficiaries)
    .values({
      sessionId: session.id,
      displayName: draft.beneficiaryName.trim().slice(0, 120),
      reference,
      currency: draft.currency,
    })
    .returning();
  const beneficiary = beneficiaryRows[0]!;

  const rows = await db
    .insert(obligations)
    .values({
      sessionId: session.id,
      beneficiaryId: beneficiary.id,
      description: draft.description.trim().slice(0, 120) || 'Tuition',
      targetMinor,
      currency: draft.currency,
      deadlineAt,
      deadlineTimezone: draft.deadlineTimezone,
      reserveMinor,
      reserveCurrency: draft.reserveCurrency,
      // Deliberately NOT confirmed. The student must see what the server parsed
      // and agree to it before any of it becomes executable.
      confirmedAt: null,
    })
    .returning();

  return {
    details: {
      ...draft,
      description: rows[0]!.description,
      amount: formatAmount(targetMinor, draft.currency),
      beneficiaryName: beneficiary.displayName,
      beneficiaryReference: beneficiary.reference,
      reserveAmount: formatAmount(reserveMinor, draft.reserveCurrency),
    },
    obligationId: rows[0]!.id,
    beneficiaryId: beneficiary.id,
    confirmed: false,
    deadlineAt,
  };
}

/**
 * Confirmation. The student is shown what the server UNDERSTOOD — not what they
 * typed — and agrees to that. The two differ in exactly the cases that matter:
 * a mistyped amount, a timezone that moved the deadline a day, a reference with
 * a transposed digit.
 */
export async function confirmObligation(
  db: Db,
  session: ResolvedSession,
  obligationId: string,
  expected: { amount: string; reference: string; deadlineAt: string },
): Promise<void> {
  const rows = await db
    .select()
    .from(obligations)
    .where(and(eq(obligations.id, obligationId), eq(obligations.sessionId, session.id)))
    .limit(1);
  const obligation = rows[0];
  if (!obligation) throw new AppError('NOT_FOUND', 'obligation not found');
  if (obligation.confirmedAt) return;

  const beneficiaryRows = await db
    .select()
    .from(beneficiaries)
    .where(eq(beneficiaries.id, obligation.beneficiaryId))
    .limit(1);
  const beneficiary = beneficiaryRows[0];
  if (!beneficiary) throw new AppError('NOT_FOUND', 'beneficiary not found');

  const { formatAmount } = await import('../domain/money');
  const actualAmount = formatAmount(obligation.targetMinor, obligation.currency as Currency);

  if (
    expected.amount !== actualAmount ||
    expected.reference !== beneficiary.reference ||
    expected.deadlineAt !== obligation.deadlineAt.toISOString()
  ) {
    // The student is confirming something other than what is stored. Refuse
    // rather than accept the stored version: one of the two is wrong and we
    // cannot tell which.
    throw new AppError('TERMS_CHANGED', 'these details do not match what was saved; review them again');
  }

  await db
    .update(obligations)
    .set({ confirmedAt: new Date(), version: obligation.version + 1 })
    .where(eq(obligations.id, obligation.id));
}

/** A dated commitment the student adds themselves, such as rent. */
export async function addCashFlow(
  db: Db,
  session: ResolvedSession,
  input: {
    label: string;
    currency: Currency;
    direction: 'inflow' | 'outflow';
    amount: string;
    occursAt: string;
    certain: boolean;
  },
): Promise<string> {
  const amountMinor = parseAmount(input.amount, input.currency);
  if (amountMinor <= 0n) throw new AppError('VALIDATION_FAILED', 'the amount must be greater than zero');
  const occursAt = new Date(input.occursAt);
  if (Number.isNaN(occursAt.getTime())) throw new AppError('VALIDATION_FAILED', 'that is not a real date');

  const rows = await db
    .insert(cashFlowEvents)
    .values({
      sessionId: session.id,
      label: input.label.trim().slice(0, 80) || 'Commitment',
      currency: input.currency,
      direction: input.direction,
      amountMinor,
      occursAt,
      // An uncertain inflow is recorded but never counted as available funds.
      certain: input.certain,
    })
    .returning();
  return rows[0]!.id;
}
