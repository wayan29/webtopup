CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'refunded')),
  payload_digest TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, ref_id)
);
