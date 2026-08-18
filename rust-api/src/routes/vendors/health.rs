use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, to_bson, Bson, DateTime, Document};
use serde_json::Value;

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::{
        bson::{read_i64, read_string},
        dates::{start_of_today_utc, timestamp_now},
    },
};

use super::{
    config::{
        digiflazz_credentials, find_vendor_by_name, has_any_non_empty_value,
        tokovoucher_credentials, vendor_base_url,
    },
    internal_error,
    json::{date_key, date_time_to_mongoose_string},
    providers::{fetch_digiflazz_balance_with_base_url, fetch_tokovoucher_balance_with_base_url},
    types::{
        SellerHealthSummary, TransactionStats, VendorHealthSnapshotResponse,
        VendorRealtimeHealthItem, VendorSnapshot, VendorSnapshotTotals, VendorStatsResponse,
        WebhookStats,
    },
    unavailable,
};

pub async fn vendor_health_snapshot(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };

    let Some(client) = &state.mongo_client else {
        return Json(VendorHealthSnapshotResponse {
            ok: false,
            service: "webtopup-api-v2",
            api_prefix: "/v2",
            generated_at: timestamp_now(),
            source: "mongodb-snapshot",
            user: proxy_context.into_response(),
            vendors: Vec::new(),
            totals: VendorSnapshotTotals::default(),
        })
        .into_response();
    };

    let db = client.database(&state.mongo_db);
    let vendor_docs = match db.collection::<Document>("vendors").find(doc! {}).await {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let tx_stats = transaction_stats_today(&db).await.unwrap_or_default();

    let mut vendors: Vec<VendorSnapshot> = vendor_docs
        .iter()
        .map(|vendor| build_vendor_snapshot(vendor, &tx_stats))
        .collect();
    vendors.sort_by(|left, right| left.label.cmp(&right.label));

    let totals = vendors.iter().fold(
        VendorSnapshotTotals {
            vendors: vendors.len(),
            ..VendorSnapshotTotals::default()
        },
        |mut totals, vendor| {
            match vendor.health {
                "healthy" => totals.healthy += 1,
                "warning" => totals.warning += 1,
                "critical" => totals.critical += 1,
                _ => {}
            }
            totals.transactions_today += vendor.transactions_today.total;
            totals
        },
    );

    Json(VendorHealthSnapshotResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        source: "mongodb-snapshot",
        user: proxy_context.into_response(),
        vendors,
        totals,
    })
    .into_response()
}

pub async fn vendor_health(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match build_vendor_health_payload(client, &state.mongo_db).await {
        Ok(payload) => {
            persist_vendor_health_snapshot(&client.database(&state.mongo_db), &payload).await;
            Json(payload).into_response()
        }
        Err(_) => internal_error(),
    }
}

pub async fn export_vendor_health_csv(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let payload = match build_vendor_health_payload(client, &state.mongo_db).await {
        Ok(payload) => payload,
        Err(_) => return internal_error(),
    };
    persist_vendor_health_snapshot(&client.database(&state.mongo_db), &payload).await;
    let csv = build_vendor_health_csv(&payload);
    let filename = format!("vendor-health-{}.csv", date_key(DateTime::now()));
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

pub async fn vendor_stats(
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
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                message: "Vendor not found",
            }),
        )
            .into_response();
    };

    let db = client.database(&state.mongo_db);
    let vendor = match db
        .collection::<Document>("vendors")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(vendor)) => vendor,
        _ => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    message: "Vendor not found",
                }),
            )
                .into_response();
        }
    };
    let vendor_name = read_string(&vendor, "name");
    let product_filter = doc! { "vendor.name": &vendor_name };
    let products = db.collection::<Document>("products");
    let total_products = products
        .count_documents(product_filter.clone())
        .await
        .unwrap_or_default() as i64;
    let active_products = products
        .count_documents(doc! { "vendor.name": &vendor_name, "status": true })
        .await
        .unwrap_or_default() as i64;
    let mut categories = products
        .distinct("category", product_filter)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    categories.sort();

    Json(VendorStatsResponse {
        vendor_name,
        total_products,
        active_products,
        categories,
        status: vendor.get_bool("status").unwrap_or(true),
    })
    .into_response()
}

pub(super) async fn transaction_stats_today(
    db: &mongodb::Database,
) -> mongodb::error::Result<HashMap<String, TransactionStats>> {
    let today = start_of_today_utc();
    let pipeline = vec![
        doc! { "$match": { "createdAt": { "$gte": today } } },
        doc! {
            "$lookup": {
                "from": "products",
                "localField": "product",
                "foreignField": "_id",
                "as": "product"
            }
        },
        doc! { "$unwind": { "path": "$product", "preserveNullAndEmptyArrays": true } },
        doc! {
            "$group": {
                "_id": { "$ifNull": ["$product.vendor.name", "Unknown"] },
                "total": { "$sum": 1 },
                "success": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, 1, 0] } },
                "failed": { "$sum": { "$cond": [{ "$eq": ["$status", "failed"] }, 1, 0] } },
                "pending": { "$sum": { "$cond": [{ "$in": ["$status", ["pending", "processing"]] }, 1, 0] } },
                "amountTotal": { "$sum": "$amount" }
            }
        },
    ];

    let mut cursor = db
        .collection::<Document>("transactions")
        .aggregate(pipeline)
        .await?;
    let mut stats = HashMap::new();

    while let Some(item) = cursor.try_next().await? {
        let key = item.get_str("_id").unwrap_or("unknown").to_lowercase();
        let total = read_i64(&item, "total");
        let success = read_i64(&item, "success");
        let success_rate = if total > 0 {
            ((success as f64 / total as f64) * 100.0).round() as i64
        } else {
            0
        };

        stats.insert(
            key,
            TransactionStats {
                total,
                success,
                failed: read_i64(&item, "failed"),
                pending: read_i64(&item, "pending"),
                success_rate,
                amount_total: read_i64(&item, "amountTotal"),
            },
        );
    }

    Ok(stats)
}

pub(super) async fn build_vendor_health_payload(
    client: &mongodb::Client,
    db_name: &str,
) -> mongodb::error::Result<Value> {
    let db = client.database(db_name);
    let digiflazz_vendor = find_vendor_by_name(client, db_name, "digiflazz").await;
    let tokovoucher_vendor = find_vendor_by_name(client, db_name, "tokovoucher").await;
    let tx_stats = transaction_stats_today(&db).await.unwrap_or_default();
    let webhook_stats = webhook_stats_today(&db).await.unwrap_or_default();
    let last_webhooks = last_webhook_stats(&db).await.unwrap_or_default();
    let seller = seller_health_summary(&db).await.unwrap_or_default();
    let digiflazz_balance = digiflazz_health_balance(digiflazz_vendor.as_ref()).await;
    let tokovoucher_balance = tokovoucher_health_balance(tokovoucher_vendor.as_ref()).await;

    let vendors = vec![
        build_realtime_vendor_health(
            "digiflazz",
            "Digiflazz",
            digiflazz_vendor.as_ref(),
            digiflazz_balance,
            &tx_stats,
            &webhook_stats,
            &last_webhooks,
        ),
        build_realtime_vendor_health(
            "tokovoucher",
            "Tokovoucher",
            tokovoucher_vendor.as_ref(),
            tokovoucher_balance,
            &tx_stats,
            &webhook_stats,
            &last_webhooks,
        ),
    ];
    Ok(serde_json::json!({
        "generatedAt": date_time_to_mongoose_string(DateTime::now()),
        "vendors": vendors,
        "seller": seller
    }))
}

async fn digiflazz_health_balance(vendor: Option<&Document>) -> (bool, Value, String) {
    let credentials = digiflazz_credentials(vendor);
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return (
            false,
            Value::from(0),
            "Credentials belum dikonfigurasi".to_string(),
        );
    }
    let balance = match fetch_digiflazz_balance_with_base_url(
        &credentials,
        &vendor
            .map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
            .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string()),
    )
    .await
    {
        Ok(balance) => (true, balance, "OK".to_string()),
        Err(message) => (false, Value::Null, message),
    };
    balance
}

async fn tokovoucher_health_balance(vendor: Option<&Document>) -> (bool, Value, String) {
    let credentials = tokovoucher_credentials(vendor);
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return (
            false,
            Value::from(0),
            "Credentials belum dikonfigurasi".to_string(),
        );
    }
    match fetch_tokovoucher_balance_with_base_url(
        &credentials,
        &vendor
            .map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net"))
            .unwrap_or_else(|| "https://api.tokovoucher.net".to_string()),
    )
    .await
    {
        Ok(balance) => (true, balance, "OK".to_string()),
        Err(message) => (false, Value::from(0), message),
    }
}

async fn persist_vendor_health_snapshot(db: &mongodb::Database, payload: &Value) {
    let now = DateTime::now();
    let Ok(value) = to_bson(payload) else {
        return;
    };

    let _ = db
        .collection::<Document>("settings")
        .update_one(
            doc! { "key": "vendorHealthSnapshot" },
            doc! {
                "$set": {
                    "key": "vendorHealthSnapshot",
                    "value": value,
                    "updatedAt": now,
                },
                "$setOnInsert": { "createdAt": now, "__v": 0 }
            },
        )
        .upsert(true)
        .await;
}

fn build_realtime_vendor_health(
    key: &str,
    label: &str,
    vendor: Option<&Document>,
    balance_result: (bool, Value, String),
    tx_stats: &HashMap<String, TransactionStats>,
    webhook_stats: &HashMap<String, WebhookStats>,
    last_webhooks: &HashMap<String, WebhookStats>,
) -> VendorRealtimeHealthItem {
    let config = vendor.and_then(|vendor| vendor.get_document("config").ok());
    let configured = match key {
        "digiflazz" => {
            digiflazz_credentials(vendor).username.len() > 0
                && digiflazz_credentials(vendor).secret.len() > 0
        }
        "tokovoucher" => {
            tokovoucher_credentials(vendor).username.len() > 0
                && tokovoucher_credentials(vendor).secret.len() > 0
        }
        _ => config.map(has_any_non_empty_value).unwrap_or(false),
    };
    let active = vendor
        .and_then(|vendor| vendor.get_bool("status").ok())
        .unwrap_or(true);
    let low_balance_threshold = vendor
        .map(|vendor| read_i64(vendor, "lowBalanceThreshold"))
        .unwrap_or(0);
    let (balance_ok, balance, balance_message) = balance_result;
    let balance_number = json_i64(&balance);
    let low_balance =
        balance_ok && low_balance_threshold > 0 && balance_number <= low_balance_threshold;
    let transactions_today = tx_stats
        .iter()
        .find(|(name, _)| name.contains(key))
        .map(|(_, stats)| stats.clone())
        .unwrap_or_default();
    let mut webhook_today = webhook_stats.get(key).cloned().unwrap_or_default();
    if let Some(last) = last_webhooks.get(key) {
        webhook_today.last_at = last.last_at.clone();
        webhook_today.last_status = last.last_status.clone();
        webhook_today.last_message = last.last_message.clone();
    }
    let health = resolve_realtime_health(
        configured,
        active,
        balance_ok,
        low_balance,
        transactions_today.pending,
        transactions_today.failed,
        webhook_today.rejected,
    );

    VendorRealtimeHealthItem {
        key: key.to_string(),
        label: label.to_string(),
        configured,
        active,
        balance,
        balance_ok,
        low_balance_threshold,
        low_balance,
        balance_message,
        health,
        transactions_today,
        webhook_today,
    }
}

fn resolve_realtime_health(
    configured: bool,
    active: bool,
    balance_ok: bool,
    low_balance: bool,
    pending_count: i64,
    failed_count: i64,
    rejected_webhook_count: i64,
) -> &'static str {
    if !configured || !active || !balance_ok || failed_count > 5 || rejected_webhook_count > 0 {
        "critical"
    } else if low_balance || pending_count > 10 || failed_count > 0 {
        "warning"
    } else {
        "healthy"
    }
}

async fn webhook_stats_today(
    db: &mongodb::Database,
) -> mongodb::error::Result<HashMap<String, WebhookStats>> {
    let pipeline = vec![
        doc! { "$match": { "createdAt": { "$gte": start_of_today_utc() } } },
        doc! {
            "$group": {
                "_id": "$provider",
                "total": { "$sum": 1 },
                "rejected": { "$sum": { "$cond": [{ "$eq": ["$status", "rejected"] }, 1, 0] } },
                "failed": { "$sum": { "$cond": [{ "$in": ["$status", ["failed", "error"]] }, 1, 0] } },
                "delivered": { "$sum": { "$cond": ["$verified", 1, 0] } }
            }
        },
    ];
    let mut cursor = db
        .collection::<Document>("webhookeventlogs")
        .aggregate(pipeline)
        .await?;
    let mut stats = HashMap::new();
    while let Some(item) = cursor.try_next().await? {
        stats.insert(
            read_string(&item, "_id"),
            WebhookStats {
                total: read_i64(&item, "total"),
                rejected: read_i64(&item, "rejected"),
                failed: read_i64(&item, "failed"),
                delivered: read_i64(&item, "delivered"),
                ..WebhookStats::default()
            },
        );
    }
    Ok(stats)
}

async fn last_webhook_stats(
    db: &mongodb::Database,
) -> mongodb::error::Result<HashMap<String, WebhookStats>> {
    let pipeline = vec![
        doc! { "$sort": { "createdAt": -1 } },
        doc! {
            "$group": {
                "_id": "$provider",
                "lastAt": { "$first": "$createdAt" },
                "lastStatus": { "$first": "$status" },
                "lastMessage": { "$first": "$message" }
            }
        },
    ];
    let mut cursor = db
        .collection::<Document>("webhookeventlogs")
        .aggregate(pipeline)
        .await?;
    let mut stats = HashMap::new();
    while let Some(item) = cursor.try_next().await? {
        stats.insert(
            read_string(&item, "_id"),
            WebhookStats {
                last_at: item
                    .get_datetime("lastAt")
                    .ok()
                    .map(|value| date_time_to_mongoose_string(*value)),
                last_status: read_string(&item, "lastStatus"),
                last_message: read_string(&item, "lastMessage"),
                ..WebhookStats::default()
            },
        );
    }
    Ok(stats)
}

async fn seller_health_summary(
    db: &mongodb::Database,
) -> mongodb::error::Result<SellerHealthSummary> {
    let pipeline = vec![doc! {
        "$group": {
            "_id": Bson::Null,
            "total": { "$sum": 1 },
            "pending": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, 1, 0] } },
            "failed": { "$sum": { "$cond": [{ "$eq": ["$status", "failed"] }, 1, 0] } },
            "callbackPending": { "$sum": { "$cond": [{ "$eq": ["$callbackRequired", true] }, 1, 0] } },
            "callbackDelivered": { "$sum": { "$cond": [{ "$ne": [{ "$ifNull": ["$callbackDeliveredAt", Bson::Null] }, Bson::Null] }, 1, 0] } }
        }
    }];
    let mut cursor = db
        .collection::<Document>("digiflazzsellerorders")
        .aggregate(pipeline)
        .await?;
    let Some(item) = cursor.try_next().await? else {
        return Ok(SellerHealthSummary::default());
    };
    let callback_pending = read_i64(&item, "callbackPending");
    let failed = read_i64(&item, "failed");
    Ok(SellerHealthSummary {
        total: read_i64(&item, "total"),
        pending: read_i64(&item, "pending"),
        failed,
        callback_pending,
        callback_delivered: read_i64(&item, "callbackDelivered"),
        health: if callback_pending > 0 || failed > 5 {
            "warning"
        } else {
            "healthy"
        },
    })
}

pub(super) fn build_vendor_health_csv(payload: &Value) -> String {
    let header = vec![
        "Vendor",
        "Health",
        "Configured",
        "Active",
        "Balance",
        "Balance OK",
        "Low Balance Threshold",
        "Low Balance",
        "Balance Message",
        "Transactions Today",
        "Success Today",
        "Failed Today",
        "Pending Today",
        "Success Rate",
        "Amount Total",
        "Webhook Total",
        "Webhook Rejected",
        "Webhook Failed",
        "Webhook Delivered",
        "Last Webhook At",
        "Last Webhook Status",
        "Last Webhook Message",
        "Generated At",
    ];
    let generated_at = payload
        .get("generatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut rows = vec![header
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()];
    if let Some(vendors) = payload.get("vendors").and_then(Value::as_array) {
        for vendor in vendors {
            rows.push(vec![
                json_string(vendor, "label"),
                json_string(vendor, "health"),
                yes_no(json_bool(vendor, "configured")),
                yes_no(json_bool(vendor, "active")),
                json_value_string(vendor.get("balance")),
                yes_no(json_bool(vendor, "balanceOk")),
                json_value_string(vendor.get("lowBalanceThreshold")),
                yes_no(json_bool(vendor, "lowBalance")),
                json_string(vendor, "balanceMessage"),
                nested_json_value_string(vendor, "transactionsToday", "total"),
                nested_json_value_string(vendor, "transactionsToday", "success"),
                nested_json_value_string(vendor, "transactionsToday", "failed"),
                nested_json_value_string(vendor, "transactionsToday", "pending"),
                nested_json_value_string(vendor, "transactionsToday", "successRate"),
                nested_json_value_string(vendor, "transactionsToday", "amountTotal"),
                nested_json_value_string(vendor, "webhookToday", "total"),
                nested_json_value_string(vendor, "webhookToday", "rejected"),
                nested_json_value_string(vendor, "webhookToday", "failed"),
                nested_json_value_string(vendor, "webhookToday", "delivered"),
                nested_json_value_string(vendor, "webhookToday", "lastAt"),
                nested_json_value_string(vendor, "webhookToday", "lastStatus"),
                nested_json_value_string(vendor, "webhookToday", "lastMessage"),
                generated_at.to_string(),
            ]);
        }
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

fn json_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or_default(),
        Value::String(text) => text.parse::<i64>().unwrap_or_default(),
        _ => 0,
    }
}

pub(super) fn build_vendor_snapshot(
    vendor: &Document,
    tx_stats: &HashMap<String, TransactionStats>,
) -> VendorSnapshot {
    let label = vendor.get_str("name").unwrap_or("Unknown").to_string();
    let key = label.to_lowercase();
    let active = vendor.get_bool("status").unwrap_or(true);
    let config = vendor.get_document("config").ok();
    let configured = config.map(has_any_non_empty_value).unwrap_or(false);
    let low_balance_threshold = read_i64(vendor, "lowBalanceThreshold");
    let transactions_today = tx_stats
        .iter()
        .find(|(name, _)| name.contains(&key) || key.contains(name.as_str()))
        .map(|(_, stats)| stats.clone())
        .unwrap_or_default();
    let (health, health_reason) = resolve_snapshot_health(configured, active, &transactions_today);

    VendorSnapshot {
        key,
        label,
        configured,
        active,
        low_balance_threshold,
        health,
        health_reason,
        transactions_today,
    }
}

fn resolve_snapshot_health(
    configured: bool,
    active: bool,
    stats: &TransactionStats,
) -> (&'static str, String) {
    if !configured {
        return ("critical", "Credentials belum dikonfigurasi".to_string());
    }

    if !active {
        return ("critical", "Vendor tidak aktif".to_string());
    }

    if stats.pending > 10 || stats.failed > 5 {
        return (
            "warning",
            format!(
                "Transaksi hari ini perlu perhatian: {} pending, {} gagal",
                stats.pending, stats.failed
            ),
        );
    }

    ("healthy", "Snapshot MongoDB terlihat normal".to_string())
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn json_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn json_value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn nested_json_value_string(value: &Value, parent: &str, key: &str) -> String {
    json_value_string(value.get(parent).and_then(|parent| parent.get(key)))
}

fn yes_no(value: bool) -> String {
    if value { "yes" } else { "no" }.to_string()
}

fn csv_escape(value: &str) -> String {
    let dangerous = value
        .trim_start_matches(|character: char| character.is_whitespace() || character.is_control())
        .starts_with(['=', '+', '-', '@']);
    let safe = if dangerous {
        format!("'{value}")
    } else {
        value.to_string()
    };

    if safe.contains(',') || safe.contains('"') || safe.contains('\n') || safe.contains('\r') {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}
