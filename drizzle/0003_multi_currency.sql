-- Multi-currency support.
--
-- The first release deliberately limited balances, obligations and journal
-- entries to GBP and USD. Cross-border students fund tuition from many
-- corridors, including zero-decimal home currencies (PKR, JPY, KRW) and
-- three-decimal dinars (KWD, BHD). The money layer now scales by each
-- currency's exponent, so the database CHECK set is widened to match the
-- application registry in src/lib/domain/money.ts. The two MUST stay in lock
-- step: a currency that is accepted by one but not the other is a defect.
--
-- The supported set is intentionally fixed and is the same on every table that
-- stores a currency. An unsupported currency is still rejected, never silently
-- treated as two decimal places.

ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_currency_supported";
--> statement-breakpoint
ALTER TABLE "obligations" DROP CONSTRAINT IF EXISTS "obligations_currency_supported";
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_currency_supported";

--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_supported"
  CHECK ("currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
--> statement-breakpoint
ALTER TABLE "obligations"
  ADD CONSTRAINT "obligations_currency_supported"
  CHECK ("currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
--> statement-breakpoint
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_currency_supported"
  CHECK ("currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
--> statement-breakpoint
-- Cash flow forecasts and the simulator carry currencies too; constrain them
-- with the same fixed set so a forecast cannot name a currency that money
-- cannot be held in.
ALTER TABLE "cash_flow_events"
  ADD CONSTRAINT "cash_flow_currency_supported"
  CHECK ("currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
--> statement-breakpoint
ALTER TABLE "simulator_transfers"
  ADD CONSTRAINT "simulator_source_currency_supported"
  CHECK ("source_currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
--> statement-breakpoint
ALTER TABLE "simulator_transfers"
  ADD CONSTRAINT "simulator_target_currency_supported"
  CHECK ("target_currency" IN (
    'GBP','USD','EUR','AUD','CAD','CNY','AED','INR',
    'PKR','JPY','KRW','KWD','BHD'
  ));
