-- Managed publication is journaled before touching the public filesystem. References and
-- deletion share the asset-row lock; only covers are eligible for destructive deletion.
ALTER TABLE managed_assets ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE managed_assets ADD COLUMN state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','deleting','deleted'));
ALTER TABLE managed_assets ADD COLUMN metadata JSONB;
ALTER TABLE managed_assets ADD COLUMN acquisition_fence BIGINT NOT NULL DEFAULT 0;
CREATE TABLE managed_asset_journal (
 id UUID PRIMARY KEY,
 operation TEXT NOT NULL CHECK (operation IN ('publish','delete')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed')),
 payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ
);
CREATE INDEX managed_asset_journal_pending ON managed_asset_journal(created_at) WHERE status='pending';
