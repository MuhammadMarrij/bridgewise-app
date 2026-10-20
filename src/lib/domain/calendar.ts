/**
 * Business-day settlement calendar.
 *
 * Real cross-border payments do not settle on a flat number of hours: they
 * clear on business days, respect a daily cutoff ("submit before 15:00 local
 * or processing starts the next business day"), and skip weekends and public
 * holidays in the beneficiary jurisdiction. A payment sent on Friday evening
 * is not the same as one sent on Monday morning.
 *
 * This module is pure and deterministic. It deliberately uses a FIXED UTC
 * offset per jurisdiction (no DST) and an explicit, synthetic holiday list:
 * it is a labelled simulation, not a holiday-data provider. Every date is
 * derived from UTC so the results are identical on every machine.
 */

export type SettlementKind = 'fixed_hours' | 'business_days';

export interface FixedHoursSettlement {
  readonly kind: 'fixed_hours';
  readonly deliveryHours: number;
  readonly postingHours: number;
}

export interface BusinessDaysSettlement {
  readonly kind: 'business_days';
  /** Business days from an accepted order to the provider delivering funds. */
  readonly deliveryBusinessDays: number;
  /** Business days from delivery to the institution posting the credit. */
  readonly postingBusinessDays: number;
  /** Jurisdiction calendar key in {@link JURISDICTION_CALENDARS}. */
  readonly jurisdiction: string;
}

export type SettlementSpec = FixedHoursSettlement | BusinessDaysSettlement;

export interface JurisdictionCalendar {
  readonly key: string;
  /** Fixed offset from UTC in minutes (no DST in this simulation). */
  readonly utcOffsetMinutes: number;
  /** Days of the week that are not business days, 0 = Sunday .. 6 = Saturday. */
  readonly weekendDays: readonly number[];
  /** Local wall-clock hour (0..23) after which an order starts next business day. */
  readonly cutoffHour: number;
  /** Hour funds are delivered on the scheduled business day. */
  readonly deliveryHour: number;
  /** Hour the institution posts the credit on the scheduled business day. */
  readonly postingHour: number;
  /** Local dates 'YYYY-MM-DD' that are not business days. */
  readonly holidays: readonly string[];
}

/**
 * A small synthetic holiday set. These are NOT asserted to be real official
 * dates — they are enough to demonstrate that a holiday, like a weekend, moves
 * the posting date. Each key is ISO country code, matching the currency registry.
 */
export const JURISDICTION_CALENDARS: Record<string, JurisdictionCalendar> = {
  US: {
    key: 'US',
    utcOffsetMinutes: -5 * 60, // US Eastern, fixed (standard time), no DST
    weekendDays: [0, 6],
    cutoffHour: 17,
    deliveryHour: 14,
    postingHour: 10,
    // Columbus Day (Mon) and a synthetic Thanksgiving closure.
    holidays: ['2026-10-12', '2026-11-26'],
  },
  GB: {
    key: 'GB',
    utcOffsetMinutes: 0,
    weekendDays: [0, 6],
    cutoffHour: 15,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-12-25', '2026-12-28'],
  },
  PK: {
    key: 'PK',
    utcOffsetMinutes: 5 * 60,
    weekendDays: [0, 6],
    cutoffHour: 13,
    deliveryHour: 13,
    postingHour: 11,
    holidays: ['2026-11-09'],
  },
  JP: {
    key: 'JP',
    utcOffsetMinutes: 9 * 60,
    weekendDays: [0, 6],
    cutoffHour: 15,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-11-03'],
  },
  KW: {
    key: 'KW',
    utcOffsetMinutes: 3 * 60,
    // Kuwait's weekend is Friday/Saturday.
    weekendDays: [5, 6],
    cutoffHour: 13,
    deliveryHour: 13,
    postingHour: 11,
    holidays: ['2026-12-17'],
  },
  BH: {
    key: 'BH',
    utcOffsetMinutes: 3 * 60,
    weekendDays: [5, 6],
    cutoffHour: 13,
    deliveryHour: 13,
    postingHour: 11,
    holidays: ['2026-12-17'],
  },
  EU: {
    key: 'EU',
    utcOffsetMinutes: 60,
    weekendDays: [0, 6],
    cutoffHour: 16,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-12-25'],
  },
  AU: {
    key: 'AU',
    utcOffsetMinutes: 10 * 60,
    weekendDays: [0, 6],
    cutoffHour: 16,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-12-25'],
  },
  CA: {
    key: 'CA',
    utcOffsetMinutes: -5 * 60,
    weekendDays: [0, 6],
    cutoffHour: 17,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-11-11'],
  },
  CN: {
    key: 'CN',
    utcOffsetMinutes: 8 * 60,
    weekendDays: [0, 6],
    cutoffHour: 16,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-10-01'],
  },
  AE: {
    key: 'AE',
    utcOffsetMinutes: 4 * 60,
    weekendDays: [5, 6],
    cutoffHour: 14,
    deliveryHour: 13,
    postingHour: 11,
    holidays: ['2026-12-01'],
  },
  IN: {
    key: 'IN',
    utcOffsetMinutes: 5 * 60 + 30,
    weekendDays: [0, 6],
    cutoffHour: 15,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-11-02'],
  },
  KR: {
    key: 'KR',
    utcOffsetMinutes: 9 * 60,
    weekendDays: [0, 6],
    cutoffHour: 15,
    deliveryHour: 14,
    postingHour: 10,
    holidays: ['2026-10-09'],
  },
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface WallParts {
  y: number;
  m: number; // 0-based
  d: number;
  hour: number;
  weekday: number; // 0..6
  dateKey: string; // YYYY-MM-DD
}

/** UTC instant -> local wall-clock parts for a fixed-offset jurisdiction. */
function wallParts(instant: Date, utcOffsetMinutes: number): WallParts {
  const shifted = new Date(instant.getTime() + utcOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m, d, hour, weekday: shifted.getUTCDay(), dateKey };
}

/** Local wall date at a given hour -> UTC instant. */
function toUtc(y: number, m: number, d: number, hour: number, utcOffsetMinutes: number): Date {
  const asIfUtc = Date.UTC(y, m, d, hour, 0, 0, 0);
  return new Date(asIfUtc - utcOffsetMinutes * 60_000);
}

function isBusinessDay(parts: WallParts, cal: JurisdictionCalendar): boolean {
  return !cal.weekendDays.includes(parts.weekday) && !cal.holidays.includes(parts.dateKey);
}

/**
 * The first business day on or after the given instant's local day, honoring the
 * cutoff. Returns the local calendar date (Y, M, D) that processing begins on.
 */
function firstProcessingDay(instant: Date, cal: JurisdictionCalendar): { y: number; m: number; d: number } {
  let t = new Date(instant.getTime());
  for (let i = 0; i < 14; i++) {
    const parts = wallParts(t, cal.utcOffsetMinutes);
    if (isBusinessDay(parts, cal) && parts.hour < cal.cutoffHour) {
      return { y: parts.y, m: parts.m, d: parts.d };
    }
    // Advance to the next local day (either after cutoff, or a weekend/holiday).
    t = new Date(t.getTime() + DAY_MS);
  }
  // Defensive: a holiday list cannot be long enough to make this unreachable.
  throw new Error(`no business day found within 14 days for ${cal.key}`);
}

/** Local wall date-key for a cursor shifted into the jurisdiction's offset. */
function localDateParts(cursorUtc: Date, cal: JurisdictionCalendar): {
  y: number; m: number; d: number; weekday: number; dateKey: string;
} {
  const s = new Date(cursorUtc.getTime() + cal.utcOffsetMinutes * 60_000);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth(),
    d: s.getUTCDate(),
    weekday: s.getUTCDay(),
    dateKey: `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`,
  };
}

/** Add n business days to a local calendar date, skipping weekends and holidays. */
function addBusinessDays(
  y: number,
  m: number,
  d: number,
  n: number,
  cal: JurisdictionCalendar,
): { y: number; m: number; d: number } {
  // The input is a calendar day in the jurisdiction's local wall clock.
  let cursor = new Date(Date.UTC(y, m, d) - cal.utcOffsetMinutes * 60_000);
  let remaining = n;
  for (let i = 0; i < 100; i++) {
    if (remaining === 0) break;
    cursor = new Date(cursor.getTime() + DAY_MS);
    const parts = localDateParts(cursor, cal);
    if (!cal.weekendDays.includes(parts.weekday) && !cal.holidays.includes(parts.dateKey)) {
      remaining--;
    }
  }
  const out = localDateParts(cursor, cal);
  return { y: out.y, m: out.m, d: out.d };
}

export interface SettlementTiming {
  deliveredAt: Date;
  postedAt: Date;
}

/**
 * Compute delivery and institution-posting instants for a quote.
 *
 * `fixed_hours` reproduces the original flat-hours model exactly.
 * `business_days` honors the cutoff, weekends and holidays.
 */
export function settle(quoteAt: Date, spec: SettlementSpec): SettlementTiming {
  if (spec.kind === 'fixed_hours') {
    const deliveredAt = new Date(quoteAt.getTime() + spec.deliveryHours * HOUR_MS);
    const postedAt = new Date(deliveredAt.getTime() + spec.postingHours * HOUR_MS);
    return { deliveredAt, postedAt };
  }

  const cal = JURISDICTION_CALENDARS[spec.jurisdiction];
  if (!cal) throw new Error(`unknown settlement jurisdiction ${spec.jurisdiction}`);

  const day0 = firstProcessingDay(quoteAt, cal);
  const deliveryDay = addBusinessDays(day0.y, day0.m, day0.d, spec.deliveryBusinessDays, cal);
  const deliveredAt = toUtc(deliveryDay.y, deliveryDay.m, deliveryDay.d, cal.deliveryHour, cal.utcOffsetMinutes);

  const postingDay = addBusinessDays(
    deliveryDay.y,
    deliveryDay.m,
    deliveryDay.d,
    spec.postingBusinessDays,
    cal,
  );
  const postedAt = toUtc(postingDay.y, postingDay.m, postingDay.d, cal.postingHour, cal.utcOffsetMinutes);
  return { deliveredAt, postedAt };
}

/**
 * The earliest a quote can be dispatched and still post by a deadline, using
 * business-day settlement. Used by the staged planner to choose dispatch dates.
 */
export function canPostByDeadline(
  quoteAt: Date,
  spec: BusinessDaysSettlement,
  deadlineAt: Date,
): boolean {
  const { postedAt } = settle(quoteAt, spec);
  return postedAt.getTime() <= deadlineAt.getTime();
}
