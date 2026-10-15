use super::utils::format_date_part;
use chrono::{Datelike, Local, Timelike};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::services::flash_sales::FlashSaleReservation;

pub(super) struct GuestProductRow {
    pub(super) id: Uuid,
    pub(super) code: String,
    pub(super) name: String,
    pub(super) price: Value,
    pub(super) status: bool,
    pub(super) category_id: Option<Uuid>,
    pub(super) category_name: String,
    pub(super) operator_id: Option<Uuid>,
    pub(super) operator_name: String,
    pub(super) product_type_id: Option<Uuid>,
    pub(super) validation: Value,
    pub(super) vendor_name: String,
    pub(super) vendor_sku: String,
}

pub(super) struct GuestPaymentCategory {
    pub(super) id: Uuid,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) status: String,
}

pub(super) struct GuestPaymentMethod {
    pub(super) id: Uuid,
    pub(super) status: String,
    pub(super) operational_start: String,
    pub(super) operational_end: String,
    pub(super) category_id: Option<Uuid>,
}

pub(super) async fn active_maintenance_message(pool: &sqlx::PgPool) -> Option<String> {
    let enabled: bool = sqlx::query_scalar("SELECT COALESCE((value #>> '{}')::boolean,false) FROM site_settings WHERE key='maintenanceMode'")
        .fetch_optional(pool).await.ok().flatten().unwrap_or(false);
    if !enabled { return None; }
    Some(sqlx::query_scalar::<_,String>("SELECT COALESCE(value #>> '{}','Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.') FROM site_settings WHERE key='maintenanceMessage'")
        .fetch_optional(pool).await.ok().flatten().unwrap_or_else(||"Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.".to_string()))
}

pub(super) async fn guest_checkout_enabled(pool: &sqlx::PgPool) -> bool {
    sqlx::query_scalar::<_,bool>("SELECT COALESCE((value #>> '{}')::boolean,true) FROM site_settings WHERE key='guestCheckoutEnabled'")
        .fetch_optional(pool).await.ok().flatten().unwrap_or(true)
}

pub(super) async fn resolve_payment_method(
    pool: &sqlx::PgPool,
    id: Uuid,
) -> Option<GuestPaymentMethod> {
    sqlx::query("SELECT id,status,operational_start,operational_end,category_id FROM payment_methods WHERE id=$1")
        .bind(id).fetch_optional(pool).await.ok().flatten().map(|row| GuestPaymentMethod {
            id: row.get("id"), status: row.get("status"),
            operational_start: row.get("operational_start"), operational_end: row.get("operational_end"),
            category_id: row.get("category_id"),
        })
}

pub(super) async fn resolve_payment_category(
    pool: &sqlx::PgPool,
    payment_method: &GuestPaymentMethod,
) -> Option<GuestPaymentCategory> {
    let id = payment_method.category_id?;
    sqlx::query("SELECT id,name,slug,status FROM payment_categories WHERE id=$1")
        .bind(id).fetch_optional(pool).await.ok().flatten().map(|row| GuestPaymentCategory {
            id: row.get("id"), name: row.get("name"), slug: row.get("slug"), status: row.get("status"),
        })
}

pub(super) fn is_bank_transfer_category(category: &GuestPaymentCategory) -> bool {
    let name = category.name.to_lowercase();
    let slug = category.slug.to_lowercase();
    name.contains("bank") || name.contains("transfer") || slug.contains("bank") || slug.contains("transfer")
}

pub(super) fn is_operational_now(start: &str, end: &str) -> bool {
    let Some(start_minutes) = time_to_minutes(start) else { return false; };
    let Some(end_minutes) = time_to_minutes(end) else { return false; };
    if start_minutes == end_minutes { return true; }
    let now = Local::now();
    let current_minutes = i64::from(now.hour() * 60 + now.minute());
    if start_minutes < end_minutes { current_minutes >= start_minutes && current_minutes <= end_minutes }
    else { current_minutes >= start_minutes || current_minutes <= end_minutes }
}

pub(super) fn product_price_for_level(product: &GuestProductRow, level: &str) -> i64 {
    let key = if matches!(level, "gold" | "platinum") { level } else { "basic" };
    product.price.get(key).and_then(Value::as_i64).filter(|value| *value > 0).unwrap_or(0)
}

pub(super) async fn product_purchase_issues(
    pool: &sqlx::PgPool,
    product: &GuestProductRow,
) -> Vec<String> {
    let mut issues = Vec::new();
    if product.category_id.map(|id| async_status_false(pool, "categories", id)).is_some() {
        if let Some(id) = product.category_id {
            if async_status_false(pool, "categories", id).await { issues.push("Kategori nonaktif".to_string()); }
        }
    } else if !product.category_name.trim().is_empty() && named_status_false(pool, "categories", &product.category_name).await {
        issues.push("Kategori nonaktif".to_string());
    }
    let operator_inactive = if let Some(id) = product.operator_id { async_status_false(pool, "operators", id).await }
        else { !product.operator_name.trim().is_empty() && named_status_false(pool, "operators", &product.operator_name).await };
    if operator_inactive { issues.push("Operator nonaktif".to_string()); }
    if let Some(id) = product.product_type_id {
        if async_status_false(pool, "product_types", id).await { issues.push("Jenis produk nonaktif".to_string()); }
    }
    issues
}

async fn async_status_false(pool: &sqlx::PgPool, table: &str, id: Uuid) -> bool {
    let query = match table {
        "categories" => "SELECT status FROM categories WHERE id=$1",
        "operators" => "SELECT status FROM operators WHERE id=$1",
        _ => "SELECT status FROM product_types WHERE id=$1",
    };
    sqlx::query_scalar::<_, bool>(query).bind(id).fetch_optional(pool).await.ok().flatten() == Some(false)
}

async fn named_status_false(pool: &sqlx::PgPool, table: &str, name: &str) -> bool {
    let query = match table {
        "categories" => "SELECT status FROM categories WHERE lower(name)=lower($1)",
        _ => "SELECT status FROM operators WHERE lower(name)=lower($1)",
    };
    sqlx::query_scalar::<_, bool>(query).bind(name).fetch_optional(pool).await.ok().flatten() == Some(false)
}

pub(super) async fn preview_flash_sale_price(
    pg_pool: &sqlx::PgPool,
    product_code: &str,
    base_price: i64,
) -> Result<Option<i64>, sqlx::Error> {
    Ok(crate::services::flash_sales::active_flash_offer(
        pg_pool,
        crate::services::flash_sales::FlashProductKey::Code(product_code),
    )
    .await?
    .map(|offer| {
        crate::services::flash_sales::flash_price(
            base_price,
            &offer.discount_type,
            offer.discount_value,
        )
    }))
}

pub(super) async fn reserve_flash_sale_stock(
    pg_pool: &sqlx::PgPool,
    product_code: &str,
    base_price: i64,
) -> Result<Option<FlashSaleReservation>, sqlx::Error> {
    crate::services::flash_sales::reserve_flash_sale_stock(
        pg_pool,
        crate::services::flash_sales::FlashProductKey::Code(product_code),
        base_price,
    )
    .await
}

/// Best-effort compensation: give a reserved flash-sale unit back (SQL).
pub(super) async fn release_flash_sale_stock(
    pg_pool: &sqlx::PgPool,
    reservation: &FlashSaleReservation,
) {
    if let Err(error) =
        crate::services::flash_sales::release_flash_sale_stock(pg_pool, reservation).await
    {
        eprintln!("Failed flash-sale stock release: {error}");
    }
}

pub(super) async fn generate_invoice_number(pool: &sqlx::PgPool) -> Result<String, ()> {
    let prefix = setting_string(pool, "invoicePrefix", "INV").await;
    let date_format = setting_string(pool, "invoiceDateFormat", "YYYYMMDD").await;
    let separator = setting_string(pool, "invoiceSeparator", "").await;
    let random_type = setting_string(pool, "invoiceRandomType", "alphanumeric").await;
    let raw_length = setting_i64(pool, "invoiceRandomLength", 8).await;
    let random_length = crate::services::identifier_integrity::safe_invoice_length(&random_type, raw_length);
    let now = Local::now();
    let date_part = format_date_part(&date_format, now.day(), now.month(), now.year());
    let random = if random_type == "numeric" {
        let mut rng = rand::thread_rng();
        (0..random_length).map(|_| rng.gen_range(0..=9).to_string()).collect::<String>()
    } else {
        rand::thread_rng().sample_iter(&Alphanumeric).take(random_length).map(char::from)
            .map(|character| character.to_ascii_uppercase()).collect::<String>()
    };
    Ok(vec![prefix, date_part, random].into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join(&separator))
}

async fn setting_string(pool: &sqlx::PgPool, key: &str, fallback: &str) -> String {
    sqlx::query_scalar::<_, Value>("SELECT value FROM site_settings WHERE key=$1")
        .bind(key).fetch_optional(pool).await.ok().flatten()
        .map(|value| value.as_str().map(ToOwned::to_owned).unwrap_or_else(|| value.to_string()))
        .map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).unwrap_or_else(|| fallback.to_string())
}

async fn setting_i64(pool: &sqlx::PgPool, key: &str, fallback: i64) -> i64 {
    sqlx::query_scalar::<_, Value>("SELECT value FROM site_settings WHERE key=$1")
        .bind(key).fetch_optional(pool).await.ok().flatten()
        .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|raw| raw.parse().ok())))
        .filter(|value| *value > 0).unwrap_or(fallback)
}

fn time_to_minutes(value: &str) -> Option<i64> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<i64>().ok()?;
    let minute = minute.parse::<i64>().ok()?;
    if (0..=23).contains(&hour) && (0..=59).contains(&minute) {
        Some(hour * 60 + minute)
    } else {
        None
    }
}
