ALTER TABLE webhook_events ADD COLUMN refunded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_status_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check CHECK (status IN ('success', 'failed'));

CREATE TABLE point_awards (
  source TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  points BIGINT NOT NULL CHECK (points > 0)
);
