use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::Value;

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::{escape_regex, read_i64},
};

const SELLER_ORDER_EXPORT_LIMIT: i64 = 5000;

mod callbacks;
mod center;
mod logs;
mod mappings;
mod prepaid;
mod scheduler;
mod settings;
mod types;
mod utils;

use callbacks::*;
pub use center::center_summary;
pub use logs::logs;
pub use mappings::{delete_mapping, mappings, save_mapping, sync_all_mappings, sync_mapping_by_id};
pub use prepaid::prepaid;
pub use scheduler::scheduler_config;
use settings::seller_config;
pub use settings::{save_settings, settings};
use types::*;
use utils::*;

const RETRY_HEALTH_KEY: &str = "digiflazzSellerRetryQueueHealth";

pub async fn retry_callback(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(order_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Order tidak valid");
    };
    let db = client.database(&state.mongo_db);
    let order = match db
        .collection::<Document>("digiflazzsellerorders")
        .find_one(doc! { "_id": order_id })
        .await
    {
        Ok(Some(order)) => order,
        Ok(None) => {
            return status_message(axum::http::StatusCode::NOT_FOUND, "Order tidak ditemukan")
        }
        Err(_) => return internal_error(),
    };
    Json(send_seller_callback(&db, &order).await).into_response()
}

pub async fn retry_pending_callbacks(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LimitPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let limit = parse_limit_value(payload.limit.as_ref(), 25, 50);
    let orders = match db
        .collection::<Document>("digiflazzsellerorders")
        .find(doc! { "status": { "$ne": "pending" }, "$and": [callback_pending_query()] })
        .sort(doc! { "updatedAt": 1 })
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => return internal_error(),
    };
    Json(callback_retry_response(&db, orders).await).into_response()
}

pub async fn process_due_callback_retries(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LimitPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    process_due_callback_retries_inner(&state, payload, "admin").await
}

pub async fn process_due_callback_retries_scheduler(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LimitPayload>,
) -> Response {
    let configured_token = std::env::var("DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    let provided_token = headers
        .get("x-scheduler-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    if configured_token.len() < 16
        || provided_token.is_empty()
        || configured_token != provided_token
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                message: "Unauthorized scheduler token",
            }),
        )
            .into_response();
    }
    process_due_callback_retries_inner(&state, payload, "scheduler").await
}

async fn process_due_callback_retries_inner(
    state: &AppState,
    payload: LimitPayload,
    source: &str,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let limit = parse_limit_value(payload.limit.as_ref(), 20, 50);
    let orders = match db
        .collection::<Document>("digiflazzsellerorders")
        .find(callback_due_retry_query())
        .sort(doc! { "callbackNextRetryAt": 1, "updatedAt": 1 })
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => {
            let health = save_retry_queue_health(
                &db,
                source,
                0,
                0,
                0,
                0,
                "Gagal memproses queue retry callback",
            )
            .await;
            return Json(SellerCallbackDueRetryResponse {
                processed: 0,
                success_count: 0,
                failed_count: 0,
                remaining_due: 0,
                health,
                results: Vec::new(),
            })
            .into_response();
        }
    };
    let response = callback_retry_response(&db, orders).await;
    let remaining_due =
        count_documents(&db, "digiflazzsellerorders", callback_due_retry_query()).await;
    let last_error = if response.failed_count > 0 {
        format!("{} callback gagal diproses", response.failed_count)
    } else {
        String::new()
    };
    let health = save_retry_queue_health(
        &db,
        source,
        response.processed as i64,
        response.success_count as i64,
        response.failed_count as i64,
        remaining_due,
        &last_error,
    )
    .await;
    Json(SellerCallbackDueRetryResponse {
        processed: response.processed,
        success_count: response.success_count,
        failed_count: response.failed_count,
        remaining_due,
        health,
        results: response.results,
    })
    .into_response()
}

async fn callback_retry_response(
    db: &mongodb::Database,
    orders: Vec<Document>,
) -> SellerCallbackRetryResponse {
    let mut results = Vec::new();
    for order in orders {
        let order_id = document_id(&order);
        let ref_id = document_string(&order, "refId");
        let result = send_seller_callback(db, &order).await;
        let updated = db
            .collection::<Document>("digiflazzsellerorders")
            .find_one(
                order
                    .get_object_id("_id")
                    .map(|id| doc! { "_id": id })
                    .unwrap_or_default(),
            )
            .await
            .ok()
            .flatten();
        results.push(SellerCallbackRetryItem {
            order_id,
            ref_id,
            success: result.success,
            message: result.message,
            next_retry_at: updated
                .as_ref()
                .and_then(|doc| optional_date_string(doc, "callbackNextRetryAt")),
        });
    }
    let success_count = results.iter().filter(|item| item.success).count();
    SellerCallbackRetryResponse {
        processed: results.len(),
        success_count,
        failed_count: results.len().saturating_sub(success_count),
        results,
    }
}

async fn save_retry_queue_health(
    db: &mongodb::Database,
    source: &str,
    processed: i64,
    success_count: i64,
    failed_count: i64,
    remaining_due: i64,
    last_error: &str,
) -> RetryQueueHealth {
    let status = if failed_count > 0 {
        "partial"
    } else {
        "success"
    };
    let value = doc! {
        "status": status,
        "source": source,
        "lastRunAt": DateTime::now(),
        "processed": processed,
        "successCount": success_count,
        "failedCount": failed_count,
        "remainingDue": remaining_due,
        "lastError": last_error,
    };
    let _ = db
        .collection::<Document>("settings")
        .update_one(
            doc! { "key": RETRY_HEALTH_KEY },
            doc! { "$set": { "key": RETRY_HEALTH_KEY, "value": &value, "description": "Status terakhir scheduler retry callback Digiflazz Seller" } },
        )
        .upsert(true)
        .await;
    RetryQueueHealth {
        status: document_string(&value, "status"),
        source: document_string(&value, "source"),
        last_run_at: optional_date_string(&value, "lastRunAt"),
        processed,
        success_count,
        failed_count,
        remaining_due,
        last_error: last_error.to_string(),
    }
}

fn parse_limit_value(value: Option<&Value>, fallback: i64, max: i64) -> i64 {
    value
        .map(text_from_value)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value.floor() as i64).min(max))
        .unwrap_or(fallback)
}

pub async fn orders(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("digiflazzsellerorders")
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .limit(50)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_map = seller_order_products(&db, &docs).await;

    Json(
        docs.into_iter()
            .map(|doc| seller_order_from_doc(doc, &product_map))
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn admin_orders(
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
    let filter = match build_admin_orders_filter(&db, &query).await {
        Ok(filter) => filter,
        Err(response) => return response,
    };
    let page = parse_positive_i64(query.get("page"), 1, 100_000);
    let limit = parse_positive_i64(query.get("limit"), 20, 100);
    let skip = u64::try_from((page - 1) * limit).unwrap_or(0);
    let collection = db.collection::<Document>("digiflazzsellerorders");
    let docs = match collection
        .find(filter.clone())
        .sort(doc! { "createdAt": -1 })
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_map = seller_order_products(&db, &docs).await;
    let summary = admin_orders_summary(&collection, filter).await;
    let total_pages = if summary.total > 0 {
        ((summary.total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };

    Json(SellerAdminOrdersResponse {
        items: docs
            .into_iter()
            .map(|doc| seller_admin_order_from_doc(doc, &product_map))
            .collect(),
        meta: SellerAdminOrdersMeta {
            page,
            limit,
            total: summary.total,
            total_pages,
        },
        summary,
    })
    .into_response()
}

pub async fn admin_orders_export(
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
    let filter = match build_admin_orders_filter(&db, &query).await {
        Ok(filter) => filter,
        Err(response) => return response,
    };
    let collection = db.collection::<Document>("digiflazzsellerorders");
    let docs = match collection
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .limit(SELLER_ORDER_EXPORT_LIMIT)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_map = seller_order_products(&db, &docs).await;
    let items = docs
        .into_iter()
        .map(|doc| seller_admin_order_from_doc(doc, &product_map))
        .collect::<Vec<_>>();
    let csv = build_seller_orders_csv(&items);
    let filename = format!("digiflazz-seller-orders-{}.csv", date_key(DateTime::now()));
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

async fn build_admin_orders_filter(
    db: &mongodb::Database,
    query: &HashMap<String, String>,
) -> Result<Document, Response> {
    let mut filter = Document::new();
    let mut and_conditions = Vec::<Document>::new();
    let status = query
        .get("status")
        .map(|value| value.trim())
        .unwrap_or_default();
    if !status.is_empty() {
        if !matches!(status, "pending" | "success" | "failed") {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Status transaksi seller tidak valid",
            ));
        }
        filter.insert("status", status);
    }

    let callback = query
        .get("callback")
        .map(|value| value.trim())
        .unwrap_or_default();
    if !callback.is_empty() && !matches!(callback, "pending" | "due" | "delivered") {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Filter callback seller tidak valid",
        ));
    }
    if callback == "pending" {
        and_conditions.push(callback_pending_query());
    } else if callback == "due" {
        and_conditions.push(callback_due_retry_query());
    } else if callback == "delivered" {
        and_conditions.push(doc! { "callbackDeliveredAt": { "$exists": true, "$ne": Bson::Null } });
    }

    let start = parse_date_boundary(query.get("startDate"), false)?;
    let end = parse_date_boundary(query.get("endDate"), true)?;
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(start) = start {
            created_at.insert("$gte", start);
        }
        if let Some(end) = end {
            created_at.insert("$lte", end);
        }
        filter.insert("createdAt", created_at);
    }

    if let Some(keyword) = query
        .get("search")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(keyword), "$options": "i" };
        let product_ids = product_ids_for_seller_order_search(db, regex.clone()).await;
        let mut search_or = vec![
            doc! { "refId": regex.clone() },
            doc! { "trId": regex.clone() },
            doc! { "pulsaCode": regex.clone() },
            doc! { "target": regex.clone() },
            doc! { "vendorTrxId": regex.clone() },
            doc! { "vendorName": regex.clone() },
            doc! { "vendorSku": regex.clone() },
            doc! { "sn": regex.clone() },
            doc! { "message": regex.clone() },
            doc! { "requestIp": regex },
        ];
        if !product_ids.is_empty() {
            search_or.push(doc! { "product": { "$in": product_ids } });
        }
        and_conditions.push(doc! { "$or": search_or });
    }

    if !and_conditions.is_empty() {
        filter.insert("$and", and_conditions);
    }

    Ok(filter)
}

async fn product_ids_for_seller_order_search(db: &mongodb::Database, regex: Document) -> Vec<Bson> {
    match db
        .collection::<Document>("products")
        .find(doc! { "$or": [
            { "name": regex.clone() },
            { "code": regex.clone() },
            { "brand": regex.clone() },
            { "category": regex.clone() },
            { "vendor.name": regex.clone() },
            { "vendor.sku": regex }
        ] })
        .projection(doc! { "_id": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| doc.get_object_id("_id").ok().map(Bson::ObjectId))
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn parse_date_boundary(
    value: Option<&String>,
    end_of_day: bool,
) -> Result<Option<DateTime>, Response> {
    let Some(value) = value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let suffix = if end_of_day {
        "T23:59:59.999Z"
    } else {
        "T00:00:00.000Z"
    };
    let date = DateTime::parse_rfc3339_str(format!("{value}{suffix}")).map_err(|_| {
        status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Format tanggal transaksi seller tidak valid",
        )
    })?;
    Ok(Some(date))
}

async fn admin_orders_summary(
    collection: &mongodb::Collection<Document>,
    filter: Document,
) -> SellerAdminOrdersSummary {
    match collection
        .aggregate(vec![
            doc! { "$match": filter },
            doc! { "$group": {
                "_id": Bson::Null,
                "total": { "$sum": 1 },
                "pending": { "$sum": { "$cond": [ { "$eq": ["$status", "pending"] }, 1, 0 ] } },
                "success": { "$sum": { "$cond": [ { "$eq": ["$status", "success"] }, 1, 0 ] } },
                "failed": { "$sum": { "$cond": [ { "$eq": ["$status", "failed"] }, 1, 0 ] } },
                "callbackPending": { "$sum": { "$cond": [ callback_pending_expression(), 1, 0 ] } },
                "callbackDueRetry": { "$sum": { "$cond": [ callback_due_retry_expression(), 1, 0 ] } },
                "amountTotal": { "$sum": "$digiflazzPrice" }
            } },
        ])
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .next()
            .map(|doc| SellerAdminOrdersSummary {
                total: read_i64(&doc, "total"),
                pending: read_i64(&doc, "pending"),
                success: read_i64(&doc, "success"),
                failed: read_i64(&doc, "failed"),
                callback_pending: read_i64(&doc, "callbackPending"),
                callback_due_retry: read_i64(&doc, "callbackDueRetry"),
                amount_total: read_i64(&doc, "amountTotal"),
            })
            .unwrap_or_default(),
        Err(_) => SellerAdminOrdersSummary::default(),
    }
}

fn parse_positive_i64(value: Option<&String>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value.floor() as i64).min(max))
        .unwrap_or(fallback)
}

async fn count_documents(db: &mongodb::Database, collection: &str, filter: Document) -> i64 {
    db.collection::<Document>(collection)
        .count_documents(filter)
        .await
        .unwrap_or_default() as i64
}

async fn seller_order_products(
    db: &mongodb::Database,
    orders: &[Document],
) -> HashMap<String, SellerOrderProduct> {
    let mut ids = orders
        .iter()
        .filter_map(|doc| doc.get_object_id("product").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    match db
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": ids } })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = document_id(&doc);
                let vendor = doc.get_document("vendor").ok();
                (
                    id.clone(),
                    SellerOrderProduct {
                        id,
                        name: document_string(&doc, "name"),
                        code: document_string(&doc, "code"),
                        brand: document_string(&doc, "brand"),
                        category: document_string(&doc, "category"),
                        vendor_name: vendor
                            .map(|value| document_string(value, "name"))
                            .unwrap_or_default(),
                        vendor_sku: vendor
                            .map(|value| document_string(value, "sku"))
                            .unwrap_or_default(),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

fn seller_admin_order_from_doc(
    document: Document,
    products: &HashMap<String, SellerOrderProduct>,
) -> SellerAdminOrderItem {
    let product_id = document
        .get_object_id("product")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    SellerAdminOrderItem {
        id: document_id(&document),
        ref_id: document_string(&document, "refId"),
        tr_id: document_string(&document, "trId"),
        pulsa_code: document_string(&document, "pulsaCode"),
        target: document_string(&document, "target"),
        price: read_i64(&document, "digiflazzPrice"),
        status: document_string(&document, "status"),
        rc: document_string(&document, "rc"),
        message: document_string(&document, "message"),
        sn: document_string(&document, "sn"),
        vendor_name: document_string(&document, "vendorName"),
        vendor_sku: document_string(&document, "vendorSku"),
        vendor_trx_id: document_string(&document, "vendorTrxId"),
        callback_required: document.get_bool("callbackRequired").unwrap_or(false),
        callback_attempt_count: read_i64(&document, "callbackAttemptCount"),
        callback_delivered_at: optional_date_string(&document, "callbackDeliveredAt"),
        callback_last_attempt_at: optional_date_string(&document, "callbackLastAttemptAt"),
        callback_next_retry_at: optional_date_string(&document, "callbackNextRetryAt"),
        callback_last_status_code: optional_i64(&document, "callbackLastStatusCode"),
        callback_last_message: document_string(&document, "callbackLastMessage"),
        request_ip: document_string(&document, "requestIp"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        product: products
            .get(&product_id)
            .map(|product| SellerAdminOrderProduct {
                id: product.id.clone(),
                name: product.name.clone(),
                code: product.code.clone(),
                brand: product.brand.clone(),
                category: product.category.clone(),
                vendor_name: product.vendor_name.clone(),
                vendor_sku: product.vendor_sku.clone(),
                active: true,
            }),
    }
}

fn build_seller_orders_csv(items: &[SellerAdminOrderItem]) -> String {
    let mut rows = vec![vec![
        "Order ID".to_string(),
        "Ref ID".to_string(),
        "TR ID".to_string(),
        "Pulsa Code".to_string(),
        "Produk".to_string(),
        "Kode Produk".to_string(),
        "Kategori".to_string(),
        "Brand".to_string(),
        "Vendor Supplier".to_string(),
        "Vendor SKU".to_string(),
        "Vendor Trx ID".to_string(),
        "Target".to_string(),
        "Harga Seller".to_string(),
        "Status".to_string(),
        "RC".to_string(),
        "Message".to_string(),
        "SN".to_string(),
        "Callback Required".to_string(),
        "Callback Attempts".to_string(),
        "Callback Delivered At".to_string(),
        "Callback Last Attempt At".to_string(),
        "Callback Next Retry At".to_string(),
        "Callback Status Code".to_string(),
        "Callback Message".to_string(),
        "Request IP".to_string(),
        "Created At".to_string(),
        "Updated At".to_string(),
    ]];

    for item in items {
        let product = item.product.as_ref();
        rows.push(vec![
            item.id.clone(),
            item.ref_id.clone(),
            item.tr_id.clone(),
            item.pulsa_code.clone(),
            product.map(|value| value.name.clone()).unwrap_or_default(),
            product.map(|value| value.code.clone()).unwrap_or_default(),
            product
                .map(|value| value.category.clone())
                .unwrap_or_default(),
            product.map(|value| value.brand.clone()).unwrap_or_default(),
            if item.vendor_name.is_empty() {
                product
                    .map(|value| value.vendor_name.clone())
                    .unwrap_or_default()
            } else {
                item.vendor_name.clone()
            },
            if item.vendor_sku.is_empty() {
                product
                    .map(|value| value.vendor_sku.clone())
                    .unwrap_or_default()
            } else {
                item.vendor_sku.clone()
            },
            item.vendor_trx_id.clone(),
            item.target.clone(),
            item.price.to_string(),
            item.status.clone(),
            item.rc.clone(),
            item.message.clone(),
            item.sn.clone(),
            if item.callback_required { "yes" } else { "no" }.to_string(),
            item.callback_attempt_count.to_string(),
            item.callback_delivered_at.clone().unwrap_or_default(),
            item.callback_last_attempt_at.clone().unwrap_or_default(),
            item.callback_next_retry_at.clone().unwrap_or_default(),
            item.callback_last_status_code
                .map(|value| value.to_string())
                .unwrap_or_default(),
            item.callback_last_message.clone(),
            item.request_ip.clone(),
            item.created_at.clone(),
            item.updated_at.clone(),
        ]);
    }

    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|value| csv_escape(&value))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv_escape(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn bson_to_json(value: &Bson) -> Value {
    match value {
        Bson::String(value) => Value::String(value.clone()),
        Bson::Boolean(value) => Value::Bool(*value),
        Bson::Int32(value) => serde_json::json!(*value),
        Bson::Int64(value) => serde_json::json!(*value),
        Bson::Double(value) => serde_json::json!(*value),
        Bson::DateTime(value) => Value::String(date_to_string(value)),
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::Document(document) => {
            let mut map = serde_json::Map::new();
            for (key, value) in document.iter() {
                map.insert(key.clone(), bson_to_json(value));
            }
            Value::Object(map)
        }
        Bson::Array(values) => Value::Array(values.iter().map(bson_to_json).collect()),
        Bson::Null => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

fn seller_order_from_doc(
    document: Document,
    products: &HashMap<String, SellerOrderProduct>,
) -> SellerOrderItem {
    let product_id = document
        .get_object_id("product")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    SellerOrderItem {
        id: document_id(&document),
        ref_id: document_string(&document, "refId"),
        tr_id: document_string(&document, "trId"),
        pulsa_code: document_string(&document, "pulsaCode"),
        target: document_string(&document, "target"),
        price: read_i64(&document, "digiflazzPrice"),
        status: document_string(&document, "status"),
        rc: document_string(&document, "rc"),
        message: document_string(&document, "message"),
        sn: document_string(&document, "sn"),
        vendor_trx_id: document_string(&document, "vendorTrxId"),
        callback_required: document.get_bool("callbackRequired").unwrap_or(false),
        callback_attempt_count: read_i64(&document, "callbackAttemptCount"),
        callback_delivered_at: optional_date_string(&document, "callbackDeliveredAt"),
        callback_last_attempt_at: optional_date_string(&document, "callbackLastAttemptAt"),
        callback_next_retry_at: optional_date_string(&document, "callbackNextRetryAt"),
        callback_last_status_code: optional_i64(&document, "callbackLastStatusCode"),
        callback_last_message: document_string(&document, "callbackLastMessage"),
        request_ip: document_string(&document, "requestIp"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        product: products.get(&product_id).cloned(),
    }
}

fn save_settings_error(code: &'static str) -> Response {
    let message = match code {
        "DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED" => {
            "Username dan API Key Digiflazz Seller wajib diisi"
        }
        "DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID" => {
            "Public Base URL wajib format http:// atau https:// yang valid"
        }
        "DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID" => {
            "Report / callback URL Digiflazz wajib format http:// atau https:// yang valid"
        }
        "DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID" => {
            "Whitelist IP hanya boleh berisi alamat IP valid, pisahkan dengan koma atau baris baru"
        }
        _ => "Gagal menyimpan konfigurasi Digiflazz Seller",
    };
    status_message(axum::http::StatusCode::BAD_REQUEST, message)
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admin_order_item_fixture() -> SellerAdminOrderItem {
        SellerAdminOrderItem {
            id: "507f1f77bcf86cd799439011".to_string(),
            ref_id: "seller-ref-fixture".to_string(),
            tr_id: "DSFIXTURE123456".to_string(),
            pulsa_code: "tsel10".to_string(),
            target: "081200000000".to_string(),
            price: 12_000,
            status: "success".to_string(),
            rc: "00".to_string(),
            message: "Success".to_string(),
            sn: "SN0001".to_string(),
            vendor_name: "TokoVoucher".to_string(),
            vendor_sku: "TSEL10".to_string(),
            vendor_trx_id: "VENDORTRX1".to_string(),
            callback_required: false,
            callback_attempt_count: 0,
            callback_delivered_at: None,
            callback_last_attempt_at: None,
            callback_next_retry_at: None,
            callback_last_status_code: None,
            callback_last_message: String::new(),
            request_ip: "127.0.0.1".to_string(),
            created_at: "2026-08-20T00:00:00.000Z".to_string(),
            updated_at: "2026-08-20T00:00:00.000Z".to_string(),
            product: None,
        }
    }

    fn mapping_summary_fixture() -> MappingSummary {
        MappingSummary { total: 2, active: 1 }
    }

    fn order_summary_fixture() -> OrderSummary {
        OrderSummary {
            total: 3,
            pending: 1,
            callback_pending: 1,
            callback_due_retry: 0,
            callback_high_attempt: 0,
        }
    }

    fn retry_queue_health_fixture() -> RetryQueueHealth {
        RetryQueueHealth {
            status: "idle".to_string(),
            source: "local".to_string(),
            last_run_at: None,
            processed: 0,
            success_count: 0,
            failed_count: 0,
            remaining_due: 0,
            last_error: String::new(),
        }
    }

    fn settings_response_fixture() -> SellerSettingsResponse {
        SellerSettingsResponse {
            configured: true,
            ready: true,
            username: "seller-fixture".to_string(),
            api_key_configured: true,
            public_base_url: "https://seller.example".to_string(),
            digiflazz_callback_url: "https://callback.example".to_string(),
            server_ip: "127.0.0.1".to_string(),
            reported_balance: 1_000_000,
            seller_margin_flat: 250,
            allowed_ips: vec!["127.0.0.1".to_string()],
            callback_enabled: true,
            prepaid_endpoint_path: "/api/v2/digiflazz-seller/prepaid".to_string(),
            prepaid_endpoint_url: "https://seller.example/api/v2/digiflazz-seller/prepaid".to_string(),
            mapping_summary: mapping_summary_fixture(),
            order_summary: order_summary_fixture(),
            retry_queue_health: retry_queue_health_fixture(),
        }
    }

    fn save_settings_response_fixture() -> SaveSettingsResponse {
        SaveSettingsResponse {
            success: true,
            message: "saved",
            configured: true,
            username: "seller-fixture".to_string(),
            api_key_configured: true,
            public_base_url: "https://seller.example".to_string(),
            digiflazz_callback_url: "https://callback.example".to_string(),
            server_ip: "127.0.0.1".to_string(),
            reported_balance: 1_000_000,
            seller_margin_flat: 250,
            allowed_ips: vec!["127.0.0.1".to_string()],
            callback_enabled: true,
            prepaid_endpoint_url: "https://seller.example/api/v2/digiflazz-seller/prepaid".to_string(),
        }
    }

    #[test]
    fn admin_order_item_json_never_exposes_raw_request() {
        let json = serde_json::to_value(admin_order_item_fixture()).unwrap();
        assert!(
            json.get("rawRequest").is_none(),
            "admin seller order DTO must not expose rawRequest"
        );
        assert!(!json.to_string().contains("fixture-signature"));
    }

    #[test]
    fn production_prepaid_source_never_inserts_raw_request() {
        let source = include_str!("digiflazz_seller/prepaid.rs");
        let tests = source.find("\n#[cfg(test)]").unwrap_or(source.len());
        let production = &source[..tests];
        assert!(
            !production.contains("\"rawRequest\":"),
            "production seller order writes must not persist rawRequest"
        );
    }

    #[test]
    fn settings_responses_expose_configured_boolean_without_key_fragments() {
        let read_json = serde_json::to_value(settings_response_fixture()).unwrap();
        assert_eq!(read_json["apiKeyConfigured"], serde_json::Value::Bool(true));
        assert!(read_json.get("apiKeyMasked").is_none());
        assert!(!read_json.to_string().contains("1234"));

        let save_json = serde_json::to_value(save_settings_response_fixture()).unwrap();
        assert_eq!(save_json["apiKeyConfigured"], serde_json::Value::Bool(true));
        assert!(save_json.get("apiKeyMasked").is_none());
        assert!(!save_json.to_string().contains("1234"));
    }
}
