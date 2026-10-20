-- Financial invariants enforced by the database, not only by application code.
-- A bug in a service can still not produce a negative balance or an over-reservation.

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balance_nonnegative" CHECK ("balance_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_reserved_nonnegative" CHECK ("reserved_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_reserved_within_balance" CHECK ("reserved_minor" <= "balance_minor");
--> statement-breakpoint

ALTER TABLE "obligations"
  ADD CONSTRAINT "obligations_target_positive" CHECK ("target_minor" > 0);
--> statement-breakpoint
ALTER TABLE "obligations"
  ADD CONSTRAINT "obligations_reserve_nonnegative" CHECK ("reserve_minor" >= 0);
--> statement-breakpoint

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_amounts_positive"
  CHECK ("target_minor" > 0 AND "principal_minor" > 0 AND "fee_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_debit_is_principal_plus_fee"
  CHECK ("total_debit_minor" = "principal_minor" + "fee_minor");
--> statement-breakpoint
-- A quote may not be born already expired.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_expiry_after_creation" CHECK ("expires_at" > "created_at");
--> statement-breakpoint
-- The institution cannot post a credit before the provider delivers it.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_posting_after_delivery" CHECK ("posted_at" >= "delivered_at");
--> statement-breakpoint

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amounts_positive"
  CHECK ("debit_minor" > 0 AND "credit_minor" > 0);
--> statement-breakpoint
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_status_known"
  CHECK ("status" IN ('SUBMITTED','DELIVERED','POSTED','REJECTED','FAILED','UNKNOWN_OUTCOME','NEEDS_REVIEW'));
--> statement-breakpoint

ALTER TABLE "obligation_allocations"
  ADD CONSTRAINT "allocations_credited_positive" CHECK ("credited_minor" > 0);
--> statement-breakpoint

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_signed_nonzero" CHECK ("signed_minor" <> 0);
--> statement-breakpoint
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_bucket_known"
  CHECK ("bucket" IN ('student_account','fx_clearing','fee','beneficiary'));
--> statement-breakpoint

ALTER TABLE "cash_flow_events"
  ADD CONSTRAINT "cash_flow_direction_known" CHECK ("direction" IN ('inflow','outflow'));
--> statement-breakpoint
ALTER TABLE "cash_flow_events"
  ADD CONSTRAINT "cash_flow_amount_positive" CHECK ("amount_minor" > 0);
--> statement-breakpoint

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_actor_known" CHECK ("actor" IN ('user','system','model'));
--> statement-breakpoint
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_outcome_known" CHECK ("outcome" IN ('allowed','denied','failed'));
--> statement-breakpoint

ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_state_known" CHECK ("state" IN ('PENDING','SENT','FAILED'));
--> statement-breakpoint

ALTER TABLE "simulator_transfers"
  ADD CONSTRAINT "simulator_status_known"
  CHECK ("status" IN ('ACCEPTED','DELIVERED','POSTED','REJECTED'));
--> statement-breakpoint

-- Only the two currencies this release supports. An unsupported currency is
-- rejected rather than silently treated as two decimal places.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_supported" CHECK ("currency" IN ('GBP','USD'));
--> statement-breakpoint
ALTER TABLE "obligations"
  ADD CONSTRAINT "obligations_currency_supported" CHECK ("currency" IN ('GBP','USD'));
--> statement-breakpoint
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_currency_supported" CHECK ("currency" IN ('GBP','USD'));
