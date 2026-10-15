CREATE TABLE seller_callbacks (
  channel TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel, ref_id)
);
