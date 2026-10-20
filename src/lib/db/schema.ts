/**
 * The domain schema.
 *
 * Money is stored as bigint minor units. Rates are stored as exact decimal text.
 * No float, no numeric-to-Number conversion, anywhere in this file.
 *
 * Every row that belongs to a student is scoped by `session_id`, and every query
 * in the application filters on it. Ownership is never taken from a request body
 * or from a model tool argument.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

const minor = (name: string) => bigint(name, { mode: 'bigint' });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** An isolated synthetic workspace. One per judge, per demo run. */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Only the HASH of the cookie token is stored, so a database dump cannot be
  // replayed as a login. The token itself exists only in the user's cookie.
  tokenHash: text('token_hash').notNull(),
  scenarioVersion: text('scenario_version').notNull(),
  clockKind: text('clock_kind').notNull(), // 'real' | 'scenario'
  scenarioNow: instant('scenario_now'),
  createdAt: instant('created_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
}, (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash)]);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  currency: text('currency').notNull(),
  balanceMinor: minor('balance_minor').notNull(),
  // Funds committed to an in-flight transfer. Never negative, never above balance;
  // both invariants are enforced by CHECK constraints in the migration.
  reservedMinor: minor('reserved_minor').notNull().default(sql`0`),
  version: integer('version').notNull().default(0),
}, (t) => [index('accounts_session_idx').on(t.sessionId)]);

export const beneficiaries = pgTable('beneficiaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  reference: text('reference').notNull(),
  currency: text('currency').notNull(),
  // Bumped on any edit. A plan binds the version it was built from, so editing a
  // beneficiary invalidates every approval that referenced the old one.
  version: integer('version').notNull().default(0),
}, (t) => [index('beneficiaries_session_idx').on(t.sessionId)]);

export const obligations = pgTable('obligations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  beneficiaryId: uuid('beneficiary_id').notNull().references(() => beneficiaries.id),
  description: text('description').notNull(),
  targetMinor: minor('target_minor').notNull(),
  currency: text('currency').notNull(),
  deadlineAt: instant('deadline_at').notNull(),
  deadlineTimezone: text('deadline_timezone').notNull(),
  /** Untouchable living funds, in the FUNDING currency. */
  reserveMinor: minor('reserve_minor').notNull(),
  reserveCurrency: text('reserve_currency').notNull(),
  confirmedAt: instant('confirmed_at'),
  /** When BridgeWise sent the payment out of its book. Not the university's confirmation. */
  paidAt: instant('paid_at'),
  paidProposalId: uuid('paid_proposal_id'),
  version: integer('version').notNull().default(0),
}, (t) => [index('obligations_session_idx').on(t.sessionId)]);

/** Dated commitments and inflows that shape the liquidity timeline. */
export const cashFlowEvents = pgTable('cash_flow_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  currency: text('currency').notNull(),
  direction: text('direction').notNull(), // 'inflow' | 'outflow'
  amountMinor: minor('amount_minor').notNull(),
  occursAt: instant('occurs_at').notNull(),
  // An uncertain inflow (a scholarship that may not land) is NOT available funds.
  // It is carried for display and excluded from the feasibility calculation.
  certain: boolean('certain').notNull().default(true),
  /** Set when this row represents the obligation itself, so it is never counted twice. */
  obligationId: uuid('obligation_id').references(() => obligations.id, { onDelete: 'cascade' }),
}, (t) => [index('cash_flow_session_idx').on(t.sessionId)]);

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  routeId: text('route_id').notNull(),
  providerLabel: text('provider_label').notNull(),
  sourceCurrency: text('source_currency').notNull(),
  targetCurrency: text('target_currency').notNull(),
  targetMinor: minor('target_minor').notNull(),
  principalMinor: minor('principal_minor').notNull(),
  feeMinor: minor('fee_minor').notNull(),
  totalDebitMinor: minor('total_debit_minor').notNull(),
  /** Exact decimal text. Never parsed into a float. */
  rate: text('rate').notNull(),
  /** The session clock instant this quote was priced at: scenario or real. */
  quotedAt: instant('quoted_at').notNull(),
  deliveredAt: instant('delivered_at').notNull(),
  postedAt: instant('posted_at').notNull(),
  expiresAt: instant('expires_at').notNull(),
  feeCompleteness: text('fee_completeness').notNull(),
  sourceKind: text('source_kind').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [index('quotes_session_idx').on(t.sessionId)]);

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  obligationId: uuid('obligation_id').notNull().references(() => obligations.id),
  sourceAccountId: uuid('source_account_id').notNull().references(() => accounts.id),
  beneficiaryId: uuid('beneficiary_id').notNull().references(() => beneficiaries.id),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  /** The immutable canonical terms. Written once; never updated. */
  termsJson: jsonb('terms_json').notNull(),
  /** SHA-256 over the canonical serialisation of termsJson. */
  termsHash: text('terms_hash').notNull(),
  state: text('state').notNull(), // PlanState
  expiresAt: instant('expires_at').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  cancelledAt: instant('cancelled_at'),
}, (t) => [
  index('plans_session_idx').on(t.sessionId),
  index('plans_obligation_idx').on(t.obligationId),
]);

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => plans.id),
  /** Must equal the plan's hash at execution time, or the approval is void. */
  termsHash: text('terms_hash').notNull(),
  /** Only the hash of the one-use nonce is stored. */
  nonceHash: text('nonce_hash').notNull(),
  approvedAt: instant('approved_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
  consumedAt: instant('consumed_at'),
}, (t) => [
  // At most one approval row per plan: a second approval cannot be minted to
  // authorise a plan that already has one.
  uniqueIndex('approvals_plan_key').on(t.planId),
]);

export const transfers = pgTable('transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  // One transfer per plan, enforced by the database. A fresh idempotency key
  // cannot be used to pay the same plan twice.
  planId: uuid('plan_id').notNull().references(() => plans.id),
  idempotencyKey: text('idempotency_key').notNull(),
  /** Hash of the request body, so a reused key with a changed payload conflicts. */
  requestHash: text('request_hash').notNull(),
  status: text('status').notNull(), // TransferStatus
  sourceCurrency: text('source_currency').notNull(),
  targetCurrency: text('target_currency').notNull(),
  debitMinor: minor('debit_minor').notNull(),
  creditMinor: minor('credit_minor').notNull(),
  /** The simulator's own id for this transfer, once it has accepted one. */
  externalReference: text('external_reference'),
  failureReason: text('failure_reason'),
  createdAt: instant('created_at').notNull().defaultNow(),
  submittedAt: instant('submitted_at'),
  deliveredAt: instant('delivered_at'),
  postedAt: instant('posted_at'),
}, (t) => [
  uniqueIndex('transfers_plan_key').on(t.planId),
  uniqueIndex('transfers_session_idem_key').on(t.sessionId, t.idempotencyKey),
  index('transfers_session_idx').on(t.sessionId),
]);

/**
 * Immutable double-entry journal. Entries for one transfer sum to zero
 * PER CURRENCY. GBP and USD values are never added together to prove balance.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable for an inbound-remittance credit, which has no outbound transfer.
  transferId: uuid('transfer_id').references(() => transfers.id),
  inboundRemittanceId: uuid('inbound_remittance_id'),
  /** Set for wallet conversions and bill payments executed from a proposal. */
  proposalId: uuid('proposal_id'),
  bucket: text('bucket').notNull(), // student_account | fx_clearing | fee | beneficiary | inbound_remittance
  accountId: uuid('account_id').references(() => accounts.id),
  currency: text('currency').notNull(),
  signedMinor: minor('signed_minor').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  index('ledger_transfer_idx').on(t.transferId),
  index('ledger_inbound_idx').on(t.inboundRemittanceId),
]);

/**
 * How much of an obligation a settled transfer actually credited. Derived from
 * settlement only; never supplied by the browser, and never written for a
 * transfer that has not been POSTED.
 */
export const obligationAllocations = pgTable('obligation_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  obligationId: uuid('obligation_id').notNull().references(() => obligations.id),
  transferId: uuid('transfer_id').notNull().references(() => transfers.id),
  creditedMinor: minor('credited_minor').notNull(),
  currency: text('currency').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('allocations_transfer_key').on(t.transferId),
  index('allocations_obligation_idx').on(t.obligationId),
]);

/**
 * The dispatch outbox. A row is written inside the SAME transaction as the debit,
 * so a committed debit always has a dispatch intent and a rolled-back one has
 * neither. Drained after commit; drainable again on any status read.
 */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferId: uuid('transfer_id').notNull().references(() => transfers.id),
  state: text('state').notNull(), // PENDING | SENT | FAILED
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: instant('created_at').notNull().defaultNow(),
  processedAt: instant('processed_at'),
}, (t) => [uniqueIndex('outbox_transfer_key').on(t.transferId)]);

/**
 * Append-only from the application's point of view, and now tamper-EVIDENT:
 * each event stores the hash of the previous one and its own hash, so a single
 * altered row breaks the chain and a verifier can detect it. This is not
 * tamper-proof against a database administrator (a honest limitation stated in
 * the security report), but it makes any silent edit detectable.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  correlationId: text('correlation_id').notNull(),
  type: text('type').notNull(),
  actor: text('actor').notNull(), // user | system | model
  outcome: text('outcome').notNull(), // allowed | denied | failed
  reason: text('reason'),
  /** Safe structured evidence only. No secrets, no cookies, no personal data. */
  payload: jsonb('payload').notNull(),
  /** Hash of the previous event in this session's chain; 'GENESIS' for the first. */
  prevHash: text('prev_hash'),
  /** sha256 over prev_hash and the canonical event fields. */
  entryHash: text('entry_hash'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('audit_session_seq_key').on(t.sessionId, t.seq),
  index('audit_session_idx').on(t.sessionId),
]);

/**
 * An inbound remittance the student is EXPECTING (family support, a scholarship
 * or a refund). It is not spendable until the simulated provider confirms it and
 * the student releases it, at which point it is credited to the funding account
 * through the same double-entry ledger. A displayed "expected" transfer is never
 * counted as money before it is available.
 */
export const inboundRemittances = pgTable('inbound_remittances', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  /** Account that will be credited on release. */
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  label: text('label').notNull(),
  senderLabel: text('sender_label').notNull(),
  currency: text('currency').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  /** EXPECTED → SENT → RECEIVED → AVAILABLE; UNCLAIMED if it never completes. */
  status: text('status').notNull().default('EXPECTED'),
  /** When the simulated provider says the funds will be available. */
  expectedAvailableAt: instant('expected_available_at').notNull(),
  creditedAt: instant('credited_at'),
  transferId: uuid('transfer_id').references(() => transfers.id),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [index('inbound_remittance_session_idx').on(t.sessionId)]);

/** A staged-payment schedule for an obligation. One per obligation. */
export const paymentSchedules = pgTable('payment_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  obligationId: uuid('obligation_id').notNull().references(() => obligations.id),
  /** PROPOSED → ACTIVE → COMPLETE; ABANDONED if it is superseded. */
  status: text('status').notNull().default('PROPOSED'),
  totalTargetMinor: minor('total_target_minor').notNull(),
  residualShortfallMinor: minor('residual_shortfall_minor').notNull().default(0n),
  reservePreserved: boolean('reserve_preserved').notNull().default(true),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_schedules_obligation_key').on(t.obligationId),
  index('payment_schedules_session_idx').on(t.sessionId),
]);

/**
 * One dated leg of a staged schedule. Each leg is executed through the EXISTING
 * plan → approve → confirm path with a fresh quote at execution time; this table
 * never creates its own money path.
 */
export const installments = pgTable('installments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  scheduleId: uuid('schedule_id').notNull().references(() => paymentSchedules.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  routeId: text('route_id').notNull(),
  /** PLANNED → PLAN_CREATED → EXECUTED → POSTED; SKIPPED if the leg is abandoned. */
  status: text('status').notNull().default('PLANNED'),
  targetMinor: minor('target_minor').notNull(),
  expectedDebitMinor: minor('expected_debit_minor').notNull(),
  dispatchOnOrAfter: instant('dispatch_on_or_after').notNull(),
  expectedPostingAt: instant('expected_posting_at').notNull(),
  fundedByLabel: text('funded_by_label'),
  planId: uuid('plan_id').references(() => plans.id),
  transferId: uuid('transfer_id').references(() => transfers.id),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('installments_schedule_seq_key').on(t.scheduleId, t.sequence),
  index('installments_session_idx').on(t.sessionId),
]);

/** A record of each bounded model turn, for the evaluation evidence. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(), // live | stub
  modelName: text('model_name'),
  status: text('status').notNull(),
  toolCalls: integer('tool_calls').notNull().default(0),
  latencyMs: integer('latency_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  errorClass: text('error_class'),
  trace: jsonb('trace').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [index('agent_runs_session_idx').on(t.sessionId)]);

/**
 * The simulator's OWN store, deliberately separate from the application's tables.
 * It is the stand-in for a provider: the application learns a transfer's fate by
 * asking this store, never by assuming its own optimistic write was the truth.
 */
export const simulatorTransfers = pgTable('simulator_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The provider-side idempotency key. A resend returns the original record. */
  clientKey: text('client_key').notNull(),
  payloadHash: text('payload_hash').notNull(),
  status: text('status').notNull(), // ACCEPTED | DELIVERED | POSTED | REJECTED
  sourceCurrency: text('source_currency').notNull(),
  targetCurrency: text('target_currency').notNull(),
  debitMinor: minor('debit_minor').notNull(),
  creditMinor: minor('credit_minor').notNull(),
  beneficiaryReference: text('beneficiary_reference').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  deliveredAt: instant('delivered_at'),
  postedAt: instant('posted_at'),
  rejectedReason: text('rejected_reason'),
}, (t) => [uniqueIndex('simulator_client_key') .on(t.clientKey)]);

/* ---------------------------------------------------------- wallet + agent */

/**
 * Something the agent (or the student) wants to do with money. Nothing happens
 * until the student approves these exact terms, identified by their hash.
 */
export const actionProposals = pgTable('action_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // convert | pay_bill | send | rate_alert | budget
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  termsJson: jsonb('terms_json').notNull(),
  termsHash: text('terms_hash').notNull(),
  status: text('status').notNull().default('PENDING'),
  proposedBy: text('proposed_by').notNull(), // agent | user
  createdAt: instant('created_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
  decidedAt: instant('decided_at'),
  resultJson: jsonb('result_json'),
}, (t) => [index('proposals_session_idx').on(t.sessionId, t.createdAt)]);

export const rateAlerts = pgTable('rate_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  base: text('base').notNull(),
  quote: text('quote').notNull(),
  direction: text('direction').notNull(), // above | below
  threshold: text('threshold').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  firedAt: instant('fired_at'),
});

export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  currency: text('currency').notNull(),
  monthlyLimitMinor: minor('monthly_limit_minor').notNull(),
  spentMinor: minor('spent_minor').notNull().default(sql`0`),
}, (t) => [uniqueIndex('budgets_session_category_key').on(t.sessionId, t.category)]);

/* ------------------------------------------------------------- statement */

/** One movement on a pocket, as the student reads it. Written with the ledger. */
export const walletTransactions = pgTable('wallet_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // topup | convert_out | convert_in | bill | send | spend | opening
  description: text('description').notNull(),
  category: text('category').notNull().default('other'),
  currency: text('currency').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  balanceAfterMinor: minor('balance_after_minor').notNull(),
  counterparty: text('counterparty'),
  proposalId: uuid('proposal_id'),
  idempotencyKey: text('idempotency_key'),
  linkedSourceId: uuid('linked_source_id'),
  reference: text('reference'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [index('wtx_session_time_idx').on(t.sessionId, t.createdAt)]);

export const recipients = pgTable('recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  relationship: text('relationship').notNull().default('other'),
  country: text('country').notNull(),
  currency: text('currency').notNull(),
  accountLabel: text('account_label').notNull(),
  rail: text('rail').notNull().default('none'), // alipay | none
  payoutIdentity: text('payout_identity'),
  payoutName: text('payout_name'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** A card, mobile wallet or bank account linked to the student's wallet. */
export const linkedSources = pgTable('linked_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // card | wallet | bank
  provider: text('provider').notNull(), // visa | mastercard | unionpay | alipay | wechatpay | ccb | icbc | boc ...
  label: text('label').notNull(),
  last4: text('last4'),
  brand: text('brand'),
  currency: text('currency').notNull(),
  holder: text('holder'),
  expiry: text('expiry'),
  token: text('token').notNull(),
  payoutIdentity: text('payout_identity'),
  connectorMode: text('connector_mode').notNull().default('sandbox'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** A student's login. Owns exactly one wallet workspace (session_id). */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  createdAt: instant('created_at').notNull().defaultNow(),
  lastLoginAt: instant('last_login_at'),
});

export const creditProgress = pgTable('credit_progress', {
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  stepId: text('step_id').notNull(),
  doneAt: instant('done_at').notNull().defaultNow(),
});

export const externalPayments = pgTable('external_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  outTradeNo: text('out_trade_no').notNull(),
  currency: text('currency').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  status: text('status').notNull().default('PENDING'),
  providerRef: text('provider_ref'),
  createdAt: instant('created_at').notNull().defaultNow(),
  settledAt: instant('settled_at'),
});

/** A money movement that left through a provider. proposal_id is the idempotency key. */
export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  proposalId: uuid('proposal_id').notNull().unique(),
  provider: text('provider').notNull(),
  currency: text('currency').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  payee: text('payee').notNull(),
  status: text('status').notNull(),
  providerRef: text('provider_ref'),
  createdAt: instant('created_at').notNull().defaultNow(),
});
