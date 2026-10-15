CREATE TABLE promo_giveaways (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 created_by UUID NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 participant_filter TEXT NOT NULL CHECK (participant_filter IN ('members','emails')),
 emails JSONB NOT NULL DEFAULT '[]'::jsonb,
 winner_count BIGINT NOT NULL CHECK (winner_count > 0),
 total_pool BIGINT NOT NULL CHECK (total_pool > 0),
 min_amount BIGINT NOT NULL CHECK (min_amount >= 0),
 max_amount BIGINT NOT NULL CHECK (max_amount >= min_amount),
 seed TEXT NOT NULL,
 participant_count BIGINT NOT NULL CHECK (participant_count >= 0),
 status TEXT NOT NULL CHECK (status IN ('completed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX promo_giveaways_created ON promo_giveaways(created_at DESC,id DESC);
CREATE TABLE promo_giveaway_winners (
 giveaway_id UUID NOT NULL REFERENCES promo_giveaways(id),
 user_id UUID NOT NULL REFERENCES users(id),
 amount BIGINT NOT NULL CHECK(amount >= 0),
 position BIGINT NOT NULL CHECK(position > 0),
 balance_after BIGINT NOT NULL,
 points_after BIGINT NOT NULL,
 PRIMARY KEY(giveaway_id,user_id),
 UNIQUE(giveaway_id,position)
);
CREATE TABLE promo_giveaway_claims (
 actor_id UUID NOT NULL REFERENCES users(id),
 idempotency_key TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 giveaway_id UUID NOT NULL UNIQUE REFERENCES promo_giveaways(id),
 response JSONB NOT NULL,
 response_status INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,idempotency_key)
);
CREATE INDEX promo_giveaway_winners_user ON promo_giveaway_winners(user_id,giveaway_id);
