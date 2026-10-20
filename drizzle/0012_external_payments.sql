-- Payments taken through a real external provider (Alipay sandbox, Stripe test
-- mode). The wallet is credited exactly once, only after the provider confirms,
-- keyed on out_trade_no.
CREATE TABLE "external_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "out_trade_no" text NOT NULL,
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "provider_ref" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "settled_at" timestamp with time zone,
  CONSTRAINT "extpay_provider_known" CHECK ("provider" IN ('alipay','stripe')),
  CONSTRAINT "extpay_status_known" CHECK ("status" IN ('PENDING','PAID','FAILED')),
  CONSTRAINT "extpay_amount_positive" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "extpay_trade_key" ON "external_payments" ("provider", "out_trade_no");
