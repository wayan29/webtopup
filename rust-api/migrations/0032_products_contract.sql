-- T12: product and validation-product contract; rows carry revision and validation config.
ALTER TABLE products
 ADD COLUMN validation JSONB NOT NULL DEFAULT '{"enabled":false}'::jsonb,
 ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX products_validation_current ON products(updated_at DESC, id)
 WHERE validation->>'enabled' = 'true'
   AND NOT COALESCE((validation->>'archived')::boolean, false);
CREATE INDEX products_category_order_idx ON products(category_id, sort_order, created_at, id);
