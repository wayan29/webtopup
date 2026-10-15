ALTER TABLE point_ledger DROP CONSTRAINT IF EXISTS point_ledger_user_ref_claim_key_key;
ALTER TABLE point_ledger DROP CONSTRAINT IF EXISTS point_ledger_reward_claim_key;
ALTER TABLE point_ledger ADD CONSTRAINT point_ledger_reward_claim_key UNIQUE (reward_id, claim_key);
