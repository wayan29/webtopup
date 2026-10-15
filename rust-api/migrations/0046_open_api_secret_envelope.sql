ALTER TABLE users ADD COLUMN member_code TEXT UNIQUE;
ALTER TABLE open_api_credentials
  ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN secret_nonce BYTEA,
  ADD COLUMN secret_ciphertext BYTEA;

-- Digest-only rows cannot satisfy the partner's plaintext-secret MD5 protocol.
-- Revoke them rather than silently accepting incompatible signatures; reissue after
-- member_code has been backfilled from authoritative account records.
UPDATE open_api_credentials
SET active = false, secret_nonce = NULL, secret_ciphertext = NULL;
