-- Runtime contract for the active guest transaction API. Keep full response snapshot so
-- public replay and legacy-shaped admin responses remain stable across deploys.
CREATE TABLE guest_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  target TEXT NOT NULL,
  server_id TEXT,
  whatsapp TEXT NOT NULL,
  email TEXT,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  admin_fee BIGINT NOT NULL DEFAULT 0 CHECK (admin_fee >= 0),
  unique_code BIGINT NOT NULL DEFAULT 0,
  total_amount BIGINT NOT NULL CHECK (total_amount >= 0),
  payment_status TEXT NOT NULL DEFAULT 'waiting_payment',
  transaction_status TEXT NOT NULL DEFAULT 'pending',
  expired_at TIMESTAMPTZ NOT NULL,
  provider_ref TEXT,
  vendor_trx_id TEXT,
  sn TEXT,
  paid_at TIMESTAMPTZ,
  status_updated_at TIMESTAMPTZ,
  provider_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  status_update_note TEXT,
  status_updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  discount_voucher_code TEXT,
  discount_amount BIGINT,
  base_amount BIGINT,
  flash_sale_id TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_response_status INTEGER,
  idempotency_response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (payment_status IN ('waiting_payment','paid','cancelled','expired')),
  CHECK (transaction_status IN ('pending','processing','success','failed','cancelled'))
);
CREATE INDEX guest_transactions_user_date ON guest_transactions(user_id,created_at DESC);
CREATE INDEX guest_transactions_status_date ON guest_transactions(payment_status,transaction_status,created_at DESC);
CREATE INDEX guest_transactions_whatsapp_invoice ON guest_transactions(whatsapp,invoice_number);
CREATE TABLE guest_checkout_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started','completed')),
  response_status INTEGER,
  response_body JSONB,
  transaction_id UUID REFERENCES guest_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE guest_transaction_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES guest_transactions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guest_status_events_transaction_idx ON guest_transaction_status_events(transaction_id,created_at DESC);
