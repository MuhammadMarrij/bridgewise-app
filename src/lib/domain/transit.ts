/**
 * Transit-time assumptions, used only where a provider publishes none.
 *
 * Almost no provider commits to an arrival time in a public comparison, so a
 * deadline-aware tool has three choices: refuse to answer, invent a number, or
 * assume conservatively and say so. The first is useless and the second is
 * dishonest, so we do the third.
 *
 * These are OUR assumptions, labelled as such wherever they reach the user. They
 * are deliberately pessimistic: a student who arrives early loses nothing, and a
 * student who arrives late can lose their enrolment.
 */
export type ProviderClass = 'bank' | 'moneyTransferProvider' | 'unknown';

export interface TransitAssumption {
  readonly hours: number;
  readonly label: string;
  readonly basis: string;
  /** True when this came from us, not from the provider. */
  readonly assumed: boolean;
}

/**
 * Conservative upper bounds in business terms. A bank wire crossing a corridor
 * is routinely quoted by banks themselves as up to five working days; money
 * transfer operators are faster but still settle in days when a transfer is
 * reviewed. We take the slow end of each.
 */
const CONSERVATIVE_HOURS: Record<ProviderClass, number> = {
  bank: 5 * 24,
  moneyTransferProvider: 3 * 24,
  unknown: 5 * 24,
};

export function classifyProvider(type: string | undefined): ProviderClass {
  if (type === 'bank') return 'bank';
  if (type === 'moneyTransferProvider') return 'moneyTransferProvider';
  return 'unknown';
}

/**
 * The transit time to plan against.
 *
 * When the provider published an estimate we use it and mark it not assumed.
 * Otherwise we use the conservative bound for its class and say plainly that we
 * assumed it, so the student knows which numbers to verify before relying on them.
 */
export function transitFor(
  publishedHours: number | null | undefined,
  providerType: string | undefined,
): TransitAssumption {
  if (typeof publishedHours === 'number' && publishedHours > 0) {
    return {
      hours: publishedHours,
      label: `${formatDuration(publishedHours)} (provider estimate)`,
      basis: 'Published by the provider in its own quote.',
      assumed: false,
    };
  }
  const cls = classifyProvider(providerType);
  const hours = CONSERVATIVE_HOURS[cls];
  return {
    hours,
    label: `up to ${formatDuration(hours)} (our conservative assumption)`,
    basis:
      cls === 'bank'
        ? 'This provider publishes no arrival time. We assume the slow end of a cross-border bank wire. Confirm with the bank before relying on it.'
        : 'This provider publishes no arrival time. We assume the slow end for a money transfer operator. Confirm with the provider before relying on it.',
    assumed: true,
  };
}

export function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
