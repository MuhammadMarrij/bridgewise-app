-- A real wallet statement: one row per movement on a pocket, with the balance
-- after it, written in the same transaction as the ledger entries. The ledger
-- proves the books balance; the statement is what the student reads.
CREATE TABLE "wallet_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL DEFAULT 'other',
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "balance_after_minor" bigint NOT NULL,
  "counterparty" text,
  "proposal_id" uuid REFERENCES "action_proposals" ("id"),
  "idempotency_key" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wtx_kind_known" CHECK ("kind" IN ('topup','convert_out','convert_in','bill','send','spend','opening')),
  CONSTRAINT "wtx_amount_nonzero" CHECK ("amount_minor" <> 0),
  CONSTRAINT "wtx_balance_nonnegative" CHECK ("balance_after_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "wtx_session_time_idx" ON "wallet_transactions" ("session_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "wtx_session_idem_key" ON "wallet_transactions" ("session_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "relationship" text NOT NULL DEFAULT 'other',
  "country" text NOT NULL,
  "currency" text NOT NULL,
  "account_label" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "action_proposals" DROP CONSTRAINT IF EXISTS "proposal_kind_known";
--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "proposal_kind_known"
  CHECK ("kind" IN ('convert','pay_bill','send','rate_alert','budget'));
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_bucket_known";
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_bucket_known"
  CHECK ("bucket" IN ('student_account','fx_clearing','fee','beneficiary','inbound_remittance','merchant','funding'));
