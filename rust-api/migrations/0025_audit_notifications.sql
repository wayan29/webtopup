CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'unauthorized')),
  correlation TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_states (
  notification_id TEXT PRIMARY KEY,
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);
