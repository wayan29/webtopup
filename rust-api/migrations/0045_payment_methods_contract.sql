-- T14: authoritative payment methods/categories and durable usage references.
CREATE TABLE payment_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  sort_order BIGINT NOT NULL DEFAULT 1 CHECK (sort_order >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_categories_name_unique UNIQUE (name)
);

CREATE UNIQUE INDEX payment_categories_slug_unique ON payment_categories(slug);

CREATE UNIQUE INDEX payment_categories_name_ci_key ON payment_categories(lower(name));

ALTER TABLE payment_methods
  ADD COLUMN category_id UUID REFERENCES payment_categories(id),
  ADD COLUMN account_number TEXT NOT NULL DEFAULT '',
  ADD COLUMN account_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN icon TEXT NOT NULL DEFAULT '',
  ADD COLUMN min_amount DOUBLE PRECISION NOT NULL DEFAULT 10000 CHECK (min_amount >= 0),
  ADD COLUMN max_amount DOUBLE PRECISION NOT NULL DEFAULT 5000000 CHECK (max_amount >= min_amount),
  ADD COLUMN admin_fee DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (admin_fee >= 0),
  ADD COLUMN admin_percent DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (admin_percent BETWEEN 0 AND 100),
  ADD COLUMN operational_start TEXT NOT NULL DEFAULT '00:00',
  ADD COLUMN operational_end TEXT NOT NULL DEFAULT '23:59',
  ADD COLUMN use_unique_code BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE payment_methods
  DROP CONSTRAINT payment_methods_name_key;

ALTER TABLE guest_orders
  ADD COLUMN payment_method_id UUID REFERENCES payment_methods(id);

CREATE INDEX payment_methods_category_idx ON payment_methods(category_id,status,name);
CREATE INDEX guest_orders_payment_method_idx ON guest_orders(payment_method_id);

CREATE TABLE payment_reference_allocations (
  reference TEXT PRIMARY KEY,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  date_wib DATE NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9999),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date_wib, sequence)
);
