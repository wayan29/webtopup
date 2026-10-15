CREATE TABLE vendor_prices (
  vendor TEXT NOT NULL,
  sku TEXT NOT NULL,
  cost BIGINT NOT NULL CHECK (cost >= 0),
  basic BIGINT NOT NULL CHECK (basic >= cost),
  gold BIGINT NOT NULL CHECK (gold >= cost),
  platinum BIGINT NOT NULL CHECK (platinum >= cost),
  PRIMARY KEY (vendor, sku)
);
