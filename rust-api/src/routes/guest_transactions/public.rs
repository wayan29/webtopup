use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rand::Rng;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    routes::auth,
    security::ErrorResponse,
    services::bot_protection::{
        cloudflare_turnstile_verifier, enforce_turnstile, kill_switch_enabled,
    },
    state::AppState,
};

use super::*;
use super::checkout::{
    active_maintenance_message, generate_invoice_number, guest_checkout_enabled,
    is_bank_transfer_category, is_operational_now, product_price_for_level,
    product_purchase_issues, resolve_payment_category, resolve_payment_method,
};
use super::idempotency::{digest_guest_idempotency_key, guest_checkout_digest, GuestCheckoutFingerprint};
use super::provider::{load_guest_product_by_code, product_validation_config};
use super::utils::{normalize_payload_text, normalize_phone};

const GUEST_CREATE_MESSAGE: &str = "Transaction created, please complete payment";

struct NormalizedGuestCreate {
    product_code: String,
    target: String,
    server_id: String,
    whatsapp: String,
    email: String,
    payment_method_id: String,
    use_flash_sale: bool,
    voucher_code: String,
}

impl NormalizedGuestCreate {
    fn from_payload(payload: &GuestCreatePayload) -> Self {
        Self {
            product_code: normalize_payload_text(payload.product_code.as_deref()),
            target: normalize_payload_text(payload.target.as_deref()),
            server_id: normalize_payload_text(payload.server_id.as_deref()),
            whatsapp: normalize_phone(payload.whatsapp.as_deref()),
            email: normalize_payload_text(payload.email.as_deref()),
            payment_method_id: normalize_payload_text(payload.payment_method_id.as_deref()),
            use_flash_sale: payload.use_flash_sale.unwrap_or(false),
            voucher_code: normalize_payload_text(payload.voucher_code.as_deref()).to_uppercase(),
        }
    }

    fn required_fields_present(&self) -> bool {
        !self.product_code.is_empty()
            && !self.target.is_empty()
            && !self.whatsapp.is_empty()
            && !self.payment_method_id.is_empty()
    }
}

pub async fn create_public(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<GuestCreatePayload>,
) -> Response {
    let raw_key = match crate::services::idempotency::require_idempotency_key(&headers) {
        Ok(Some(key)) => key,
        Ok(None) | Err(crate::services::idempotency::IdempotencyError::MissingKey) => {
            return crate::services::idempotency::IdempotencyError::MissingKey.into_response()
        }
        Err(error) => return error.into_response(),
    };
    if let Some(message) = active_maintenance_message(&state.pg_pool).await {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(OwnedErrorResponse { message })).into_response();
    }
    if !guest_checkout_enabled(&state.pg_pool).await {
        return status_message(StatusCode::FORBIDDEN, "Guest checkout sedang dinonaktifkan");
    }
    let normalized = NormalizedGuestCreate::from_payload(&payload);
    if !normalized.required_fields_present() {
        return status_message(StatusCode::BAD_REQUEST, "Missing required fields");
    }
    let member = auth::resolve_optional_member_access(&headers, &state).await;
    let hmac_key = state.session_token_hash_secret.as_bytes();
    let stored_key = digest_guest_idempotency_key(hmac_key, &raw_key);
    drop(raw_key);
    let request_digest = guest_checkout_digest(
        hmac_key,
        &GuestCheckoutFingerprint {
            product_code: &normalized.product_code,
            target: &normalized.target,
            server_id: &normalized.server_id,
            whatsapp: &normalized.whatsapp,
            email: &normalized.email,
            payment_method_id: &normalized.payment_method_id,
            use_flash_sale: normalized.use_flash_sale,
            voucher_code: &normalized.voucher_code,
            member_id: member.as_ref().map(|access| access.user_id),
        },
    );

    if let Some(row) = match sqlx::query("SELECT payload_digest,state,response_status,response_body FROM guest_checkout_idempotency WHERE idempotency_key=$1")
        .bind(&stored_key).fetch_optional(&state.pg_pool).await { Ok(row) => row, Err(_) => return internal_error() } {
        if row.get::<String, _>("payload_digest") != request_digest { return crate::services::idempotency::conflict_response(); }
        if row.get::<String, _>("state") == "completed" {
            if let (Some(status), Some(body)) = (row.get::<Option<i32>, _>("response_status"), row.get::<Option<serde_json::Value>, _>("response_body")) {
                return (StatusCode::from_u16(status as u16).unwrap_or(StatusCode::CREATED), Json(body)).into_response();
            }
        }
        if row.get::<String, _>("state") == "started" { return crate::services::idempotency::in_progress_response(); }
    }
    let settings = match sqlx::query("SELECT key,value FROM site_settings WHERE key IN ('botProtectionEnabled','turnstileSiteKey')")
        .fetch_all(&state.pg_pool).await {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    let stored_enabled = settings.iter().find(|row| row.get::<String, _>("key") == "botProtectionEnabled")
        .and_then(|row| row.get::<serde_json::Value, _>("value").as_bool()).unwrap_or(false);
    let site_key = settings.iter().find(|row| row.get::<String, _>("key") == "turnstileSiteKey")
        .and_then(|row| row.get::<serde_json::Value, _>("value").as_str().map(str::to_owned)).unwrap_or_default();
    let secret = std::env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
    let kill_switch = kill_switch_enabled(std::env::var("TURNSTILE_DISABLED").ok().as_deref());
    let remote_ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next()).map(str::trim).filter(|v| !v.is_empty()).unwrap_or("unknown");
    if let Err(response) = enforce_turnstile(
        stored_enabled, &site_key, &secret, kill_switch, payload.turnstile_token.as_deref(),
        Some(remote_ip), cloudflare_turnstile_verifier(),
    ).await { return response; }

    let product = match load_guest_product_by_code(&state.pg_pool, &normalized.product_code).await {
        Some(product) if product.status => product,
        Some(_) => return status_message(StatusCode::BAD_REQUEST, "Product is unavailable"),
        None => return status_message(StatusCode::NOT_FOUND, "Product not found"),
    };
    let issues = product_purchase_issues(&state.pg_pool, &product).await;
    if !issues.is_empty() {
        return status_message_owned(StatusCode::BAD_REQUEST, format!("Produk tidak tersedia untuk dibeli: {}", issues.join(", ")));
    }
    let payment_method_id = match Uuid::parse_str(&normalized.payment_method_id) {
        Ok(id) => id,
        Err(_) => return status_message(StatusCode::NOT_FOUND, "Payment method not found"),
    };
    let Some(payment_method) = resolve_payment_method(&state.pg_pool, payment_method_id).await else {
        return status_message(StatusCode::NOT_FOUND, "Payment method not found");
    };
    if payment_method.status != "active" {
        return status_message(StatusCode::BAD_REQUEST, "Payment method is not available");
    }
    let Some(category) = resolve_payment_category(&state.pg_pool, &payment_method).await else {
        return status_message(StatusCode::BAD_REQUEST, "Payment category is not available");
    };
    if category.status != "active" {
        return status_message(StatusCode::BAD_REQUEST, "Payment category is not available");
    }
    if !is_operational_now(&payment_method.operational_start, &payment_method.operational_end) {
        return status_message_owned(StatusCode::BAD_REQUEST, format!("Payment method is available only between {} and {}", payment_method.operational_start, payment_method.operational_end));
    }
    if !is_bank_transfer_category(&category) {
        return status_message(StatusCode::BAD_REQUEST, "Only bank transfer is allowed for guest checkout");
    }
    let base_price = product_price_for_level(&product, member.as_ref().map(|access| access.level.as_str()).unwrap_or("basic"));
    if base_price <= 0 { return status_message(StatusCode::BAD_REQUEST, "Product is not available"); }

    let product_ctx = crate::routes::vouchers::DiscountProductContext {
        product_id: Some(product.id), category_id: product.category_id, operator_id: product.operator_id,
    };
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return internal_error() };
    if sqlx::query("INSERT INTO guest_checkout_idempotency(idempotency_key,payload_digest,state) VALUES($1,$2,'started') ON CONFLICT(idempotency_key) DO NOTHING")
        .bind(&stored_key).bind(&request_digest).execute(&mut *tx).await.is_err() { return internal_error(); }
    let existing = match sqlx::query("SELECT payload_digest,state,response_status,response_body,transaction_id FROM guest_checkout_idempotency WHERE idempotency_key=$1 FOR UPDATE")
        .bind(&stored_key).fetch_one(&mut *tx).await {
        Ok(row) => row,
        Err(_) => return internal_error(),
    };
    if existing.get::<String, _>("payload_digest") != request_digest {
        return crate::services::idempotency::conflict_response();
    }
    if existing.get::<String, _>("state") == "completed" {
        if let (Some(status), Some(body)) = (existing.get::<Option<i32>, _>("response_status"), existing.get::<Option<serde_json::Value>, _>("response_body")) {
            return (StatusCode::from_u16(status as u16).unwrap_or(StatusCode::CREATED), Json(body)).into_response();
        }
    }
    // Started and domain state commit together, so a row without a transaction is an in-flight request.
    if existing.get::<Option<Uuid>, _>("transaction_id").is_some() { return crate::services::idempotency::in_progress_response(); }

    let preview_flash_price = if normalized.use_flash_sale {
        match super::checkout::preview_flash_sale_price(&state.pg_pool, &product.code, base_price).await {
            Ok(price) => price, Err(_) => return internal_error(),
        }
    } else { None };
    let mut price = preview_flash_price.unwrap_or(base_price);
    let flash_reservation = if normalized.use_flash_sale && preview_flash_price.is_some() {
        match crate::services::flash_sales::reserve_flash_sale_stock(&mut *tx, crate::services::flash_sales::FlashProductKey::Code(&product.code), base_price).await {
            Ok(value) => value, Err(_) => return internal_error(),
        }
    } else { None };
    if let Some(reservation) = flash_reservation.as_ref() { price = reservation.price; }
    let voucher = if normalized.voucher_code.is_empty() { None } else {
        match crate::routes::vouchers::consume_discount_voucher_sql(&mut *tx, &normalized.voucher_code, price, member.as_ref().map(|access| access.user_id), &product_ctx).await {
            Ok(applied) => { price = applied.final_price; Some(applied) }, Err(response) => return response,
        }
    };

    let admin_fee = (payment_method_admin_fee(&state.pg_pool, payment_method_id).await.unwrap_or(0.0) + (price as f64 * payment_method_admin_percent(&state.pg_pool, payment_method_id).await.unwrap_or(0.0) / 100.0).ceil()) as i64;
    let unique_code = if payment_method_use_unique_code(&state.pg_pool, payment_method_id).await.unwrap_or(true) { rand::thread_rng().gen_range(100..=999) } else { 0 };
    let total_amount = price + admin_fee + unique_code;
    let min_amount = payment_method_min_amount(&state.pg_pool, payment_method_id).await.unwrap_or(10_000);
    let max_amount = payment_method_max_amount(&state.pg_pool, payment_method_id).await.unwrap_or(5_000_000);
    if total_amount < min_amount { return status_message_owned(StatusCode::BAD_REQUEST, format!("Minimum amount is Rp {}", min_amount)); }
    if total_amount > max_amount { return status_message_owned(StatusCode::BAD_REQUEST, format!("Maximum amount is Rp {}", max_amount)); }
    let invoice_number = match generate_invoice_number(&state.pg_pool).await { Ok(value) => value, Err(_) => return internal_error() };
    let transaction_id = Uuid::new_v4();
    let now = chrono::Utc::now();
    let expired_at = now + chrono::Duration::hours(24);
    let response = GuestCreateResponse {
        message: GUEST_CREATE_MESSAGE,
        payment_info: GuestPaymentInfo {
            bank_name: payment_method_name(&state.pg_pool, payment_method_id).await.unwrap_or_default(),
            account_number: payment_method_account_number(&state.pg_pool, payment_method_id).await.unwrap_or_default(),
            account_name: payment_method_account_name(&state.pg_pool, payment_method_id).await.unwrap_or_default(),
            amount: price, admin_fee, unique_code, total_amount, expired_at: expired_at.to_rfc3339(),
        },
        transaction: GuestTransactionCheckItem {
            id: transaction_id.to_string(), invoice_number: invoice_number.clone(),
            user: member.as_ref().map(|access| access.user_id.to_string()),
            product: ProductCheckBrief { id: product.id.to_string(), code: product.code.clone(), name: product.name.clone() },
            target: normalized.target.clone(), server_id: (!normalized.server_id.is_empty()).then(|| normalized.server_id.clone()),
            whatsapp: normalized.whatsapp.clone(), email: (!normalized.email.is_empty()).then(|| normalized.email.clone()),
            amount: price, admin_fee, unique_code, total_amount,
            payment_method: PaymentMethodCheckBrief { id: payment_method.id.to_string(), name: payment_method_name(&state.pg_pool, payment_method_id).await.unwrap_or_default(), category: Some(category.id.to_string()), account_number: Some(payment_method_account_number(&state.pg_pool, payment_method_id).await.unwrap_or_default()), account_name: Some(payment_method_account_name(&state.pg_pool, payment_method_id).await.unwrap_or_default()) },
            payment_status: "waiting_payment".to_string(), transaction_status: "pending".to_string(), expired_at: expired_at.to_rfc3339(), created_at: now.to_rfc3339(), updated_at: now.to_rfc3339(), version: Some(0), paid_at: None, vendor_trx_id: None, sn: None, status_update_note: None, status_updated_at: None, status_updated_by: None,
        },
    };
    let body = match serde_json::to_value(response) { Ok(body) => body, Err(_) => return internal_error() };
    if crate::services::idempotency::bound_response_body(&body).is_err() { return crate::services::idempotency::IdempotencyError::ResponseTooLarge.into_response(); }
    let snapshot = serde_json::json!({"product":{"id":product.id,"code":product.code,"name":product.name,"vendorName":product.vendor_name,"vendorSku":product.vendor_sku,"validation":product_validation_config(&product)},"target":normalized.target,"serverId":normalized.server_id,"discountVoucherCode":voucher.as_ref().map(|v|v.code.clone()),"discountAmount":voucher.as_ref().map(|v|v.discount_amount),"baseAmount":voucher.as_ref().map(|_|preview_flash_price.unwrap_or(base_price)),"flashSaleId":flash_reservation.as_ref().map(|r|r.flash_sale_id.to_string())});
    let insert = sqlx::query("INSERT INTO guest_transactions(id,invoice_number,idempotency_key,payload_digest,user_id,product_id,payment_method_id,target,server_id,whatsapp,email,amount,admin_fee,unique_code,total_amount,payment_status,transaction_status,expired_at,discount_voucher_code,discount_amount,base_amount,flash_sale_id,snapshot,idempotency_response_status,idempotency_response_body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),NULLIF($11,''),$12,$13,$14,$15,'waiting_payment','pending',$16,$17,$18,$19,$20,$21,201,$22)")
        .bind(transaction_id).bind(&invoice_number).bind(&stored_key).bind(&request_digest).bind(member.as_ref().map(|a| a.user_id)).bind(product.id).bind(payment_method.id).bind(&normalized.target).bind(&normalized.server_id).bind(&normalized.whatsapp).bind(&normalized.email).bind(price).bind(admin_fee).bind(unique_code).bind(total_amount).bind(expired_at).bind(voucher.as_ref().map(|v|v.code.as_str())).bind(voucher.as_ref().map(|v|v.discount_amount)).bind(voucher.as_ref().map(|_|preview_flash_price.unwrap_or(base_price))).bind(flash_reservation.as_ref().map(|r|r.flash_sale_id.to_string())).bind(&snapshot).bind(&body).execute(&mut *tx).await;
    if insert.is_err() { return internal_error(); }
    if sqlx::query("INSERT INTO guest_transaction_status_events(transaction_id,status,payload) VALUES($1,'pending',$2)")
        .bind(transaction_id).bind(serde_json::json!({"source":"guest_checkout","invoiceNumber":invoice_number})).execute(&mut *tx).await.is_err() { return internal_error(); }
    let provider_job = serde_json::json!({"guestTransactionId":transaction_id,"invoiceNumber":invoice_number,"productId":product.id,"productCode":product.code,"sku":product.vendor_sku,"target":normalized.target,"serverId":normalized.server_id,"amount":price,"source":"guest"});
    if sqlx::query("INSERT INTO provider_outbox(ref_id,payload,state) VALUES($1,$2,'pending')").bind(&invoice_number).bind(&provider_job).execute(&mut *tx).await.is_err() { return internal_error(); }
    if sqlx::query("UPDATE guest_checkout_idempotency SET state='completed',response_status=201,response_body=$2,transaction_id=$3,updated_at=now() WHERE idempotency_key=$1")
        .bind(&stored_key).bind(&body).bind(transaction_id).execute(&mut *tx).await.is_err() { return internal_error(); }
    if tx.commit().await.is_err() { return internal_error(); }
    (StatusCode::CREATED, Json(body)).into_response()
}

async fn payment_method_admin_fee(pool: &sqlx::PgPool, id: Uuid) -> Option<f64> { sqlx::query_scalar("SELECT admin_fee FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }
async fn payment_method_admin_percent(pool: &sqlx::PgPool, id: Uuid) -> Option<f64> { sqlx::query_scalar("SELECT admin_percent FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }
async fn payment_method_min_amount(pool: &sqlx::PgPool, id: Uuid) -> Option<i64> { sqlx::query_scalar::<_,f64>("SELECT min_amount FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten().map(|v|v as i64) }
async fn payment_method_max_amount(pool: &sqlx::PgPool, id: Uuid) -> Option<i64> { sqlx::query_scalar::<_,f64>("SELECT max_amount FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten().map(|v|v as i64) }
async fn payment_method_use_unique_code(pool: &sqlx::PgPool, id: Uuid) -> Option<bool> { sqlx::query_scalar("SELECT use_unique_code FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }
async fn payment_method_name(pool: &sqlx::PgPool, id: Uuid) -> Option<String> { sqlx::query_scalar("SELECT name FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }
async fn payment_method_account_number(pool: &sqlx::PgPool, id: Uuid) -> Option<String> { sqlx::query_scalar("SELECT account_number FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }
async fn payment_method_account_name(pool: &sqlx::PgPool, id: Uuid) -> Option<String> { sqlx::query_scalar("SELECT account_name FROM payment_methods WHERE id=$1").bind(id).fetch_optional(pool).await.ok().flatten() }

pub async fn check_public(
    State(state): State<Arc<AppState>>,
    Path(invoice_number): Path<String>,
    Query(query): Query<CheckGuestTransactionQuery>,
) -> Response {
    let normalized_whatsapp = normalize_phone(query.whatsapp.as_deref());
    if normalized_whatsapp.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { message: "Nomor WhatsApp wajib diisi untuk cek transaksi" })).into_response();
    }
    let row = match sqlx::query("SELECT gt.id,gt.invoice_number,gt.user_id,gt.target,gt.server_id,gt.whatsapp,gt.email,gt.amount,gt.admin_fee,gt.unique_code,gt.total_amount,gt.payment_status,gt.transaction_status,gt.expired_at,gt.created_at,gt.updated_at,gt.paid_at,gt.vendor_trx_id,gt.sn,gt.status_update_note,gt.status_updated_at,gt.status_updated_by,p.id product_id,p.code product_code,p.name product_name,pm.id payment_method_id,pm.name payment_method_name,pm.category_id,pm.account_number,pm.account_name FROM guest_transactions gt JOIN products p ON p.id=gt.product_id JOIN payment_methods pm ON pm.id=gt.payment_method_id WHERE gt.invoice_number=$1 AND gt.whatsapp=$2 LIMIT 1")
        .bind(&invoice_number).bind(&normalized_whatsapp).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => row,
        Ok(None) => return transaction_not_found(),
        Err(_) => return internal_error(),
    };
    let item = GuestTransactionCheckItem {
        id: row.get::<Uuid,_>("id").to_string(), invoice_number: row.get("invoice_number"),
        user: row.get::<Option<Uuid>,_>("user_id").map(|id|id.to_string()),
        product: ProductCheckBrief { id:row.get::<Uuid,_>("product_id").to_string(),code:row.get("product_code"),name:row.get("product_name") },
        target:row.get("target"),server_id:row.get("server_id"),whatsapp:row.get("whatsapp"),email:row.get("email"),
        amount:row.get("amount"),admin_fee:row.get("admin_fee"),unique_code:row.get("unique_code"),total_amount:row.get("total_amount"),
        payment_method:PaymentMethodCheckBrief{id:row.get::<Uuid,_>("payment_method_id").to_string(),name:row.get("payment_method_name"),category:row.get::<Option<Uuid>,_>("category_id").map(|id|id.to_string()),account_number:row.get("account_number"),account_name:row.get("account_name")},
        payment_status:row.get("payment_status"),transaction_status:row.get("transaction_status"),
        expired_at:row.get::<chrono::DateTime<chrono::Utc>,_>("expired_at").to_rfc3339(),created_at:row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),updated_at:row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339(),version:None,
        paid_at:row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("paid_at").map(|v|v.to_rfc3339()),vendor_trx_id:row.get("vendor_trx_id"),sn:row.get("sn"),status_update_note:row.get("status_update_note"),status_updated_at:row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("status_updated_at").map(|v|v.to_rfc3339()),status_updated_by:row.get::<Option<Uuid>,_>("status_updated_by").map(|id|id.to_string()),
    };
    Json(item).into_response()
}
