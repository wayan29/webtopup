-- Slider runtime contract on PostgreSQL.
--
-- content_sliders gains the per-row write revision that every slider transaction increments
-- alongside its domain writes. The public ETag keeps using the global content_revisions
-- ('sliders') revision; the per-row revision is the row-level change counter evidence.
ALTER TABLE content_sliders
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);

-- content_mutation_replies keeps its (actor, operation, key) primary key as the permanent
-- per-actor claim identity. The columns below own the claim lease lifecycle for /v2/sliders*
-- mutations: claim_token + lease_generation fence every transition, transaction_started_at is
-- the durable start fence after which a claim can never become retryable, and the candidate
-- recovery identifiers make an interrupted create provable without re-executing it.
-- status = 0 with the JSON null response is the in-progress sentinel; existing frozen replies
-- (settings) already carry a real status and default to the completed state.
ALTER TABLE content_mutation_replies
  ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'
    CHECK (state IN ('in_progress', 'retryable', 'completed')),
  ADD COLUMN claim_token TEXT NOT NULL DEFAULT '',
  ADD COLUMN lease_generation BIGINT NOT NULL DEFAULT 1 CHECK (lease_generation > 0),
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN transaction_started_at TIMESTAMPTZ,
  ADD COLUMN commit_unknown BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN start_fence_unknown BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN candidate_slider_id UUID,
  ADD COLUMN candidate_result_revision BIGINT,
  ADD COLUMN recovery_ids_stored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN result_revision BIGINT,
  ADD COLUMN completed_at TIMESTAMPTZ;

-- Lease takeover scans and commit-unknown reconciliation stay bounded, mirroring the former
-- claim-collection indexes (state+lease, commitUnknown) without TTL expiry.
CREATE INDEX content_mutation_replies_state_lease
  ON content_mutation_replies (state, lease_expires_at)
  WHERE state IN ('in_progress', 'retryable');
CREATE INDEX content_mutation_replies_commit_unknown
  ON content_mutation_replies (commit_unknown)
  WHERE commit_unknown;
