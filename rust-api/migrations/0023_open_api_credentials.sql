CREATE TABLE open_api_credentials (
  member_code TEXT PRIMARY KEY,
  api_key TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  ref_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
