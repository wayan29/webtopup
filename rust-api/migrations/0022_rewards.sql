CREATE TABLE rewards (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  points_required BIGINT NOT NULL CHECK (points_required > 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE point_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_ref TEXT NOT NULL,
  reward_id BIGINT REFERENCES rewards(id),
  claim_key TEXT NOT NULL,
  points BIGINT NOT NULL,
  UNIQUE (user_ref, claim_key)
);

CREATE TABLE user_points (
  user_ref TEXT PRIMARY KEY,
  balance BIGINT NOT NULL
);
