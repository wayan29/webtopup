ALTER TABLE financial_transactions
  ADD COLUMN status_updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN status_updated_at TIMESTAMPTZ,
  ADD COLUMN status_update_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN vendor_trx_id TEXT,
  ADD COLUMN sn TEXT,
  ADD COLUMN message TEXT NOT NULL DEFAULT '',
  ADD COLUMN refunded_at TIMESTAMPTZ,
  ADD COLUMN refund_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN refunded_by UUID REFERENCES users(id) ON DELETE SET NULL;
