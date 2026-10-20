-- F3 inbound remittance: allow the double-entry journal to record an inbound
-- credit that is not backed by an outbound transfer. The two new entries sum to
-- zero per currency: student_account +X, inbound_remittance -X.

ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_bucket_known";
--> statement-breakpoint
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_bucket_known"
  CHECK ("bucket" IN ('student_account','fx_clearing','fee','beneficiary','inbound_remittance'));
--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "transfer_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "inbound_remittance_id" uuid;
--> statement-breakpoint
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_inbound_fk"
  FOREIGN KEY ("inbound_remittance_id") REFERENCES "inbound_remittances" ("id");
