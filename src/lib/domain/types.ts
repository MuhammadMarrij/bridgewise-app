import type { Currency } from './money';
import type { SettlementSpec } from './calendar';

/** A fictional remittance route. Every field is synthetic; none is a market quote. */
export interface SimulatedRoute {
  readonly id: string;
  readonly providerLabel: string;
  readonly from: Currency;
  readonly to: Currency;
  /** TO units per one FROM unit, as an exact decimal string. */
  readonly rate: string;
  /**
   * The synthetic mid-market reference rate (TO per FROM), used only to show the
   * FX margin as a SEPARATE, informational cost. It never changes the debit.
   */
  readonly midRate?: string;
  /**
   * Known fixed fee in the SOURCE currency, as a decimal string. The recipient
   * fee is separate ({@link receivingFee}); when THAT is unknown the route is
   * `unknown_recipient_fee` and is priced for display only, never recommended.
   */
  readonly sourceFee: string;
  /**
   * Known fixed receiving-side fee in the TARGET currency, waived/zero in this
   * simulation. Always disclosed; a null value is an unknown fee that disqualifies.
   */
  readonly receivingFee?: string;
  /** Hours from quote time until the provider delivers (fixed_hours routes). */
  readonly deliveryHours: number;
  /** Further hours until the institution posts the credit (fixed_hours routes). */
  readonly postingHours: number;
  /** Optional business-day settlement; defaults to fixed_hours above. */
  readonly settlement?: SettlementSpec;
  /** Minutes a quote from this route stays valid. */
  readonly quoteTtlMinutes: number;
  /**
   * Whether every fee on this route is known. A route with an unknown recipient
   * or intermediary fee cannot be offered as a lowest-all-in-cost recommendation.
   */
  readonly feeCompleteness: 'complete' | 'unknown_recipient_fee';
  /** When fees are incomplete, the human reason. */
  readonly incompleteFeeNote?: string;
  readonly sourceKind: 'simulated';
  /** False when the provider publishes no arrival estimate. Never guessed. */
  readonly arrivalPublished?: boolean;
  /** 'bank' or 'moneyTransferProvider', as the provider is classified. */
  readonly providerType?: string;
  /** True when rate and fee came from a live provider quote, not a table. */
  readonly realQuote?: boolean;
}

export type ExclusionReason =
  | 'MISSES_DEADLINE'
  | 'ARRIVAL_NOT_PUBLISHED'
  | 'QUOTE_EXPIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'BREACHES_RESERVE'
  | 'INCOMPLETE_FEES'
  | 'UNSUPPORTED_CORRIDOR'
  | 'CURRENCY_MISMATCH';

/** A costed candidate. Amounts are minor units; the rate stays a decimal string. */
export interface RoutePricing {
  readonly routeId: string;
  readonly providerLabel: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly rate: string;
  readonly midRate: string | null;
  readonly targetMinor: bigint;
  readonly principalMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalDebitMinor: bigint;
  /** Principal that would be needed at the mid-market rate (source currency). */
  readonly principalAtMidMinor: bigint | null;
  /**
   * Source principal paid above the mid-market conversion, i.e. the FX margin
   * that is embedded in the quoted rate. Informational; never an added charge.
   */
  readonly fxMarginCostMinor: bigint | null;
  /** Explicit fee + embedded FX margin, i.e. total cost beyond the mid-market rate. */
  readonly allInCostBeyondMidMinor: bigint | null;
  /** Embedded margin in basis points relative to the mid-market rate. */
  readonly fxMarginBasisPoints: number | null;
  readonly receivingFeeMinor: bigint;
  readonly deliveredAt: Date;
  readonly postedAt: Date;
  readonly expiresAt: Date;
  readonly settlementKind: 'fixed_hours' | 'business_days';
  readonly feeCompleteness: SimulatedRoute['feeCompleteness'];
  readonly sourceKind: 'simulated';
}

export interface Candidate {
  readonly pricing: RoutePricing;
  readonly feasible: boolean;
  readonly exclusions: readonly ExclusionReason[];
  /** True but non-disqualifying facts, e.g. the provider publishes no arrival time. */
  readonly warnings: readonly ExclusionReason[];
  /** Source-currency balance remaining after this route's debit and all committed outflows. */
  readonly projectedLowMinor: bigint;
  /** How far the projected low sits above the reserve. Negative means a breach. */
  readonly reserveMarginMinor: bigint;
}

export interface PlanResult {
  readonly outcome: 'PLAN_READY' | 'NO_FEASIBLE_PLAN';
  readonly recommended: Candidate | null;
  readonly alternatives: readonly Candidate[];
  readonly excluded: readonly Candidate[];
  /** Set only when no route is feasible: the smallest shortfall across candidates. */
  readonly shortfallMinor: bigint | null;
  readonly asOf: Date;
}

export type TransferStatus =
  | 'SUBMITTED'
  | 'DELIVERED'
  | 'POSTED'
  | 'REJECTED'
  | 'FAILED'
  | 'UNKNOWN_OUTCOME'
  | 'NEEDS_REVIEW';

export type PlanState = 'PLANNED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';

/* ------------------------------------------------------------------ staging */

/** One dated leg of a staged payment plan. */
export interface InstallmentSpec {
  /** 1-based position in the schedule. */
  readonly sequence: number;
  readonly routeId: string;
  /** Target-currency amount this leg delivers. */
  readonly targetMinor: bigint;
  /** Earliest instant the leg may be dispatched (e.g. after an inbound remittance). */
  readonly dispatchOnOrAfter: Date;
  readonly expectedPostingAt: Date;
  /** Source-currency debit expected at this leg (principal + fee). */
  readonly expectedTotalDebitMinor: bigint;
  /** Which certain inbound event unlocks this leg, if any. */
  readonly fundedByLabel: string | null;
}

/** A deterministic, feasible schedule of dated installments. */
export interface PaymentScheduleSpec {
  readonly feasible: boolean;
  readonly installments: readonly InstallmentSpec[];
  /** Total target covered by the schedule. */
  readonly totalTargetMinor: bigint;
  /** Remaining target the schedule could not cover (0 when feasible). */
  readonly residualShortfallMinor: bigint;
  /** The reserve is never breached at any point. */
  readonly reservePreserved: boolean;
}

/* --------------------------------------------------------- inbound remittance */

export type InboundRemittanceStatus = 'EXPECTED' | 'SENT' | 'RECEIVED' | 'AVAILABLE' | 'UNCLAIMED';
