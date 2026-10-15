CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  session_version INTEGER NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('member', 'staff')),
  state TEXT NOT NULL CHECK (state IN ('active', 'locked', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_active_user_idx
  ON auth_sessions (user_id)
  WHERE state = 'active';
