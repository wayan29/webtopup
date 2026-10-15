-- Actual settings/content routes share transactionally locked revisions and frozen replies.
CREATE TABLE content_revisions (domain TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0));
INSERT INTO content_revisions(domain) VALUES ('settings'),('sliders');
CREATE TABLE content_mutation_replies (
 actor UUID NOT NULL REFERENCES users(id), operation TEXT NOT NULL, key TEXT NOT NULL,
 digest TEXT NOT NULL, status INTEGER NOT NULL, response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(actor,operation,key)
);
CREATE TABLE content_sliders (
 id UUID PRIMARY KEY, name TEXT NOT NULL, image TEXT NOT NULL, link TEXT NOT NULL DEFAULT '',
 status BOOLEAN NOT NULL DEFAULT false, lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','archived')),
 sort_order BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ, archived_by UUID REFERENCES users(id)
);
CREATE INDEX content_sliders_current_order ON content_sliders(sort_order,id) WHERE lifecycle='active';
-- Articles share the managed-cover reference contract; slugs stay unique across drafts.
CREATE TABLE content_articles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 title TEXT NOT NULL,
 slug TEXT NOT NULL UNIQUE,
 excerpt TEXT NOT NULL,
 content TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'Umum',
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
 image TEXT NOT NULL DEFAULT '',
 created_by UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_articles_public_order ON content_articles(created_at DESC) WHERE status='published';

-- Flash sales own their product rows so stock/sold transitions stay atomic with the sale window.
CREATE TABLE content_flash_sales (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 start_date TIMESTAMPTZ NOT NULL,
 end_date TIMESTAMPTZ NOT NULL CHECK (end_date > start_date),
 is_active BOOLEAN NOT NULL DEFAULT true,
 banner TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE content_flash_products (
 flash_sale_id UUID NOT NULL REFERENCES content_flash_sales(id) ON DELETE CASCADE,
 product_id UUID NOT NULL REFERENCES products(id),
 discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage','fixed')),
 discount_value BIGINT NOT NULL CHECK (discount_value > 0),
 stock BIGINT NOT NULL CHECK (stock >= 1),
 sold_count BIGINT NOT NULL DEFAULT 0 CHECK (sold_count >= 0 AND sold_count <= stock),
 PRIMARY KEY (flash_sale_id, product_id)
);
CREATE INDEX content_flash_sales_active_window ON content_flash_sales(start_date) WHERE is_active;
CREATE INDEX content_flash_products_product ON content_flash_products(product_id);
