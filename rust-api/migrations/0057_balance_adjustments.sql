CREATE TABLE user_balance_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('add','subtract')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 300),
  balance_before BIGINT NOT NULL CHECK (balance_before >= 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_balance_adjustments_user_created_idx ON user_balance_adjustments(user_id,created_at DESC);
