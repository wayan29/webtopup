-- Open API credentials are bound to SQL identities and queried by API key/member code.
-- Keep lookup indexes aligned with the credential and transaction ownership contract.
ALTER TABLE open_api_credentials
  ADD CONSTRAINT open_api_credentials_secret_envelope_pair
    CHECK ((secret_nonce IS NULL) = (secret_ciphertext IS NULL)),
  ADD CONSTRAINT open_api_credentials_secret_nonce_length
    CHECK (secret_nonce IS NULL OR octet_length(secret_nonce) = 24),
  ADD CONSTRAINT open_api_credentials_secret_ciphertext_length
    CHECK (secret_ciphertext IS NULL OR octet_length(secret_ciphertext) >= 16);

CREATE UNIQUE INDEX open_api_credentials_user_id_idx
  ON open_api_credentials(user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX financial_transactions_open_api_user_created_idx
  ON financial_transactions(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX financial_transactions_open_api_partner_ref_idx
  ON financial_transactions(user_id, partner_ref)
  WHERE partner_ref IS NOT NULL;
