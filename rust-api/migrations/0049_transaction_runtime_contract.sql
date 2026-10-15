-- T34 member transaction fields are first-class SQL columns so routing and provider work
-- no longer depend on Mongo-shaped documents.
ALTER TABLE financial_transactions
  ADD COLUMN target TEXT NOT NULL DEFAULT '',
  ADD COLUMN server_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN source TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN discount_voucher_code TEXT,
  ADD COLUMN discount_amount BIGINT,
  ADD COLUMN base_amount BIGINT,
  ADD COLUMN provider_reference TEXT,
  ADD COLUMN provider_result JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE financial_checkout_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES financial_transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('voucher','points','flash_sale')),
  effect_key TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(effect_type,effect_key)
);
CREATE INDEX financial_transactions_target_idx ON financial_transactions(user_id,created_at DESC);
CREATE INDEX financial_status_events_transaction_idx ON financial_status_events(transaction_id,created_at DESC);
