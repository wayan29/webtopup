CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  normalized_email TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'cs', 'member')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
  session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_enrollment_required_at TIMESTAMPTZ,
  role_updated_at TIMESTAMPTZ NOT NULL,
  policy_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized_email)
);
