CREATE TABLE managed_assets (
  path TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE asset_references (
  path TEXT NOT NULL REFERENCES managed_assets(path),
  resource TEXT NOT NULL,
  PRIMARY KEY (path, resource)
);
