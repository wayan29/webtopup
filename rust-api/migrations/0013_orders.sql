ALTER TABLE products ADD COLUMN price_basic BIGINT NOT NULL DEFAULT 0 CHECK (price_basic >= 0);
ALTER TABLE products ADD COLUMN price_gold BIGINT NOT NULL DEFAULT 0 CHECK (price_gold >= 0);
ALTER TABLE products ADD COLUMN price_platinum BIGINT NOT NULL DEFAULT 0 CHECK (price_platinum >= 0);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL,
  product_code TEXT NOT NULL,
  level TEXT NOT NULL,
  price BIGINT NOT NULL CHECK (price > 0),
  provider_ref TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
