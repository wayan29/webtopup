CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    api_base_url TEXT NOT NULL DEFAULT '',
    config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    low_balance_threshold BIGINT NOT NULL DEFAULT 0 CHECK (low_balance_threshold >= 0),
    status BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_lower_idx ON vendors (lower(name));
CREATE TABLE vendor_health_snapshots (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE provider_pricelist (
    provider TEXT NOT NULL,
    sku TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, sku)
);
CREATE TABLE internal_provider_purchases (
    id UUID PRIMARY KEY,
    provider TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, ref_id)
);
CREATE INDEX internal_provider_purchases_recent ON internal_provider_purchases (provider, created_at DESC, id DESC);
