CREATE TABLE idempotency_claims (
  key TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  response JSONB,
  completed_at TIMESTAMPTZ
);
