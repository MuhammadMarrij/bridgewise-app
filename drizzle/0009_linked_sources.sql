-- Linked funding sources: bank cards, mobile wallets (Alipay, WeChat Pay) and
-- bank accounts (CCB, ICBC, BOC ...). Only what a bank may keep is stored: a
-- network token, the brand and the last four digits. The full card number and
-- the security code never reach the database.
CREATE TABLE "linked_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "last4" text,
  "brand" text,
  "currency" text NOT NULL,
  "holder" text,
  "expiry" text,
  "token" text NOT NULL,
  "connector_mode" text NOT NULL DEFAULT 'sandbox',
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "linked_kind_known" CHECK ("kind" IN ('card','wallet','bank')),
  CONSTRAINT "linked_status_known" CHECK ("status" IN ('ACTIVE','REMOVED')),
  CONSTRAINT "linked_last4_shape" CHECK ("last4" IS NULL OR "last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE INDEX "linked_session_idx" ON "linked_sources" ("session_id");
--> statement-breakpoint
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wtx_kind_known";
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wtx_kind_known"
  CHECK ("kind" IN ('topup','convert_out','convert_in','bill','send','spend','opening','withdraw'));
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "linked_source_id" uuid REFERENCES "linked_sources" ("id");
--> statement-breakpoint
ALTER TABLE "action_proposals" DROP CONSTRAINT IF EXISTS "proposal_kind_known";
--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "proposal_kind_known"
  CHECK ("kind" IN ('convert','pay_bill','send','rate_alert','budget','withdraw'));
