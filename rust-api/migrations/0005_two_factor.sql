ALTER TABLE users
  ADD COLUMN two_factor_last_counter BIGINT CHECK (two_factor_last_counter >= 0);
