ALTER TABLE auth_sessions
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
