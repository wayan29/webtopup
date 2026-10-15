ALTER TABLE deposits
  ADD COLUMN unique_code BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_amount BIGINT,
  ADD COLUMN assigned_at TIMESTAMPTZ,
  ADD COLUMN processed_at TIMESTAMPTZ,
  ADD COLUMN processing_note TEXT,
  ADD COLUMN processed_by UUID REFERENCES users(id),
  ADD COLUMN invoice_code TEXT,
  ADD COLUMN proof TEXT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT deposits_unique_code_nonnegative CHECK (unique_code >= 0),
  ADD CONSTRAINT deposits_total_amount_positive CHECK (total_amount IS NULL OR total_amount > 0);

CREATE INDEX deposits_user_created_idx ON deposits(user_id, created_at DESC);
CREATE INDEX deposits_status_created_idx ON deposits(status, created_at DESC);
CREATE INDEX deposits_assigned_status_idx ON deposits(assigned_to, status);
