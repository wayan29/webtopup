CREATE TABLE report_snapshots (
  snapshot_date DATE PRIMARY KEY,
  omzet BIGINT NOT NULL,
  balance BIGINT NOT NULL,
  points BIGINT NOT NULL,
  success_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
