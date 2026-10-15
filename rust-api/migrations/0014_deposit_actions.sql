ALTER TABLE deposits ADD COLUMN user_id UUID REFERENCES users(id);
ALTER TABLE deposits ADD COLUMN amount BIGINT CHECK (amount IS NULL OR amount > 0);
ALTER TABLE deposits ADD COLUMN admin_fee BIGINT NOT NULL DEFAULT 0 CHECK (admin_fee >= 0);
ALTER TABLE deposits ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'refunded'));
ALTER TABLE deposits ADD COLUMN assigned_to UUID REFERENCES users(id);
ALTER TABLE deposits ADD COLUMN action_key TEXT UNIQUE;
ALTER TABLE deposits ADD CONSTRAINT deposits_net_positive CHECK (amount IS NULL OR amount > admin_fee);

CREATE TABLE financial_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  subject_id UUID NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  operation_key TEXT NOT NULL UNIQUE
);
