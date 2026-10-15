ALTER TABLE users
  ADD COLUMN security_generation INTEGER NOT NULL DEFAULT 0 CHECK (security_generation >= 0);
