-- F3 inbound remittance, F2 staged payments, F13 tamper-evident audit chain.

-- Tamper-evident audit chain. New events carry prev_hash + entry_hash; rows
-- written before this migration are a legacy prefix the verifier tolerates.
ALTER TABLE "audit_events" ADD COLUMN "prev_hash" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "entry_hash" text;
--> statement-breakpoint

-- Inbound remittances the student is expecting.
CREATE TABLE "inbound_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sender_label" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'EXPECTED' NOT NULL,
	"expected_available_at" timestamp with time zone NOT NULL,
	"credited_at" timestamp with time zone,
	"transfer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittance_currency_supported"
  CHECK ("currency" IN ('GBP','USD','EUR','AUD','CAD','CNY','AED','INR','PKR','JPY','KRW','KWD','BHD'));
--> statement-breakpoint
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittance_amount_positive" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittance_status_known"
  CHECK ("status" IN ('EXPECTED','SENT','RECEIVED','AVAILABLE','UNCLAIMED'));
--> statement-breakpoint
CREATE INDEX "inbound_remittance_session_idx" ON "inbound_remittances" ("session_id");
--> statement-breakpoint

-- Staged payment schedules.
CREATE TABLE "payment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"total_target_minor" bigint NOT NULL,
	"residual_shortfall_minor" bigint DEFAULT 0 NOT NULL,
	"reserve_preserved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_status_known"
  CHECK ("status" IN ('PROPOSED','ACTIVE','COMPLETE','ABANDONED'));
--> statement-breakpoint
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_target_positive" CHECK ("total_target_minor" > 0);
--> statement-breakpoint
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_shortfall_nonnegative" CHECK ("residual_shortfall_minor" >= 0);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_schedules_obligation_key" ON "payment_schedules" ("obligation_id");
--> statement-breakpoint
CREATE INDEX "payment_schedules_session_idx" ON "payment_schedules" ("session_id");
--> statement-breakpoint

-- Individual dated installments.
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"route_id" text NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"target_minor" bigint NOT NULL,
	"expected_debit_minor" bigint NOT NULL,
	"dispatch_on_or_after" timestamp with time zone NOT NULL,
	"expected_posting_at" timestamp with time zone NOT NULL,
	"funded_by_label" text,
	"plan_id" uuid,
	"transfer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_status_known"
  CHECK ("status" IN ('PLANNED','PLAN_CREATED','EXECUTED','POSTED','SKIPPED'));
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_amount_positive" CHECK ("target_minor" > 0 AND "expected_debit_minor" > 0);
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_posting_after_dispatch"
  CHECK ("expected_posting_at" >= "dispatch_on_or_after");
--> statement-breakpoint
CREATE UNIQUE INDEX "installments_schedule_seq_key" ON "installments" ("schedule_id", "sequence");
--> statement-breakpoint
CREATE INDEX "installments_session_idx" ON "installments" ("session_id");
--> statement-breakpoint

-- Foreign keys (added after the tables exist).
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittances_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittances_account_fk"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id");
--> statement-breakpoint
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_obligation_fk"
  FOREIGN KEY ("obligation_id") REFERENCES "obligations" ("id");
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_schedule_fk"
  FOREIGN KEY ("schedule_id") REFERENCES "payment_schedules" ("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_plan_fk"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id");
--> statement-breakpoint
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_transfer_fk"
  FOREIGN KEY ("transfer_id") REFERENCES "transfers" ("id");
--> statement-breakpoint
ALTER TABLE "inbound_remittances"
  ADD CONSTRAINT "inbound_remittances_transfer_fk"
  FOREIGN KEY ("transfer_id") REFERENCES "transfers" ("id");
