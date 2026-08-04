use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde::Deserialize;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    config::{find_vendor_by_name, short_mask, tokovoucher_credentials, vendor_base_url},
    internal_error,
    json::document_to_json,
    providers::{
        fetch_tokovoucher_balance_with_base_url, fetch_tokovoucher_list,
        fetch_tokovoucher_product_by_code, send_tokovoucher_transaction,
    },
    status_message, tokovoucher_query_bad_request,
    types::{TokovoucherAccess, VendorBalanceErrorResponse, VendorBalanceResponse},
    unavailable, vendor_balance_bad_request,
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

pub async fn create_tokovoucher_internal_purchase(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TokovoucherInternalPurchasePayload>,
) -> Response {
    let access = match require_tokovoucher_access(&headers, &state).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let buyer_sku_code = payload.buyer_sku_code.trim().to_string();
    let customer_no = payload.customer_no.trim().to_string();
    let server_id = payload.server_id.unwrap_or_default().trim().to_string();
    if buyer_sku_code.is_empty() || customer_no.is_empty() {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Kode produk dan nomor tujuan wajib diisi",
        );
    }

    let product = match fetch_tokovoucher_product_by_code(&access, &buyer_sku_code).await {
        Ok(product) => product,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "message": message })),
            )
                .into_response()
        }
    };

    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let purchase_id = ObjectId::new();
    let ref_id = format!("INTTKV{}", purchase_id.to_hex());
    let purchases = db.collection::<Document>("internal_provider_purchases");
    let created_by = proxy_actor_doc(&headers);
    let note = payload.note.unwrap_or_default().trim().to_string();
    let product_lookup_bson = Bson::try_from(product.raw.clone()).unwrap_or(Bson::Null);

    let initial = doc! {
        "_id": purchase_id,
        "provider": "tokovoucher",
        "buyerSkuCode": &product.code,
        "productName": &product.name,
        "customerNo": &customer_no,
        "serverId": &server_id,
        "price": product.price,
        "refId": &ref_id,
        "status": "pending",
        "message": "Transaksi internal dibuat",
        "createdBy": created_by,
        "note": &note,
        "productLookupResponse": product_lookup_bson,
        "createdAt": now,
        "updatedAt": now,
    };
    if purchases.insert_one(initial).await.is_err() {
        return internal_error();
    }

    let provider_result =
        send_tokovoucher_transaction(&access, &product.code, &customer_no, &server_id, &ref_id)
            .await;
    let raw_bson = Bson::try_from(provider_result.raw.clone()).unwrap_or(Bson::Null);
    let update = doc! {
        "$set": {
            "status": &provider_result.status,
            "message": &provider_result.message,
            "sn": provider_result.sn.clone().unwrap_or_default(),
            "providerResponse": raw_bson,
            "updatedAt": DateTime::now(),
        }
    };
    if purchases
        .update_one(doc! { "_id": purchase_id }, update)
        .await
        .is_err()
    {
        return internal_error();
    }

    let Some(saved) = (match purchases.find_one(doc! { "_id": purchase_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return internal_error();
    };

    Json(serde_json::json!({
        "success": true,
        "message": provider_result.message,
        "data": document_to_json(saved)
    }))
    .into_response()
}

pub async fn tokovoucher_internal_purchases(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<TokovoucherInternalPurchaseQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let db = client.database(&state.mongo_db);
    let purchases = db.collection::<Document>("internal_provider_purchases");
    let items = match purchases
        .find(doc! { "provider": "tokovoucher" })
        .sort(doc! { "createdAt": -1 })
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(serde_json::json!({
        "success": true,
        "data": items.into_iter().map(document_to_json).collect::<Vec<_>>()
    }))
    .into_response()
}

fn proxy_actor_doc(headers: &axum::http::HeaderMap) -> Document {
    let read_header = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
            .unwrap_or_default()
            .to_string()
    };
    let email = read_header(&["x-webtopup-user-email", "x-user-email"]);
    let name = read_header(&["x-user-name"]);
    doc! {
        "id": read_header(&["x-webtopup-user-id", "x-user-id"]),
        "name": if name.is_empty() { email.clone() } else { name },
        "email": email,
        "role": read_header(&["x-webtopup-user-role", "x-user-role"]),
    }
}

pub async fn tokovoucher_balance(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let vendor = find_vendor_by_name(client, &state.mongo_db, "tokovoucher").await;
    let credentials = tokovoucher_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return vendor_balance_bad_request("Tokovoucher credentials not configured");
    }

    match fetch_tokovoucher_balance_with_base_url(
        &credentials,
        &vendor
            .as_ref()
            .map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net"))
            .unwrap_or_else(|| "https://api.tokovoucher.net".to_string()),
    )
    .await
    {
        Ok(balance) => Json(VendorBalanceResponse {
            provider_field: "memberCode",
            provider_value: short_mask(&credentials.username),
            balance,
        })
        .into_response(),
        Err(message) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(VendorBalanceErrorResponse {
                message,
                balance: 0,
            }),
        )
            .into_response(),
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

async fn require_tokovoucher_access(
    headers: &axum::http::HeaderMap,
    state: &AppState,
) -> Result<TokovoucherAccess, Response> {
    if let Err(response) = require_proxy_context(headers, state) {
        return Err(response);
    }
    let Some(client) = &state.mongo_client else {
        return Err(unavailable());
    };
    let vendor = find_vendor_by_name(client, &state.mongo_db, "tokovoucher").await;
    let credentials = tokovoucher_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": "Tokovoucher credentials not configured",
                "data": []
            })),
        )
            .into_response());
    }
    let base_url = vendor
        .as_ref()
        .map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net"))
        .unwrap_or_else(|| "https://api.tokovoucher.net".to_string());
    Ok(TokovoucherAccess {
        credentials,
        base_url,
    })
}

fn required_query(query: &HashMap<String, String>, key: &str) -> Option<String> {
    query
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
