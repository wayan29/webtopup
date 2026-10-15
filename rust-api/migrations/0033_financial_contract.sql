-- Actual member/guest financial contract and fenced durable provider execution.
CREATE TABLE financial_transactions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_id TEXT NOT NULL UNIQUE,
 user_id UUID REFERENCES users(id), product_id UUID NOT NULL REFERENCES products(id),
 kind TEXT NOT NULL CHECK(kind IN ('member','guest')), amount BIGINT NOT NULL CHECK(amount >= 0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','success','failed')),
 refunded BOOLEAN NOT NULL DEFAULT false, partner_ref TEXT, snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,partner_ref)
);
CREATE INDEX financial_transactions_user_date ON financial_transactions(user_id,created_at DESC);
CREATE INDEX financial_transactions_status_date ON financial_transactions(status,updated_at);
CREATE TABLE financial_requests (
 actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
 response JSONB, response_status INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(actor,operation,key)
);
CREATE TABLE financial_provider_jobs (
 reference_id TEXT PRIMARY KEY REFERENCES financial_transactions(reference_id), snapshot JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ambiguous','done')),
 generation BIGINT NOT NULL DEFAULT 0, lease_token UUID, lease_until TIMESTAMPTZ,
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX financial_provider_jobs_due ON financial_provider_jobs(next_attempt_at) WHERE state <> 'done';
CREATE TABLE financial_status_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id UUID NOT NULL REFERENCES financial_transactions(id),
 status TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE VIEW financial_transaction_documents AS SELECT t.*,
 t.snapshot || jsonb_build_object('_id',t.id::text,'referenceId',t.reference_id,'user',t.user_id::text,'amount',t.amount,'status',t.status,'refunded',t.refunded,'createdAt',t.created_at,'updatedAt',t.updated_at) AS document
 FROM financial_transactions t;
