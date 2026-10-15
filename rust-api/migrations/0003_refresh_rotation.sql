ALTER TABLE auth_sessions
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  ADD COLUMN refresh_digest BYTEA,
  ADD COLUMN predecessor_digest BYTEA;
UPDATE auth_sessions SET refresh_digest = gen_random_bytes(32) WHERE state = 'active' AND refresh_digest IS NULL;

ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_active_digest_check
  CHECK ((state <> 'active') OR refresh_digest IS NOT NULL);
