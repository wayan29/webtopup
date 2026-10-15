use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::state::AppState;

use super::{
    config::{find_vendor_by_name, short_mask, tokovoucher_credentials, vendor_base_url},
    digiflazz::{insert_purchase, update_purchase, list_purchases},
    internal_error,
    providers::{fetch_tokovoucher_balance_with_base_url, fetch_tokovoucher_list, fetch_tokovoucher_product_by_code, send_tokovoucher_transaction},
    status_message, tokovoucher_query_bad_request,
    types::{TokovoucherAccess, VendorBalanceErrorResponse, VendorBalanceResponse},
    vendor_balance_bad_request,
};

#[derive(Deserialize)]
pub struct TokovoucherInternalPurchasePayload {
    #[serde(rename = "buyerSkuCode")]
    buyer_sku_code: String,
    #[serde(rename = "customerNo")]
    customer_no: String,
    #[serde(rename = "serverId")]
    server_id: Option<String>,
    note: Option<String>,
}

#[derive(Deserialize)]
pub struct TokovoucherInternalPurchaseQuery {
    limit: Option<i64>,
}

pub async fn create_tokovoucher_internal_purchase(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<TokovoucherInternalPurchasePayload>) -> Response {
    let actor = match crate::security::require_sql_user(&headers, &state).await { Ok(actor) => actor, Err(response) => return response };
    let access = match require_tokovoucher_access(&headers, &state).await { Ok(access) => access, Err(response) => return response };
    let buyer_sku_code = payload.buyer_sku_code.trim().to_string();
    let customer_no = payload.customer_no.trim().to_string();
    let server_id = payload.server_id.unwrap_or_default().trim().to_string();
    if buyer_sku_code.is_empty() || customer_no.is_empty() { return status_message(StatusCode::BAD_REQUEST, "Kode produk dan nomor tujuan wajib diisi"); }
    let product = match fetch_tokovoucher_product_by_code(&access, &buyer_sku_code).await {
        Ok(product) => product,
        Err(message) => return (StatusCode::BAD_REQUEST, Json(json!({"message":message}))).into_response(),
    };
    let purchase_id = Uuid::new_v4();
    let ref_id = format!("INTTKV{}", purchase_id.simple());
    let now = chrono::Utc::now();
    let initial = json!({
        "id":purchase_id,"provider":"tokovoucher","buyerSkuCode":product.code,"productName":product.name,
        "customerNo":customer_no,"serverId":server_id,"price":product.price,"refId":ref_id,
        "status":"pending","message":"Transaksi internal dibuat",
        "createdBy":{"id":actor.id,"name":actor.email,"email":actor.email,"role":actor.role},
        "note":payload.note.unwrap_or_default().trim(),"productLookupResponse":product.raw,
        "createdAt":now,"updatedAt":now
    });
    if insert_purchase(&state.pg_pool, purchase_id, "tokovoucher", &ref_id, &initial).await.is_err() { return internal_error(); }
    let result = send_tokovoucher_transaction(&access, &product.code, &customer_no, &server_id, &ref_id).await;
    let mut updated = initial;
    updated["status"] = json!(result.status);
    updated["message"] = json!(result.message);
    updated["sn"] = json!(result.sn.unwrap_or_default());
    updated["providerResponse"] = result.raw;
    updated["updatedAt"] = json!(chrono::Utc::now());
    let saved = match update_purchase(&state.pg_pool, purchase_id, &updated).await { Ok(saved) => saved, Err(_) => return internal_error() };
    Json(json!({"success":true,"message":result.message,"data":saved})).into_response()
}

pub async fn tokovoucher_internal_purchases(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<TokovoucherInternalPurchaseQuery>) -> Response {
    if let Err(response) = crate::security::require_sql_user(&headers, &state).await { return response; }
    list_purchases(&state.pg_pool, "tokovoucher", query.limit.unwrap_or(20)).await
}

pub async fn tokovoucher_balance(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = crate::security::require_sql_user(&headers, &state).await { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool, "tokovoucher").await;
    let credentials = tokovoucher_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() { return vendor_balance_bad_request("Tokovoucher credentials not configured"); }
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net")).unwrap_or_else(|| "https://api.tokovoucher.net".to_string());
    match fetch_tokovoucher_balance_with_base_url(&credentials, &base_url).await {
        Ok(balance) => Json(VendorBalanceResponse { provider_field: "memberCode", provider_value: short_mask(&credentials.username), balance }).into_response(),
        Err(message) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(VendorBalanceErrorResponse { message, balance: None })).into_response(),
    }
}

pub async fn tokovoucher_categories(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "success": true,
        "data": fetch_tokovoucher_list(&access, "/member/produk/category/list", Vec::new()).await
    }))
    .into_response()
}

pub async fn tokovoucher_operators(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(category_id) = required_query(&query, "categoryId") else {
        return tokovoucher_query_bad_request("categoryId is required");
    };
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "success": true,
        "data": fetch_tokovoucher_list(&access, "/member/produk/operator/list", vec![("id", category_id)]).await
    }))
    .into_response()
}

pub async fn tokovoucher_jenis(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(operator_id) = required_query(&query, "operatorId") else {
        return tokovoucher_query_bad_request("operatorId is required");
    };
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "success": true,
        "data": fetch_tokovoucher_list(&access, "/member/produk/jenis/list", vec![("id", operator_id)]).await
    }))
    .into_response()
}

pub async fn tokovoucher_products(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(jenis_id) = required_query(&query, "jenisId") else {
        return tokovoucher_query_bad_request("jenisId is required");
    };
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "success": true,
        "data": fetch_tokovoucher_list(&access, "/member/produk/list", vec![("id_jenis", jenis_id)]).await
    }))
    .into_response()
}

pub async fn tokovoucher_search(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(kode) = required_query(&query, "kode") else {
        return tokovoucher_query_bad_request("kode is required");
    };
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let products = fetch_tokovoucher_list(&access, "/produk/code", vec![("kode", kode)]).await;
    let total = products.len();
    Json(serde_json::json!({
        "success": true,
        "data": products,
        "total": total
    }))
    .into_response()
}

async fn require_tokovoucher_access(headers: &axum::http::HeaderMap, state: &AppState) -> Result<TokovoucherAccess, Response> {
    if let Err(response) = crate::security::require_sql_user(headers, state).await { return Err(response); }
    let vendor = find_vendor_by_name(&state.pg_pool, "tokovoucher").await;
    let credentials = tokovoucher_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return Err((axum::http::StatusCode::BAD_REQUEST, Json(json!({"success":false,"message":"Tokovoucher credentials not configured","data":[]}))).into_response());
    }
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net")).unwrap_or_else(|| "https://api.tokovoucher.net".to_string());
    Ok(TokovoucherAccess { credentials, base_url })
}

fn required_query(query: &HashMap<String, String>, key: &str) -> Option<String> {
    query
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
