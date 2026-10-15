use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    Conflict,
    Unavailable,
}

pub struct CatalogStore {
    pool: PgPool,
}
impl CatalogStore {
    /// Use the application's startup-managed pool; route code never opens a connection.
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn connect(database_url: &str) -> Result<Self, CatalogError> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(2))
            .connect(database_url)
            .await
            .map_err(|_| CatalogError::Unavailable)?;
        Ok(Self { pool })
    }

    pub async fn create_product(
        &self,
        category: &str,
        operator: &str,
        code: &str,
        name: &str,
    ) -> Result<i64, CatalogError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| CatalogError::Unavailable)?;
        let category_id = existing_or_insert(
            &mut tx,
            "SELECT id FROM categories WHERE slug = $1",
            "INSERT INTO categories (slug, name) VALUES ($1, $1) RETURNING id",
            category,
            None,
        )
        .await?;
        let operator_id = if let Some(id) = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM operators WHERE slug = $1 AND category_id = $2",
        )
        .bind(operator)
        .bind(category_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| CatalogError::Unavailable)?
        {
            id
        } else {
            sqlx::query_scalar(
                "INSERT INTO operators (category_id, slug, name) VALUES ($2, $1, $1) RETURNING id",
            )
            .bind(operator)
            .bind(category_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| CatalogError::Unavailable)?
        };
        let product_id: Result<i64, _> = sqlx::query_scalar("INSERT INTO products (code, name, operator_id, category_id, category, brand) VALUES ($1, $2, $3, $4, $5, $6) RETURNING product_id")
            .bind(code).bind(name).bind(operator_id).bind(category_id).bind(category).bind(operator).fetch_one(&mut *tx).await;
        let Ok(product_id) = product_id else {
            return Err(CatalogError::Conflict);
        };
        tx.commit().await.map_err(|_| CatalogError::Unavailable)?;
        Ok(product_id)
    }

    pub async fn delete_category(&self, slug: &str) -> Result<(), CatalogError> {
        let deleted = sqlx::query("DELETE FROM categories WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM operators WHERE operators.category_id = categories.id)")
            .bind(slug).execute(&self.pool).await.map_err(|_| CatalogError::Unavailable)?;
        if deleted.rows_affected() != 1 {
            return Err(CatalogError::Conflict);
        }
        Ok(())
    }

    pub async fn sync_vendor_price(
        &self,
        vendor: &str,
        sku: &str,
        cost: i64,
        margins: (f64, f64, f64),
    ) -> Result<(i64, i64, i64), CatalogError> {
        if cost < 0 {
            return Err(CatalogError::Conflict);
        }
        let price = |margin: f64| (cost as f64 * (1.0 + margin.max(0.0) / 100.0)).round() as i64;
        let prices = (price(margins.0), price(margins.1), price(margins.2));
        sqlx::query("INSERT INTO vendor_prices (vendor, sku, cost, basic, gold, platinum) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vendor, sku) DO UPDATE SET cost = EXCLUDED.cost, basic = EXCLUDED.basic, gold = EXCLUDED.gold, platinum = EXCLUDED.platinum")
            .bind(vendor).bind(sku).bind(cost).bind(prices.0).bind(prices.1).bind(prices.2).execute(&self.pool).await.map_err(|_| CatalogError::Unavailable)?;
        Ok(prices)
    }

    pub async fn create_payment_method(&self, name: &str) -> Result<Uuid, CatalogError> {
        sqlx::query_scalar("INSERT INTO payment_methods (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| CatalogError::Conflict)
    }

    pub async fn allocate_reference(
        &self,
        method_id: Uuid,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<String, CatalogError> {
        let wib = chrono::FixedOffset::east_opt(7 * 3600).ok_or(CatalogError::Unavailable)?;
        let local = now.with_timezone(&wib).date_naive();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| CatalogError::Unavailable)?;
        let method_exists = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM payment_methods WHERE id = $1 FOR KEY SHARE",
        )
        .bind(method_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| CatalogError::Unavailable)?
        .is_some();
        if !method_exists {
            return Err(CatalogError::Conflict);
        }
        let sequence: i64 = sqlx::query_scalar("INSERT INTO reference_counters (scope, date_wib, sequence) VALUES ('payment', $1, 1) ON CONFLICT (scope, date_wib) DO UPDATE SET sequence = reference_counters.sequence + 1 RETURNING sequence")
            .bind(local).fetch_one(&mut *tx).await.map_err(|_| CatalogError::Unavailable)?;
        if sequence > 9999 {
            return Err(CatalogError::Conflict);
        }
        let reference = format!("REF{}{:04}", local.format("%d%m%Y"), sequence);
        sqlx::query("INSERT INTO payment_reference_allocations (reference, payment_method_id, date_wib, sequence) VALUES ($1, $2, $3, $4)")
            .bind(&reference).bind(method_id).bind(local).bind(sequence).execute(&mut *tx).await.map_err(|_| CatalogError::Conflict)?;
        tx.commit().await.map_err(|_| CatalogError::Unavailable)?;
        Ok(reference)
    }

    pub async fn delete_payment_method(&self, method_id: Uuid) -> Result<(), CatalogError> {
        let deleted = sqlx::query("DELETE FROM payment_methods WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM deposits WHERE payment_method_id = $1) AND NOT EXISTS (SELECT 1 FROM guest_orders WHERE payment_method_id = $1) AND NOT EXISTS (SELECT 1 FROM payment_reference_allocations WHERE payment_method_id = $1)")
            .bind(method_id).execute(&self.pool).await.map_err(|_| CatalogError::Unavailable)?;
        if deleted.rows_affected() != 1 {
            return Err(CatalogError::Conflict);
        }
        Ok(())
    }
}

async fn existing_or_insert(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    select_sql: &str,
    insert_sql: &str,
    slug: &str,
    parent: Option<Uuid>,
) -> Result<Uuid, CatalogError> {
    if let Some(id) = sqlx::query_scalar(select_sql)
        .bind(slug)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| CatalogError::Unavailable)?
    {
        return Ok(id);
    }
    let mut query = sqlx::query_scalar(insert_sql).bind(slug);
    if let Some(parent) = parent {
        query = query.bind(parent);
    }
    query
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| CatalogError::Unavailable)
}
