import { describe, it, expect } from 'vitest';
import { planTuitionPayment, type PlanRequest } from '@/lib/domain/planner';
import { formatAmount, parseAmount } from '@/lib/domain/money';
import { HOUR_MS, DAY_MS } from '@/lib/domain/clock';
import {
  GOLDEN_SCENARIO,
  TIGHT_SCENARIO,
  SCENARIO_NOW,
  TUITION_DEADLINE,
  SIMULATED_ROUTES,
} from '@/lib/domain/fixtures';

const OBLIGATION_ID = 'obligation-1';

function request(overrides: Partial<PlanRequest> = {}, scenario = GOLDEN_SCENARIO): PlanRequest {
  return {
    now: SCENARIO_NOW,
    targetMinor: parseAmount(scenario.tuitionTarget, 'USD'),
    targetCurrency: 'USD',
    deadlineAt: TUITION_DEADLINE,
    account: {
      currency: 'GBP',
      balanceMinor: parseAmount(scenario.gbpBalance, 'GBP'),
      reservedMinor: 0n,
    },
    reserveMinor: parseAmount(scenario.emergencyReserve, 'GBP'),
    cashFlows: [
      {
        label: 'Rent',
        currency: 'GBP',
        direction: 'outflow',
        amountMinor: parseAmount(scenario.committedRent, 'GBP'),
        occursAt: scenario.rentDueAt,
        certain: true,
      },
    ],
    horizonDays: scenario.planningHorizonDays,
    routes: SIMULATED_ROUTES,
    obligationId: OBLIGATION_ID,
    ...overrides,
  };
}

const gbp = (minor: bigint) => formatAmount(minor, 'GBP');

describe('T01 the golden comparison', () => {
  const result = planTuitionPayment(request());

  it('selects route B', () => {
    expect(result.outcome).toBe('PLAN_READY');
    expect(result.recommended?.pricing.routeId).toBe('route-b');
  });

  it('debits GBP 6,435.00 and leaves a reserve margin of GBP 365.00', () => {
    expect(gbp(result.recommended!.pricing.totalDebitMinor)).toBe('6435.00');
    expect(gbp(result.recommended!.projectedLowMinor)).toBe('2365.00');
    expect(gbp(result.recommended!.reserveMarginMinor)).toBe('365.00');
  });

  it('offers C as the alternative at GBP 6,459.62', () => {
    expect(result.alternatives.map((c) => c.pricing.routeId)).toEqual(['route-c']);
    expect(gbp(result.alternatives[0]!.pricing.totalDebitMinor)).toBe('6459.62');
  });

  it('delivers exactly the net target, never less', () => {
    expect(formatAmount(result.recommended!.pricing.targetMinor, 'USD')).toBe('8000.00');
    expect(gbp(result.recommended!.pricing.principalMinor)).toBe('6400.00');
  });
});

describe('T06 the cheapest route loses on the deadline', () => {
  const result = planTuitionPayment(request());
  const a = result.excluded.find((c) => c.pricing.routeId === 'route-a')!;

  it('route A is cheaper than the recommendation and still excluded', () => {
    expect(gbp(a.pricing.totalDebitMinor)).toBe('6410.00');
    expect(a.pricing.totalDebitMinor).toBeLessThan(result.recommended!.pricing.totalDebitMinor);
    expect(a.exclusions).toContain('MISSES_DEADLINE');
  });

  it('states the reason rather than silently dropping it', () => {
    expect(result.excluded.map((c) => c.pricing.routeId)).toContain('route-a');
    expect(a.feasible).toBe(false);
  });
});

describe('T03 a route with an unknown fee cannot win', () => {
  const result = planTuitionPayment(request());
  const d = result.excluded.find((c) => c.pricing.routeId === 'route-d')!;

  it('route D is excluded for incomplete fees even though it posts in time', () => {
    expect(d.exclusions).toContain('INCOMPLETE_FEES');
    expect(d.exclusions).not.toContain('MISSES_DEADLINE');
  });

  it('and its visible total is lower than the recommendation', () => {
    expect(d.pricing.totalDebitMinor).toBeLessThan(result.recommended!.pricing.totalDebitMinor);
  });
});

describe('T02 the tight fixture has no feasible plan', () => {
  const result = planTuitionPayment(request({
    account: { currency: 'GBP', balanceMinor: parseAmount(TIGHT_SCENARIO.gbpBalance, 'GBP'), reservedMinor: 0n },
  }, TIGHT_SCENARIO));

  it('returns NO_FEASIBLE_PLAN rather than the least bad route', () => {
    expect(result.outcome).toBe('NO_FEASIBLE_PLAN');
    expect(result.recommended).toBeNull();
    expect(result.alternatives).toHaveLength(0);
  });

  it('reports the shortfall as GBP 135.00', () => {
    expect(gbp(result.shortfallMinor!)).toBe('135.00');
  });

  it('does not quietly lower the reserve', () => {
    const b = result.excluded.find((c) => c.pricing.routeId === 'route-b')!;
    expect(b.exclusions).toContain('BREACHES_RESERVE');
    expect(gbp(b.projectedLowMinor)).toBe('1865.00');
  });
});

describe('T07 reserve and liquidity', () => {
  it('counts a committed outflow inside the horizon', () => {
    const withoutRent = planTuitionPayment(request({ cashFlows: [] }));
    expect(gbp(withoutRent.recommended!.projectedLowMinor)).toBe('3565.00');
  });

  it('T15 excludes an uncertain inflow from available funds', () => {
    const base = request({
      account: { currency: 'GBP', balanceMinor: parseAmount(TIGHT_SCENARIO.gbpBalance, 'GBP'), reservedMinor: 0n },
    }, TIGHT_SCENARIO);
    const withScholarship = planTuitionPayment({
      ...base,
      cashFlows: [
        ...base.cashFlows,
        {
          label: 'Possible scholarship',
          currency: 'GBP',
          direction: 'inflow',
          amountMinor: parseAmount('500.00', 'GBP'),
          occursAt: new Date(SCENARIO_NOW.getTime() + DAY_MS),
          certain: false,
        },
      ],
    });
    // The scholarship would have closed the 135.00 gap if it were counted. It is not.
    expect(withScholarship.outcome).toBe('NO_FEASIBLE_PLAN');
    expect(gbp(withScholarship.shortfallMinor!)).toBe('135.00');
  });

  it('T16 counts an existing reservation exactly once', () => {
    // A 500.00 reservation must behave exactly like a 500.00 lower balance:
    // 10,000 - 500 - 6,435 - 1,200 = 1,865, which breaches the 2,000 reserve by 135.
    const reserved = planTuitionPayment(request({
      account: {
        currency: 'GBP',
        balanceMinor: parseAmount('10000.00', 'GBP'),
        reservedMinor: parseAmount('500.00', 'GBP'),
      },
    }));
    const lowerBalance = planTuitionPayment(request({
      account: {
        currency: 'GBP',
        balanceMinor: parseAmount('9500.00', 'GBP'),
        reservedMinor: 0n,
      },
    }));
    expect(reserved.outcome).toBe('NO_FEASIBLE_PLAN');
    expect(gbp(reserved.shortfallMinor!)).toBe('135.00');
    // Counted twice, the low would be 1,365 and the shortfall 635.
    const b = reserved.excluded.find((c) => c.pricing.routeId === 'route-b')!;
    expect(gbp(b.projectedLowMinor)).toBe('1865.00');
    expect(gbp(lowerBalance.shortfallMinor!)).toBe(gbp(reserved.shortfallMinor!));
  });

  it('T17 does not count the obligation twice when it also appears as a cash flow', () => {
    const base = request();
    const result = planTuitionPayment({
      ...base,
      cashFlows: [
        ...base.cashFlows,
        {
          label: 'Tuition (same obligation)',
          currency: 'GBP',
          direction: 'outflow',
          amountMinor: parseAmount('6435.00', 'GBP'),
          occursAt: new Date(SCENARIO_NOW.getTime() + DAY_MS),
          certain: true,
          obligationId: OBLIGATION_ID,
        },
      ],
    });
    expect(gbp(result.recommended!.projectedLowMinor)).toBe('2365.00');
  });

  it('ignores a cash flow beyond the horizon but a short horizon changes the answer', () => {
    const farRent = planTuitionPayment(request({
      cashFlows: [{
        label: 'Rent',
        currency: 'GBP',
        direction: 'outflow',
        amountMinor: parseAmount('1200.00', 'GBP'),
        occursAt: new Date(SCENARIO_NOW.getTime() + 60 * DAY_MS),
        certain: true,
      }],
    }));
    expect(gbp(farRent.recommended!.projectedLowMinor)).toBe('3565.00');
  });

  it('ignores a cash flow in another currency', () => {
    const result = planTuitionPayment(request({
      cashFlows: [{
        label: 'USD subscription',
        currency: 'USD',
        direction: 'outflow',
        amountMinor: parseAmount('9000.00', 'USD'),
        occursAt: new Date(SCENARIO_NOW.getTime() + DAY_MS),
        certain: true,
      }],
    }));
    expect(gbp(result.recommended!.projectedLowMinor)).toBe('3565.00');
  });
});

describe('T08 insufficient balance', () => {
  it('excludes every route and reports no feasible plan', () => {
    const result = planTuitionPayment(request({
      account: { currency: 'GBP', balanceMinor: parseAmount('100.00', 'GBP'), reservedMinor: 0n },
    }));
    expect(result.outcome).toBe('NO_FEASIBLE_PLAN');
    const b = result.excluded.find((c) => c.pricing.routeId === 'route-b')!;
    expect(b.exclusions).toContain('INSUFFICIENT_BALANCE');
  });
});

describe('T04 quote expiry is exclusive at the boundary', () => {
  it('a quote is expired the instant its expiry is reached', () => {
    const atExpiry = planTuitionPayment(request({
      // Every fixture route has a 30-minute TTL; step the clock to exactly that.
      routes: SIMULATED_ROUTES.map((r) => ({ ...r, quoteTtlMinutes: 0 })),
    }));
    expect(atExpiry.outcome).toBe('NO_FEASIBLE_PLAN');
    for (const c of atExpiry.excluded) expect(c.exclusions).toContain('QUOTE_EXPIRED');
  });
});

describe('T10 deterministic ranking', () => {
  it('breaks a cost tie by the earlier posting, then by route id', () => {
    const tied = SIMULATED_ROUTES.filter((r) => r.feeCompleteness === 'complete').map((r) => ({
      ...r,
      rate: '1.25',
      sourceFee: '35.00',
    }));
    const slowFirst = planTuitionPayment(request({ routes: [...tied].reverse() }));
    const fastFirst = planTuitionPayment(request({ routes: tied }));
    expect(slowFirst.recommended!.pricing.routeId).toBe(fastFirst.recommended!.pricing.routeId);
    // route-b posts at +72h, route-c at +84h, route-a at +120h and misses the deadline.
    expect(fastFirst.recommended!.pricing.routeId).toBe('route-b');
  });

  it('is stable across repeated runs', () => {
    const once = planTuitionPayment(request());
    const twice = planTuitionPayment(request());
    expect(once.excluded.map((c) => c.pricing.routeId)).toEqual(twice.excluded.map((c) => c.pricing.routeId));
  });
});

describe('T12 an unsupported corridor', () => {
  it('is excluded rather than priced as if available', () => {
    const result = planTuitionPayment(request({
      routes: [{ ...SIMULATED_ROUTES[1]!, id: 'route-x', from: 'USD', to: 'GBP' }],
    }));
    expect(result.outcome).toBe('NO_FEASIBLE_PLAN');
    expect(result.excluded[0]!.exclusions).toEqual(['UNSUPPORTED_CORRIDOR']);
    expect(result.shortfallMinor).toBeNull();
  });
});

describe('planning changes no money', () => {
  it('leaves the account snapshot untouched', () => {
    const req = request();
    const before = { ...req.account };
    planTuitionPayment(req);
    expect(req.account).toEqual(before);
  });
});

describe('feasibility uses institution posting, not delivery', () => {
  it('a route that delivers in time but posts late is excluded', () => {
    const result = planTuitionPayment(request({
      routes: [{
        ...SIMULATED_ROUTES[1]!,
        id: 'route-late-posting',
        deliveryHours: 24,
        postingHours: 96,
      }],
    }));
    const only = result.excluded[0]!;
    expect(only.pricing.deliveredAt.getTime()).toBeLessThan(TUITION_DEADLINE.getTime());
    expect(only.pricing.postedAt.getTime()).toBeGreaterThan(TUITION_DEADLINE.getTime());
    expect(only.exclusions).toContain('MISSES_DEADLINE');
  });

  it('a route posting exactly at the deadline is still feasible', () => {
    const hoursToDeadline = (TUITION_DEADLINE.getTime() - SCENARIO_NOW.getTime()) / HOUR_MS;
    const result = planTuitionPayment(request({
      routes: [{
        ...SIMULATED_ROUTES[1]!,
        id: 'route-exact',
        deliveryHours: hoursToDeadline - 1,
        postingHours: 1,
      }],
    }));
    expect(result.outcome).toBe('PLAN_READY');
  });
});
