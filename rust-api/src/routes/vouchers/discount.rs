//! Checkout discount vouchers (multi-slot codes) separate from balance top-up vouchers.

use axum::response::Response;
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::status_message;

#[derive(Clone, Debug)]
pub struct AppliedDiscount {
    pub voucher_id: Uuid,
    pub code: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub discount_amount: i64,
    pub final_price: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountValidateResponse {
    pub valid: bool,
    pub code: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub discount_amount: i64,
    pub base_amount: i64,
    pub final_amount: i64,
    pub remaining_uses: i64,
    pub message: String,
}

pub fn compute_discount_amount(
    base_amount: i64,
    discount_type: &str,
    discount_value: i64,
    max_discount: i64,
    min_purchase: i64,
) -> Result<i64, &'static str> {
    if base_amount < 1 {
        return Err("Nominal belanja tidak valid");
    }
    if min_purchase > 0 && base_amount < min_purchase {
        return Err("Belum memenuhi minimum belanja voucher");
    }
    let raw = if discount_type == "percentage" {
        if discount_value < 1 || discount_value > 100 {
            return Err("Persen diskon tidak valid");
        }
        (base_amount * discount_value) / 100
    } else if discount_type == "fixed" {
        if discount_value < 1 {
            return Err("Nominal diskon tidak valid");
        }
        discount_value.min(base_amount)
    } else {
        return Err("Tipe diskon tidak valid");
    };
    let capped = if max_discount > 0 { raw.min(max_discount) } else { raw };
    let amount = capped.min(base_amount - 1).max(0);
    if amount < 1 && base_amount > 1 {
        return Err("Diskon tidak menghasilkan potongan");
    }
    Ok(if base_amount == 1 { capped.min(1) } else { amount })
}

#[derive(Clone, Debug, Default)]
pub struct DiscountProductContext {
    pub product_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub operator_id: Option<Uuid>,
}

fn scope_allows(row: &sqlx::postgres::PgRow, ctx: &DiscountProductContext) -> bool {
    let products: Vec<Uuid> = row.get("product_ids");
    let categories: Vec<Uuid> = row.get("category_ids");
    let operators: Vec<Uuid> = row.get("operator_ids");
    if products.is_empty() && categories.is_empty() && operators.is_empty() {
        return true;
    }
    ctx.product_id.is_some_and(|id| products.contains(&id))
        || ctx.category_id.is_some_and(|id| categories.contains(&id))
        || ctx.operator_id.is_some_and(|id| operators.contains(&id))
}

async fn load_discount(
    pool: &PgPool,
    code: &str,
    base_amount: i64,
    user_id: Option<Uuid>,
    ctx: &DiscountProductContext,
) -> Result<DiscountValidateResponse, Response> {
    let row = sqlx::query("SELECT * FROM vouchers WHERE code=$1 AND kind='discount' AND NOT is_archived")
        .bind(code)
        .fetch_optional(pool)
        .await
        .map_err(|_| status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Voucher store unavailable"))?
        .ok_or_else(|| status_message(axum::http::StatusCode::BAD_REQUEST, "Kode voucher diskon tidak ditemukan"))?;
    let now: chrono::DateTime<chrono::Utc> = chrono::Utc::now();
    let starts: Option<chrono::DateTime<chrono::Utc>> = row.get("starts_at");
    let expires: Option<chrono::DateTime<chrono::Utc>> = row.get("expires_at");
    if starts.is_some_and(|at| at > now) || expires.is_some_and(|at| at < now) {
        return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Voucher diskon belum aktif atau sudah kedaluwarsa"));
    }
    if !scope_allows(&row, ctx) {
        return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Voucher diskon tidak berlaku untuk produk ini"));
    }
    let max_uses: i64 = row.get("max_uses");
    let used_count: i64 = row.get("used_count");
    if used_count >= max_uses {
        return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Kuota voucher diskon sudah habis"));
    }
    let one_per_user: bool = row.get("one_per_user");
    let redeemed_by: Vec<Uuid> = row.get("redeemed_by_users");
    if one_per_user && user_id.is_some_and(|id| redeemed_by.contains(&id)) {
        return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Anda sudah memakai voucher ini"));
    }
    let discount_type: String = row.get("discount_type");
    let discount_value: i64 = row.get("discount_value");
    let discount_amount = compute_discount_amount(base_amount, &discount_type, discount_value, row.get("max_discount"), row.get("min_purchase"))
        .map_err(|message| status_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    Ok(DiscountValidateResponse {
        valid: true,
        code: code.to_string(),
        discount_type,
        discount_value,
        discount_amount,
        base_amount,
        final_amount: (base_amount - discount_amount).max(0),
        remaining_uses: (max_uses - used_count).max(0),
        message: "Voucher diskon valid".to_string(),
    })
}

pub async fn validate_discount_code(
    pool: &PgPool,
    code: &str,
    base_amount: i64,
    user_id: Option<Uuid>,
    product_ctx: &DiscountProductContext,
) -> Result<DiscountValidateResponse, Response> {
    load_discount(pool, code, base_amount, user_id, product_ctx).await
}

/// Consume a voucher within the caller's transaction. Rolling back `conn` releases
/// both the usage slot and per-user redemption marker.
pub async fn consume_discount_voucher_sql(
    conn: &mut sqlx::PgConnection,
    code: &str,
    base_amount: i64,
    user_id: Option<Uuid>,
    product_ctx: &DiscountProductContext,
) -> Result<AppliedDiscount, Response> {
    let row = sqlx::query("SELECT * FROM vouchers WHERE code=$1 AND kind='discount' AND NOT is_archived FOR UPDATE")
        .bind(code).fetch_optional(&mut *conn).await
        .map_err(|_| status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Voucher store unavailable"))?
        .ok_or_else(|| status_message(axum::http::StatusCode::BAD_REQUEST, "Kode voucher diskon tidak ditemukan"))?;
    let now = chrono::Utc::now();
    let starts: Option<chrono::DateTime<chrono::Utc>> = row.get("starts_at");
    let expires: Option<chrono::DateTime<chrono::Utc>> = row.get("expires_at");
    if starts.is_some_and(|at| at > now) || expires.is_some_and(|at| at < now) {
        return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Voucher diskon belum aktif atau sudah kedaluwarsa"));
    }
    if !scope_allows(&row, product_ctx) { return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Voucher diskon tidak berlaku untuk produk ini")); }
    let max_uses: i64 = row.get("max_uses");
    let used: i64 = row.get("used_count");
    if used >= max_uses { return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Kuota voucher diskon sudah habis")); }
    let one_per_user: bool = row.get("one_per_user");
    let mut redeemed: Vec<Uuid> = row.get("redeemed_by_users");
    if one_per_user && user_id.is_some_and(|id| redeemed.contains(&id)) { return Err(status_message(axum::http::StatusCode::BAD_REQUEST, "Anda sudah memakai voucher ini")); }
    let discount_type: String = row.get("discount_type");
    let discount_value: i64 = row.get("discount_value");
    let discount_amount = compute_discount_amount(base_amount, &discount_type, discount_value, row.get("max_discount"), row.get("min_purchase"))
        .map_err(|message| status_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    if one_per_user { if let Some(id) = user_id { redeemed.push(id); } }
    let id: Uuid = row.get("id");
    sqlx::query("UPDATE vouchers SET used_count=used_count+1, redeemed_by_users=$2, is_redeemed=(used_count+1>=max_uses), updated_at=now() WHERE id=$1 AND used_count<max_uses")
        .bind(id).bind(&redeemed).execute(&mut *conn).await
        .map_err(|_| status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))?;
    Ok(AppliedDiscount { voucher_id:id, code:code.to_owned(), discount_type, discount_value, discount_amount, final_price:(base_amount-discount_amount).max(0) })
}
