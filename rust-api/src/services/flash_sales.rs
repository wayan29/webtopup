//! SQL flash-sale reads and guarded stock reservations.
//!
//! Flash sales live in `content_flash_sales`/`content_flash_products`. The
//! reservation helpers run a guarded `UPDATE ... WHERE sold_count < stock`, so a
//! concurrent checkout either wins exactly one unit or observes none, and they
//! accept any sqlx executor so a caller can join its own SQL transaction
//! (pass `&mut **tx` inside one) or use the shared pool for a single
//! self-contained statement.

use chrono::{DateTime, Utc};
use sqlx::{Postgres, Row};
use uuid::Uuid;

/// Product identity inside the SQL catalog: UUID primary key or unique code.
pub enum FlashProductKey<'a> {
    Id(Uuid),
    Code(&'a str),
}

impl FlashProductKey<'_> {
    fn binds(&self) -> (Option<Uuid>, Option<&str>) {
        match self {
            FlashProductKey::Id(id) => (Some(*id), None),
            FlashProductKey::Code(code) => (None, Some(*code)),
        }
    }
}

/// One reserved flash-sale unit; keep it to release the unit on rollback.
#[derive(Debug, Clone)]
pub struct FlashSaleReservation {
    pub flash_sale_id: Uuid,
    pub product_id: Uuid,
    pub price: i64,
}

/// Active-window flash offer for a product with remaining stock (no mutation).
#[derive(Debug, Clone)]
pub struct ActiveFlashOffer {
    pub flash_sale_id: Uuid,
    pub flash_sale_name: String,
    pub product_id: Uuid,
    pub end_date: DateTime<Utc>,
    pub base_price: i64,
    pub discount_type: String,
    pub discount_value: i64,
    pub stock: i64,
    pub sold_count: i64,
}

pub fn flash_price(base_price: i64, discount_type: &str, discount_value: i64) -> i64 {
    if discount_type == "percentage" {
        (base_price - (base_price * discount_value) / 100).max(0)
    } else {
        (base_price - discount_value).max(0)
    }
}

/// Legacy public-response timestamp format (`YYYY-MM-DDTHH:MM:SS.mmmZ`) kept for
/// flash-sale response compatibility.
pub fn mongoose_timestamp(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub async fn active_flash_offer<'e, E>(
    executor: E,
    product: FlashProductKey<'_>,
) -> sqlx::Result<Option<ActiveFlashOffer>>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let (product_id, product_code) = product.binds();
    let row = sqlx::query(
        "SELECT s.id AS flash_sale_id, s.name AS flash_sale_name, s.end_date, \
                fp.product_id, fp.discount_type, fp.discount_value, fp.stock, fp.sold_count, \
                p.price_basic \
           FROM content_flash_products fp \
           JOIN content_flash_sales s ON s.id = fp.flash_sale_id \
           JOIN products p ON p.id = fp.product_id \
          WHERE s.is_active \
            AND s.start_date <= now() \
            AND s.end_date >= now() \
            AND p.status \
            AND fp.sold_count < fp.stock \
            AND (($1::uuid IS NOT NULL AND p.id = $1::uuid) \
              OR ($2::text IS NOT NULL AND p.code = $2::text)) \
          ORDER BY s.start_date, s.id \
          LIMIT 1",
    )
    .bind(product_id)
    .bind(product_code)
    .fetch_optional(executor)
    .await?;
    Ok(row.map(|row| ActiveFlashOffer {
        flash_sale_id: row.get("flash_sale_id"),
        flash_sale_name: row.get("flash_sale_name"),
        product_id: row.get("product_id"),
        end_date: row.get("end_date"),
        base_price: row.get("base_price"),
        discount_type: row.get("discount_type"),
        discount_value: row.get("discount_value"),
        stock: row.get("stock"),
        sold_count: row.get("sold_count"),
    }))
}

/// Atomically increments `sold_count` while the active window and the
/// `sold_count < stock` guard hold. Returns `None` when the product has no
/// purchasable flash offer; the caller then proceeds at the normal price.
pub async fn reserve_flash_sale_stock<'e, E>(
    executor: E,
    product: FlashProductKey<'_>,
    base_price: i64,
) -> sqlx::Result<Option<FlashSaleReservation>>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let (product_id, product_code) = product.binds();
    let row = sqlx::query(
        "WITH target AS ( \
                SELECT fp.flash_sale_id, fp.product_id \
                  FROM content_flash_products fp \
                  JOIN content_flash_sales s ON s.id = fp.flash_sale_id \
                  JOIN products p ON p.id = fp.product_id \
                 WHERE s.is_active \
                   AND s.start_date <= now() \
                   AND s.end_date >= now() \
                   AND p.status \
                   AND fp.sold_count < fp.stock \
                   AND (($1::uuid IS NOT NULL AND p.id = $1::uuid) \
                     OR ($2::text IS NOT NULL AND p.code = $2::text)) \
                 ORDER BY s.start_date, s.id \
                 LIMIT 1 \
            ) \
            UPDATE content_flash_products AS fp \
               SET sold_count = fp.sold_count + 1 \
              FROM content_flash_sales AS s \
             WHERE s.id = fp.flash_sale_id \
               AND s.is_active \
               AND s.start_date <= now() \
               AND s.end_date >= now() \
               AND fp.sold_count < fp.stock \
               AND (fp.flash_sale_id, fp.product_id) = (SELECT flash_sale_id, product_id FROM target) \
         RETURNING s.id AS flash_sale_id, fp.product_id, fp.discount_type, fp.discount_value",
    )
    .bind(product_id)
    .bind(product_code)
    .fetch_optional(executor)
    .await?;
    Ok(row.map(|row| {
        let discount_type: String = row.get("discount_type");
        let discount_value: i64 = row.get("discount_value");
        FlashSaleReservation {
            flash_sale_id: row.get("flash_sale_id"),
            product_id: row.get("product_id"),
            price: flash_price(base_price, &discount_type, discount_value),
        }
    }))
}

/// Gives one reserved unit back (checkout rollback). The `sold_count > 0`
/// guard respects the table CHECK constraint.
pub async fn release_flash_sale_stock<'e, E>(
    executor: E,
    reservation: &FlashSaleReservation,
) -> sqlx::Result<u64>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let result = sqlx::query(
        "UPDATE content_flash_products \
            SET sold_count = sold_count - 1 \
          WHERE flash_sale_id = $1 \
            AND product_id = $2 \
            AND sold_count > 0",
    )
    .bind(reservation.flash_sale_id)
    .bind(reservation.product_id)
    .execute(executor)
    .await?;
    Ok(result.rows_affected())
}
