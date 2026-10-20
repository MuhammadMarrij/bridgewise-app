/**
 * Time is injected, never read from the ambient environment inside domain code.
 *
 * Two clocks that must never be confused, and the evidence bundle labels which
 * produced each timestamp:
 *   - real time: when the run actually happened.
 *   - scenario time: the demo clock a fixture pins, so the golden scenario is
 *     reproducible on any machine on any date.
 *
 * A fixed clock may ADVANCE for expiry tests. It may never disable an expiry check:
 * expiry is always decided by comparing two instants, never by a feature flag.
 */
export interface Clock {
  now(): Date;
  readonly kind: 'real' | 'scenario';
}

export const systemClock: Clock = {
  now: () => new Date(),
  kind: 'real',
};

export interface ScenarioClock extends Clock {
  readonly kind: 'scenario';
  advanceBy(ms: number): void;
  set(instant: Date): void;
}

export function scenarioClock(start: Date): ScenarioClock {
  let current = start.getTime();
  return {
    kind: 'scenario',
    now: () => new Date(current),
    advanceBy: (ms) => {
      if (!Number.isFinite(ms)) throw new Error('advanceBy needs a finite number of milliseconds');
      current += ms;
    },
    set: (instant) => {
      current = instant.getTime();
    },
  };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Expiry is EXCLUSIVE at the boundary: a quote whose expiry instant equals "now"
 * is expired. Stated once here so every caller agrees, and asserted by test T04.
 */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
