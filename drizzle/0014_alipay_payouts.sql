-- Real payouts over Alipay's transfer API (alipay.fund.trans.uni.transfer).
-- A recipient or a linked wallet can be paid only when we hold the Alipay
-- account (mobile or email) and the real name Alipay checks it against.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS rail text NOT NULL DEFAULT 'none';
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS payout_identity text;
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS payout_name text;
ALTER TABLE linked_sources ADD COLUMN IF NOT EXISTS payout_identity text;

-- The provider's own reference, shown when the student opens a statement line.
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference text;

-- One row per money movement that left through a provider. The proposal id is
-- the provider's idempotency key, so a retried approval can never pay twice.
CREATE TABLE IF NOT EXISTS payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL UNIQUE,
  provider text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  payee text NOT NULL,
  status text NOT NULL,
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
