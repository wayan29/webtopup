CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id),
  reference TEXT NOT NULL UNIQUE
);

CREATE TABLE reference_counters (
  scope TEXT NOT NULL,
  date_wib DATE NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  PRIMARY KEY (scope, date_wib)
);
