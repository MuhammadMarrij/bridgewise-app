-- Defect: quotes_expiry_after_creation compared expires_at (which is derived from
-- the SESSION clock, and is the scenario instant in a demo session) against
-- created_at (which is real server time). Those are two different clocks and
-- comparing them is meaningless: a scenario pinned in the past failed the check.
--
-- The quote now carries its own quoted_at in the SAME clock as its expiry, and the
-- constraint compares like with like. created_at stays, as the real-time record of
-- when the row was written, and the evidence bundle can show both.

ALTER TABLE "quotes" DROP CONSTRAINT IF EXISTS "quotes_expiry_after_creation";
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "quoted_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "quotes" SET "quoted_at" = "created_at" WHERE "quoted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "quoted_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_expiry_after_quoted_at" CHECK ("expires_at" > "quoted_at");
--> statement-breakpoint
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_delivery_after_quoted_at" CHECK ("delivered_at" >= "quoted_at");
