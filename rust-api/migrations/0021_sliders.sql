CREATE TABLE sliders (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  status BOOLEAN NOT NULL DEFAULT false,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sliders_active_order_unique ON sliders (sort_order) WHERE lifecycle = 'active';
