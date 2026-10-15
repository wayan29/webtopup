ALTER TABLE users
  ADD COLUMN two_factor_secret BYTEA,
  ADD COLUMN permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE auth_sessions
  ADD COLUMN security_generation INTEGER NOT NULL DEFAULT 0 CHECK (security_generation >= 0);
