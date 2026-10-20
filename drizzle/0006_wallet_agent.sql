-- M1/M2: the wallet and the agent's action proposals.
--
-- The agent never moves money. It writes an action_proposal with exact terms and
-- a hash of them; only the student's approval executes it. Wallet conversions and
-- bill payments post to the same double-entry ledger as everything else, linked
-- here by proposal_id.

CREATE TABLE "action_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "terms_json" jsonb NOT NULL,
  "terms_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "proposed_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "result_json" jsonb,
  CONSTRAINT "proposal_kind_known" CHECK ("kind" IN ('convert','pay_bill','send','rate_alert','budget')),
  CONSTRAINT "proposal_status_known" CHECK ("status" IN ('PENDING','EXECUTED','DECLINED','EXPIRED','FAILED')),
  CONSTRAINT "proposal_by_known" CHECK ("proposed_by" IN ('agent','user'))
);
--> statement-breakpoint
CREATE INDEX "proposals_session_idx" ON "action_proposals" ("session_id", "created_at");
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "proposal_id" uuid REFERENCES "action_proposals" ("id");
--> statement-breakpoint
CREATE INDEX "ledger_proposal_idx" ON "ledger_entries" ("proposal_id");
--> statement-breakpoint
CREATE TABLE "rate_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "base" text NOT NULL,
  "quote" text NOT NULL,
  "direction" text NOT NULL,
  "threshold" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "fired_at" timestamp with time zone,
  CONSTRAINT "alert_direction_known" CHECK ("direction" IN ('above','below'))
);
--> statement-breakpoint
CREATE TABLE "budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "currency" text NOT NULL,
  "monthly_limit_minor" bigint NOT NULL,
  "spent_minor" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "budget_limit_positive" CHECK ("monthly_limit_minor" > 0),
  CONSTRAINT "budget_spent_nonnegative" CHECK ("spent_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_session_category_key" ON "budgets" ("session_id", "category");
