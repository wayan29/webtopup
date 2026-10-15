use serde_json::json;
use sqlx::Row;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    routes::validation_engine::{product_validation_config_json, run_paid_validation, PaidValidationStatus},
    security::{require_permission, ErrorResponse},
    state::AppState,
};

use super::*;

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<GuestTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let page = parse_positive_i64(query.page.as_deref(), 1, 100_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 20, MAX_LIMIT);
    let offset = (page - 1) * limit;
    let search = query.search.as_deref().unwrap_or("").trim();
    let rows = match sqlx::query("SELECT gt.*,p.code product_code,p.name product_name,p.category product_category,p.brand product_brand,p.vendor_name,u.name user_name,u.email user_email,pm.name payment_method_name,pc.name payment_category_name,pm.account_name,pm.account_number FROM guest_transactions gt JOIN products p ON p.id=gt.product_id LEFT JOIN users u ON u.id=gt.user_id JOIN payment_methods pm ON pm.id=gt.payment_method_id LEFT JOIN payment_categories pc ON pc.id=pm.category_id WHERE ($1='' OR gt.invoice_number ILIKE '%'||$1||'%' OR gt.target ILIKE '%'||$1||'%' OR gt.whatsapp ILIKE '%'||$1||'%' OR p.name ILIKE '%'||$1||'%') AND ($2::text IS NULL OR gt.payment_status=$2) AND ($3::text IS NULL OR gt.transaction_status=$3) ORDER BY gt.created_at DESC LIMIT $4 OFFSET $5")
        .bind(search).bind(query.payment_status.as_deref()).bind(query.transaction_status.as_deref()).bind(limit).bind(offset).fetch_all(&state.pg_pool).await {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guest_transactions gt JOIN products p ON p.id=gt.product_id WHERE ($1='' OR gt.invoice_number ILIKE '%'||$1||'%' OR gt.target ILIKE '%'||$1||'%' OR gt.whatsapp ILIKE '%'||$1||'%' OR p.name ILIKE '%'||$1||'%') AND ($2::text IS NULL OR gt.payment_status=$2) AND ($3::text IS NULL OR gt.transaction_status=$3)").bind(search).bind(query.payment_status.as_deref()).bind(query.transaction_status.as_deref()).fetch_one(&state.pg_pool).await.unwrap_or(0);
    let items = rows.into_iter().map(guest_transaction_item_from_row).collect::<Vec<_>>();
    let summary_row=sqlx::query("SELECT COUNT(*) total,COALESCE(SUM(total_amount),0) amount_total,COUNT(*) FILTER(WHERE payment_status='waiting_payment') waiting_payment,COUNT(*) FILTER(WHERE payment_status='paid') paid,COUNT(*) FILTER(WHERE payment_status='expired') expired,COUNT(*) FILTER(WHERE payment_status='cancelled') cancelled,COUNT(*) FILTER(WHERE transaction_status='processing') processing,COUNT(*) FILTER(WHERE transaction_status='success') success,COUNT(*) FILTER(WHERE transaction_status='failed') failed FROM guest_transactions").fetch_one(&state.pg_pool).await;
    let summary=match summary_row{Ok(row)=>GuestTransactionsSummary{total:row.get("total"),amount_total:row.get("amount_total"),waiting_payment:row.get("waiting_payment"),paid:row.get("paid"),expired:row.get("expired"),cancelled:row.get("cancelled"),processing:row.get("processing"),success:row.get("success"),failed:row.get("failed")},Err(_)=>GuestTransactionsSummary::default()};
    Json(GuestTransactionsResponse{items,meta:GuestTransactionsMeta{page,limit,total,total_pages:if total>0{((total as f64)/(limit as f64)).ceil() as i64}else{1}},summary}).into_response()
}


pub async fn cancel_admin(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<GuestCancelPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = uuid::Uuid::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi guest tidak valid");
    };
    let note = match normalize_optional_text(payload.note.as_deref(), 500, "Catatan tindakan") { Ok(value)=>value,Err(response)=>return response };
    let note=build_action_note("Transaksi guest dibatalkan manual oleh admin",note.as_deref());
    let updated=sqlx::query("UPDATE guest_transactions SET payment_status='cancelled',transaction_status='failed',status_updated_by=$2,status_updated_at=now(),status_update_note=$3,updated_at=now() WHERE id=$1 AND (payment_status='waiting_payment' OR (payment_status='paid' AND transaction_status='failed'))")
        .bind(transaction_id.to_string()).bind(proxy_user.id.to_string()).bind(note).execute(&state.pg_pool).await;
    match updated { Ok(result) if result.rows_affected()==1=>{},Ok(_)=>return transaction_not_found(),Err(_)=>return internal_error() }
    let transaction=match sqlx::query("SELECT gt.*,p.code product_code,p.name product_name,p.category product_category,p.brand product_brand,p.vendor_name,u.name user_name,u.email user_email,pm.name payment_method_name,pc.name payment_category_name,pm.account_name,pm.account_number FROM guest_transactions gt JOIN products p ON p.id=gt.product_id LEFT JOIN users u ON u.id=gt.user_id JOIN payment_methods pm ON pm.id=gt.payment_method_id LEFT JOIN payment_categories pc ON pc.id=pm.category_id WHERE gt.id=$1").bind(transaction_id).fetch_one(&state.pg_pool).await { Ok(row)=>guest_transaction_item_from_row(row),Err(_)=>return internal_error() };
    Json(GuestMutationResponse { message:"Transaksi guest dibatalkan", transaction }).into_response()
}


pub async fn confirm_admin(headers: HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<GuestConfirmPayload>) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await { Ok(user) => user, Err(response) => return response };
    let Ok(transaction_id) = uuid::Uuid::parse_str(id.trim()) else { return status_message(StatusCode::BAD_REQUEST, "ID transaksi guest tidak valid"); };
    let note = match normalize_optional_text(payload.note.as_deref(), 500, "Catatan tindakan") { Ok(value) => value, Err(response) => return response };
    let ref_id = generate_guest_ref_id();
    let actor_id: uuid::Uuid = match sqlx::query_scalar("SELECT id FROM users WHERE email=$1")
        .bind(&proxy_user.email).fetch_optional(&state.pg_pool).await { Ok(Some(id)) => id, Ok(None) | Err(_) => return internal_error() };
    let claimed = match sqlx::query("UPDATE guest_transactions SET payment_status='paid',paid_at=now(),transaction_status='processing',vendor_trx_id=$2,status_updated_by=$3,status_updated_at=now(),status_update_note=$4,updated_at=now() WHERE id=$1 AND payment_status='waiting_payment' AND transaction_status='pending' RETURNING product_id,target,server_id")
        .bind(transaction_id).bind(&ref_id).bind(actor_id).bind(build_action_note("Pembayaran guest dikonfirmasi manual dan dikirim ke vendor",note.as_deref())).fetch_optional(&state.pg_pool).await { Ok(Some(row)) => row, Ok(None) => return status_message(StatusCode::CONFLICT,"Transaksi guest tidak dapat dikonfirmasi"), Err(_) => return internal_error() };
    let product_id: uuid::Uuid = claimed.get("product_id");
    let target: String = claimed.get("target");
    let server_id: String = claimed.get("server_id");
    if let Some(product) = load_guest_product_document(&state.pg_pool, product_id).await {
        if let Some(config) = product_validation_config_json(&json!({"validation": product.validation})) {
            let result = run_paid_validation(&config, &target, &server_id).await;
            let (status, message) = match result.status { PaidValidationStatus::Success => ("success", format!("Validasi berhasil: {}", result.message)), PaidValidationStatus::Failed => ("failed", format!("Validasi otomatis gagal: {}", result.message)), PaidValidationStatus::ProviderError => ("pending", format!("Validasi otomatis tertunda: {}", result.message)) };
            let _ = sqlx::query("UPDATE guest_transactions SET transaction_status=$2,sn=COALESCE($3,sn),status_updated_by=$4,status_updated_at=now(),status_update_note=$5,updated_at=now() WHERE id=$1 AND transaction_status='processing'").bind(transaction_id).bind(status).bind(result.sn).bind(actor_id).bind(build_action_note(&message,note.as_deref())).execute(&state.pg_pool).await;
        } else {
            let Some(product) = load_guest_provider_product(&state.pg_pool, product_id).await else { return internal_error(); };
            match top_up_guest_vendor(&state,&ref_id,&target,&server_id,&product).await {
                Ok(result) => { let _=sqlx::query("UPDATE guest_transactions SET transaction_status=$2,vendor_trx_id=COALESCE($3,vendor_trx_id),sn=COALESCE($4,sn),status_updated_by=$5,status_updated_at=now(),status_update_note=$6,updated_at=now() WHERE id=$1 AND transaction_status='processing'").bind(transaction_id).bind(result.status).bind(result.vendor_trx_id).bind(result.sn).bind(actor_id).bind(build_action_note("Pembayaran guest dikonfirmasi manual dan dikirim ke vendor",note.as_deref())).execute(&state.pg_pool).await; }
                Err(_) => {}
            }
        }
    }
    let transaction = match sqlx::query("SELECT gt.*,p.code product_code,p.name product_name,p.category product_category,p.brand product_brand,p.vendor_name,u.name user_name,u.email user_email,pm.name payment_method_name,pc.name payment_category_name,pm.account_name,pm.account_number FROM guest_transactions gt JOIN products p ON p.id=gt.product_id LEFT JOIN users u ON u.id=gt.user_id JOIN payment_methods pm ON pm.id=gt.payment_method_id LEFT JOIN payment_categories pc ON pc.id=pm.category_id WHERE gt.id=$1").bind(transaction_id).fetch_one(&state.pg_pool).await { Ok(row) => guest_transaction_item_from_row(row), Err(_) => return internal_error() };
    Json(GuestMutationResponse { message:"Pembayaran guest berhasil dikonfirmasi", transaction }).into_response()
}


pub async fn update_status_admin(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<GuestStatusPayload>,
) -> Response {
    let proxy_user=match require_permission(&headers,&state,"processManualTransaction").await {Ok(user)=>user,Err(response)=>return response};
    let transaction_id=match uuid::Uuid::parse_str(id.trim()){Ok(value)=>value,Err(_)=>return status_message(StatusCode::BAD_REQUEST,"ID transaksi guest tidak valid")};
    let normalized=match normalize_guest_status_payload(payload){Ok(value)=>value,Err(response)=>return response};
    let existing=match sqlx::query("SELECT payment_status FROM guest_transactions WHERE id=$1").bind(transaction_id.to_string()).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>row,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"Transaksi guest tidak ditemukan"),Err(_)=>return internal_error()};
    if let Err(response)=validate_guest_manual_status_transition(&existing.get::<String,_>("payment_status"),&normalized.transaction_status){return response;}
    let update=sqlx::query("UPDATE guest_transactions SET transaction_status=$2,vendor_trx_id=COALESCE($3,vendor_trx_id),sn=COALESCE($4,sn),status_updated_by=$5,status_updated_at=now(),status_update_note=$6,updated_at=now() WHERE id=$1")
        .bind(transaction_id.to_string()).bind(&normalized.transaction_status).bind(normalized.vendor_trx_id.clone()).bind(normalized.sn.clone()).bind(proxy_user.id.to_string()).bind(build_action_note("Status guest transaction diubah manual",normalized.note.as_deref())).execute(&state.pg_pool).await;
    match update{Ok(result) if result.rows_affected()==1=>{},Ok(_)=>return status_message(StatusCode::NOT_FOUND,"Transaksi guest tidak ditemukan"),Err(_)=>return internal_error()}
    Json(json!({"message":"Status transaksi guest diperbarui","transaction":{"_id":transaction_id.to_string(),"transactionStatus":normalized.transaction_status}})).into_response()
}
