-- A bill's payee can carry an Alipay account; then the bill is paid for real.
-- Otherwise approving it sets the money aside (reserved in the pocket) until the
-- student pays through the payee's own channel and marks it paid.
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS payout_identity text;
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS payout_name text;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS set_aside_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS set_aside_account_id uuid;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS set_aside_at timestamptz;
