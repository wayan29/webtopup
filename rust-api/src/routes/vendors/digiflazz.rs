use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    IndexModel,
};
use serde::Deserialize;

use crate::{security::require_proxy_context, state::AppState, utils::bson::escape_regex};

use super::{
    config::{digiflazz_credentials, find_vendor_by_name, short_mask, vendor_base_url},
    internal_error,
    json::document_to_json,
    providers::{
        fetch_digiflazz_balance_with_base_url, fetch_digiflazz_pricelist_remote,
        send_digiflazz_transaction,
    },
    status_message,
    types::VendorBalanceResponse,
    unavailable, vendor_balance_bad_request,
};

#[derive(Deserialize)]
pub struct InternalPurchasePayload {
    #[serde(rename = "buyerSkuCode")]
    buyer_sku_code: String,
    #[serde(rename = "customerNo")]
    customer_no: String,
    note: Option<String>,
}

#[derive(Deserialize)]
pub struct InternalPurchaseQuery {
    limit: Option<i64>,
}

pub async fn create_digiflazz_internal_purchase(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InternalPurchasePayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let buyer_sku_code = payload.buyer_sku_code.trim().to_string();
    let customer_no = payload.customer_no.trim().to_string();
    if buyer_sku_code.is_empty() || customer_no.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "SKU dan nomor tujuan wajib diisi");
    }

    let db = client.database(&state.mongo_db);
    let pricelist = db.collection::<Document>("dgcache");
    let Some(product) = (match pricelist
        .find_one(doc! { "buyer_sku_code": &buyer_sku_code })
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "Produk Digiflazz tidak ditemukan");
    };
    if product.get_bool("seller_product_status").ok() == Some(false) {
        return status_message(StatusCode::BAD_REQUEST, "Produk Digiflazz nonaktif");
    }

    let vendor = find_vendor_by_name(client, &state.mongo_db, "digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Digiflazz credentials not configured",
        );
    }
    let base_url = vendor
        .as_ref()
        .map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
        .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());

    let now = DateTime::now();
    let purchase_id = ObjectId::new();
    let ref_id = format!("INTDGF{}", purchase_id.to_hex());
    let purchases = db.collection::<Document>("internal_provider_purchases");
    let created_by = proxy_actor_doc(&headers);
    let price = bson_i64(&product, "price");
    let product_name = product
        .get_str("product_name")
        .unwrap_or_default()
        .to_string();
    let note = payload.note.unwrap_or_default().trim().to_string();

    let initial = doc! {
        "_id": purchase_id,
        "provider": "digiflazz",
        "buyerSkuCode": &buyer_sku_code,
        "productName": &product_name,
        "customerNo": &customer_no,
        "price": price,
        "refId": &ref_id,
        "status": "pending",
        "message": "Transaksi internal dibuat",
        "createdBy": created_by,
        "note": &note,
        "createdAt": now,
        "updatedAt": now,
    };
    if purchases.insert_one(initial).await.is_err() {
        return internal_error();
    }

    let provider_result = send_digiflazz_transaction(
        &credentials,
        &base_url,
        &buyer_sku_code,
        &customer_no,
        &ref_id,
    )
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

pub async fn digiflazz_internal_purchases(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<InternalPurchaseQuery>,
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
        .find(doc! { "provider": "digiflazz" })
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

fn bson_i64(document: &Document, key: &str) -> i64 {
    match document.get(key) {
        Some(Bson::Int64(value)) => *value,
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Double(value)) => *value as i64,
        _ => 0,
    }
}

pub async fn digiflazz_pricelist(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("dgcache");
    let total = collection.count_documents(doc! {}).await.unwrap_or(0) as i64;

    if total == 0 {
        return Json(serde_json::json!({
            "success": false,
            "message": "Pricelist kosong. Klik \"Get Pricelist\" di halaman settings Digiflazz untuk mengambil data.",
            "data": [],
            "total": 0,
            "filters": { "categories": [], "brands": [] }
        }))
        .into_response();
    }

    let filter = build_digiflazz_pricelist_filter(&query);
    let page = parse_positive_i64(query.get("page"), 1, i64::MAX);
    let limit = parse_positive_i64(query.get("limit"), 50, 1_000);
    let skip = u64::try_from((page - 1) * limit).unwrap_or(0);
    let data = match collection
        .find(filter.clone())
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let filtered_total = collection.count_documents(filter).await.unwrap_or(0) as i64;
    let category_filter = query
        .get("brand")
        .filter(|value| !value.trim().is_empty())
        .map(|brand| doc! { "brand": { "$regex": escape_regex(brand), "$options": "i" } })
        .unwrap_or_default();
    let brand_filter = query
        .get("category")
        .filter(|value| !value.trim().is_empty())
        .map(|category| doc! { "category": { "$regex": escape_regex(category), "$options": "i" } })
        .unwrap_or_default();
    let categories = distinct_strings(&collection, "category", category_filter).await;
    let brands = distinct_strings(&collection, "brand", brand_filter).await;

    Json(serde_json::json!({
        "success": true,
        "data": data.into_iter().map(document_to_json).collect::<Vec<_>>(),
        "total": filtered_total,
        "page": page,
        "limit": limit,
        "totalPages": ((filtered_total as f64) / (limit as f64)).ceil() as i64,
        "filters": {
            "categories": categories,
            "brands": brands
        }
    }))
    .into_response()
}

pub async fn fetch_digiflazz_pricelist(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let vendor = find_vendor_by_name(client, &state.mongo_db, "digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Digiflazz credentials not configured",
        );
    }

    let base_url = vendor
        .as_ref()
        .map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
        .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let pricelist = fetch_digiflazz_pricelist_remote(&credentials, &base_url).await;
    if pricelist.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Gagal mengambil pricelist dari Digiflazz",
        );
    }

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("dgcache");
    if collection.delete_many(doc! {}).await.is_err() {
        return internal_error();
    }
    if collection.insert_many(pricelist.clone()).await.is_err() {
        return internal_error();
    }
    let _ = collection
        .create_index(IndexModel::builder().keys(doc! { "category": 1 }).build())
        .await;
    let _ = collection
        .create_index(IndexModel::builder().keys(doc! { "brand": 1 }).build())
        .await;
    let _ = collection
        .create_index(
            IndexModel::builder()
                .keys(doc! { "buyer_sku_code": 1 })
                .build(),
        )
        .await;
    let _ = collection
        .create_index(
            IndexModel::builder()
                .keys(doc! { "product_name": "text" })
                .build(),
        )
        .await;

    Json(serde_json::json!({
        "success": true,
        "message": format!("Berhasil mengambil {} produk dari Digiflazz", pricelist.len()),
        "total": pricelist.len()
    }))
    .into_response()
}

pub async fn digiflazz_balance(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let vendor = find_vendor_by_name(client, &state.mongo_db, "digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return vendor_balance_bad_request("Digiflazz credentials not configured");
    }

    let balance = fetch_digiflazz_balance_with_base_url(
        &credentials,
        &vendor
            .as_ref()
            .map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
            .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string()),
    )
    .await;
    Json(VendorBalanceResponse {
        provider_field: "username",
        provider_value: short_mask(&credentials.username),
        balance,
    })
    .into_response()
}

fn build_digiflazz_pricelist_filter(query: &HashMap<String, String>) -> Document {
    let mut filter = Document::new();
    if let Some(category) = query
        .get("category")
        .filter(|value| !value.trim().is_empty())
    {
        filter.insert(
            "category",
            doc! { "$regex": escape_regex(category), "$options": "i" },
        );
    }
    if let Some(brand) = query.get("brand").filter(|value| !value.trim().is_empty()) {
        filter.insert(
            "brand",
            doc! { "$regex": escape_regex(brand), "$options": "i" },
        );
    }
    if let Some(sku) = query.get("sku").filter(|value| !value.trim().is_empty()) {
        filter.insert(
            "buyer_sku_code",
            doc! { "$regex": escape_regex(sku), "$options": "i" },
        );
    }
    if let Some(search) = query.get("search").filter(|value| !value.trim().is_empty()) {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        filter.insert(
            "$or",
            vec![
                doc! { "product_name": regex.clone() },
                doc! { "buyer_sku_code": regex.clone() },
                doc! { "brand": regex },
            ],
        );
    }
    filter
}

async fn distinct_strings(
    collection: &mongodb::Collection<Document>,
    field: &str,
    filter: Document,
) -> Vec<String> {
    collection
        .distinct(field, filter)
        .await
        .map(|values| {
            values
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_positive_i64(value: Option<&String>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}
