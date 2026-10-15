ALTER TABLE products ADD COLUMN stock INTEGER CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE products ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN opens_at TIME;
ALTER TABLE products ADD COLUMN closes_at TIME;

CREATE TABLE guest_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL,
  product_code TEXT NOT NULL,
  price BIGINT NOT NULL CHECK (price > 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
  buyer_user_id UUID REFERENCES users(id),
  provider_ref TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
