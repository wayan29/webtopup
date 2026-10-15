CREATE TABLE notification_user_states (
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, notification_id, fingerprint)
);
CREATE INDEX notification_user_states_actor_id_idx ON notification_user_states(actor_id, notification_id);
