CREATE TABLE provider_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'ambiguous', 'sent')),
  lease_generation BIGINT NOT NULL DEFAULT 0,
  provider_result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
