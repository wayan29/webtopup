ALTER TABLE rewards
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN image_url TEXT,
  ADD COLUMN category TEXT NOT NULL DEFAULT '',
  ADD COLUMN status BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE point_ledger
  ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'redeem'
    CHECK (transaction_type IN ('earn', 'redeem', 'admin_adjustment')),
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN related_transaction TEXT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX point_ledger_created_at_idx ON point_ledger (created_at DESC, id DESC);
CREATE INDEX point_ledger_type_created_at_idx ON point_ledger (transaction_type, created_at DESC, id DESC);

INSERT INTO site_settings(key, value)
VALUES
  ('points_per_transaction', '100'::jsonb),
  ('point_value_rate', '1'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- users.points is the single authoritative points balance. Legacy SQL claim state is
-- reconciled into users before user_points is retired; rows without a matching user
-- remain visible as an explicit migration failure rather than silently disappearing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_points p
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.user_ref)
  ) THEN
    RAISE EXCEPTION 'user_points contains references without a matching users row';
  END IF;
END $$;

UPDATE users u
SET points = p.balance, updated_at = now()
FROM user_points p
WHERE u.id::text = p.user_ref AND u.points = 0 AND p.balance <> 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_points p JOIN users u ON u.id::text = p.user_ref
    WHERE u.points <> p.balance
  ) THEN
    RAISE EXCEPTION 'users.points conflicts with user_points; reconcile authoritative balances before migration';
  END IF;
END $$;

DROP TABLE user_points;
