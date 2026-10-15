-- Complete the relational contract used by the Rust SQL authentication routes.
-- The earlier migrations retained only the first-generation session envelope.
ALTER TABLE users
  ADD COLUMN last_otp_counter BIGINT CHECK (last_otp_counter >= 0),
  ADD COLUMN two_factor_enrollment_completed_at TIMESTAMPTZ,
  ADD COLUMN two_factor_pending_secret BYTEA,
  ADD COLUMN two_factor_pending_expires_at TIMESTAMPTZ,
  ADD COLUMN phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN address TEXT NOT NULL DEFAULT '',
  ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN level TEXT NOT NULL DEFAULT 'member',
  ADD COLUMN preferences JSONB NOT NULL DEFAULT '{"emailNotifications":true,"smsNotifications":false,"showBalance":true,"uiTheme":"ember-premium"}'::jsonb;

UPDATE users
SET last_otp_counter = two_factor_last_counter
WHERE last_otp_counter IS NULL AND two_factor_last_counter IS NOT NULL;

ALTER TABLE users
  ALTER COLUMN security_generation TYPE BIGINT USING security_generation::BIGINT;

ALTER TABLE auth_sessions
  ALTER COLUMN generation TYPE BIGINT USING generation::BIGINT,
  ALTER COLUMN security_generation TYPE BIGINT USING security_generation::BIGINT;

ALTER TABLE auth_sessions
  ADD COLUMN role TEXT NOT NULL DEFAULT 'member',
  ADD COLUMN slot INTEGER NOT NULL DEFAULT 0 CHECK (slot >= 0),
  ADD COLUMN owns_slot BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN device_id TEXT NOT NULL DEFAULT 'Unknown device',
  ADD COLUMN user_agent TEXT NOT NULL DEFAULT '',
  ADD COLUMN ip_address TEXT NOT NULL DEFAULT '',
  ADD COLUMN remember_me BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN absolute_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 day'),
  ADD COLUMN idle_expires_at TIMESTAMPTZ,
  ADD COLUMN locked_at TIMESTAMPTZ,
  ADD COLUMN cleanup_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN recovery_digest BYTEA,
  ADD COLUMN rotation_key_id TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN predecessor JSONB,
  ADD COLUMN consumed_digests JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN unlock_password_attempts INTEGER NOT NULL DEFAULT 0 CHECK (unlock_password_attempts >= 0),
  ADD COLUMN unlock_otp_attempts INTEGER NOT NULL DEFAULT 0 CHECK (unlock_otp_attempts >= 0),
  ADD COLUMN step_up_attempts INTEGER NOT NULL DEFAULT 0 CHECK (step_up_attempts >= 0);

UPDATE auth_sessions AS session
SET role = users.role,
    recovery_digest = COALESCE(session.recovery_digest, gen_random_bytes(32)),
    absolute_expires_at = CASE
      WHEN users.role IN ('owner', 'admin', 'cs') THEN session.created_at + interval '8 hours'
      ELSE session.created_at + interval '1 day'
    END
FROM users
WHERE users.id = session.user_id;

ALTER TABLE auth_sessions
  ALTER COLUMN recovery_digest SET NOT NULL;

CREATE UNIQUE INDEX auth_sessions_owned_slot_unique
  ON auth_sessions(user_id, slot)
  WHERE owns_slot AND state IN ('active', 'locked');
CREATE INDEX auth_sessions_expiration_idx
  ON auth_sessions(absolute_expires_at)
  WHERE state IN ('active', 'locked');

CREATE TABLE auth_device_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  audience TEXT NOT NULL CHECK (audience IN ('member', 'staff')),
  role TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  security_generation BIGINT NOT NULL,
  two_factor_enabled BOOLEAN NOT NULL,
  remember_me BOOLEAN NOT NULL DEFAULT false,
  device TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  target_session_id UUID REFERENCES auth_sessions(id),
  result_ciphertext BYTEA
);
CREATE INDEX auth_device_challenges_expiration_idx ON auth_device_challenges(expires_at);

CREATE TABLE auth_factor_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  audience TEXT NOT NULL CHECK (audience IN ('member', 'staff')),
  session_version INTEGER NOT NULL,
  security_generation BIGINT NOT NULL,
  role TEXT NOT NULL,
  remember BOOLEAN NOT NULL DEFAULT false,
  device TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX auth_factor_challenges_expiration_idx ON auth_factor_challenges(expires_at);

CREATE TABLE auth_security_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  source_session_id UUID NOT NULL REFERENCES auth_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('two_factor_confirm', 'two_factor_disable')),
  proof_digest BYTEA NOT NULL,
  result_ciphertext BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source_session_id, operation)
);
CREATE INDEX auth_security_changes_expiration_idx ON auth_security_changes(expires_at);

CREATE TABLE auth_global_revocations (
  source_session_id UUID PRIMARY KEY REFERENCES auth_sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  source_session_version INTEGER NOT NULL,
  result_session_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_global_revocations_expiration_idx ON auth_global_revocations(expires_at);
