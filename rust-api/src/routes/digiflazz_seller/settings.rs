use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group, security::require_proxy_context, state::AppState,
    utils::bson::read_i64,
};

use super::{
    allowed_ips, bool_from_value, bson_to_json, callback_pending_expression, count_documents,
    document_string, internal_error, join_url, mask_api_key, non_negative_i64, normalize_url,
    optional_bool, optional_date_or_string, save_settings_error, text_from_value, unavailable,
    validate_allowed_ips, validate_http_url, EmptyStringFallback, MappingSummary, OrderSummary,
    RetryQueueHealth, SaveSettingsPayload, SaveSettingsResponse, SellerConfig,
    SellerSettingsResponse,
};

const CONFIG_KEY: &str = "digiflazzSellerConfig";
const RETRY_HEALTH_KEY: &str = "digiflazzSellerRetryQueueHealth";
const DEFAULT_CALLBACK_URL: &str = "https://api.digiflazz.com/v1/seller/callback";
const DEFAULT_ALLOWED_IP: &str = "52.74.250.133";
const PREPAID_PATH: &str = "/api/v2/digiflazz-seller/prepaid";
const HIGH_CALLBACK_ATTEMPT_THRESHOLD: i64 = 5;

pub async fn settings(
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
    let config = seller_config(&db).await;
    let total_mappings = count_documents(&db, "digiflazzsellerproductmaps", doc! {}).await;
    let active_mappings =
        count_documents(&db, "digiflazzsellerproductmaps", doc! { "isActive": true }).await;
    let order_summary = seller_order_summary(&db).await;
    let retry_queue_health = retry_queue_health(&db).await;
    let configured = !config.username.is_empty() && !config.api_key.is_empty();

    Json(SellerSettingsResponse {
        configured,
        ready: configured && !config.public_base_url.is_empty() && active_mappings > 0,
        username: config.username.clone(),
        api_key_masked: mask_api_key(&config.api_key),
        public_base_url: config.public_base_url.clone(),
        digiflazz_callback_url: config.digiflazz_callback_url.clone(),
        server_ip: config.server_ip.clone(),
        reported_balance: config.reported_balance,
        seller_margin_flat: config.seller_margin_flat,
        allowed_ips: config.allowed_ips.clone(),
        callback_enabled: config.callback_enabled,
        prepaid_endpoint_path: config.prepaid_endpoint_path.clone(),
        prepaid_endpoint_url: config.prepaid_endpoint_url.clone(),
        mapping_summary: MappingSummary {
            total: total_mappings,
            active: active_mappings,
        },
        order_summary,
        retry_queue_health,
    })
    .into_response()
}

pub async fn save_settings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveSettingsPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let current = stored_seller_config(&db).await;
    let api_key = payload
        .api_key
        .as_ref()
        .map(text_from_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| document_string(&current, "apiKey"));
    let public_base_url = match validate_http_url(
        &normalize_url(
            payload
                .public_base_url
                .as_ref()
                .map(text_from_value)
                .unwrap_or_else(|| document_string(&current, "publicBaseUrl")),
        ),
        "DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID",
    ) {
        Ok(value) => value,
        Err(message) => return save_settings_error(message),
    };
    let callback_url_input = normalize_url(
        payload
            .digiflazz_callback_url
            .as_ref()
            .map(text_from_value)
            .unwrap_or_else(|| document_string(&current, "digiflazzCallbackUrl")),
    );
    let digiflazz_callback_url =
        match validate_http_url(&callback_url_input, "DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID") {
            Ok(value) => value.if_empty(DEFAULT_CALLBACK_URL),
            Err(message) => return save_settings_error(message),
        };
    let allowed_ips_value = payload
        .allowed_ips
        .clone()
        .unwrap_or_else(|| bson_to_json(current.get("allowedIps").unwrap_or(&Bson::Null)));
    let allowed_ips = match validate_allowed_ips(&allowed_ips_value) {
        Ok(ips) if ips.is_empty() => vec![DEFAULT_ALLOWED_IP.to_string()],
        Ok(ips) => ips,
        Err(message) => return save_settings_error(message),
    };

    let username = payload
        .username
        .as_ref()
        .map(text_from_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| document_string(&current, "username"));
    let next_config = doc! {
        "username": username.clone(),
        "apiKey": api_key.clone(),
        "publicBaseUrl": public_base_url.clone(),
        "digiflazzCallbackUrl": digiflazz_callback_url.clone(),
        "serverIp": payload.server_ip.as_ref().map(text_from_value).unwrap_or_else(|| document_string(&current, "serverIp")),
        "reportedBalance": non_negative_i64(payload.reported_balance.as_ref(), read_i64(&current, "reportedBalance")),
        "sellerMarginFlat": non_negative_i64(payload.seller_margin_flat.as_ref(), read_i64(&current, "sellerMarginFlat")),
        "allowedIps": allowed_ips.clone(),
        "callbackEnabled": bool_from_value(payload.callback_enabled.as_ref()).unwrap_or_else(|| optional_bool(&current, "callbackEnabled").unwrap_or(true)),
    };

    if username.is_empty() || api_key.is_empty() {
        return save_settings_error("DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED");
    }

    let settings = db.collection::<Document>("settings");
    if settings
        .update_one(
            doc! { "key": CONFIG_KEY },
            doc! { "$set": { "key": CONFIG_KEY, "value": next_config, "description": "Konfigurasi Digiflazz Seller" } },
        )
        .upsert(true)
        .await
        .is_err()
    {
        return internal_error();
    }

    let saved_config = seller_config(&db).await;
    Json(SaveSettingsResponse {
        success: true,
        message: "Konfigurasi Digiflazz Seller berhasil disimpan",
        configured: true,
        username: saved_config.username,
        api_key_masked: mask_api_key(&saved_config.api_key),
        public_base_url: saved_config.public_base_url,
        digiflazz_callback_url: saved_config.digiflazz_callback_url,
        server_ip: saved_config.server_ip,
        reported_balance: saved_config.reported_balance,
        seller_margin_flat: saved_config.seller_margin_flat,
        allowed_ips: saved_config.allowed_ips,
        callback_enabled: saved_config.callback_enabled,
        prepaid_endpoint_url: saved_config.prepaid_endpoint_url,
    })
    .into_response()
}

pub(super) async fn seller_config(db: &mongodb::Database) -> SellerConfig {
    let stored = stored_seller_config(db).await;
    let public_base_url = normalize_url(document_string(&stored, "publicBaseUrl"));
    let prepaid_endpoint_path = PREPAID_PATH.to_string();
    let prepaid_endpoint_url = join_url(&public_base_url, &prepaid_endpoint_path);

    SellerConfig {
        username: document_string(&stored, "username"),
        api_key: document_string(&stored, "apiKey"),
        public_base_url,
        digiflazz_callback_url: normalize_url(document_string(&stored, "digiflazzCallbackUrl"))
            .if_empty(DEFAULT_CALLBACK_URL),
        server_ip: document_string(&stored, "serverIp"),
        reported_balance: read_i64(&stored, "reportedBalance"),
        seller_margin_flat: read_i64(&stored, "sellerMarginFlat"),
        allowed_ips: allowed_ips(stored.get("allowedIps")),
        callback_enabled: optional_bool(&stored, "callbackEnabled").unwrap_or(true),
        prepaid_endpoint_path,
        prepaid_endpoint_url,
    }
}

async fn stored_seller_config(db: &mongodb::Database) -> Document {
    db.collection::<Document>("settings")
        .find_one(doc! { "key": CONFIG_KEY })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned())
        .unwrap_or_default()
}

async fn retry_queue_health(db: &mongodb::Database) -> RetryQueueHealth {
    let value = db
        .collection::<Document>("settings")
        .find_one(doc! { "key": RETRY_HEALTH_KEY })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned())
        .unwrap_or_default();
    RetryQueueHealth {
        status: document_string(&value, "status").if_empty("never"),
        source: document_string(&value, "source").if_empty("unknown"),
        last_run_at: optional_date_or_string(&value, "lastRunAt"),
        processed: read_i64(&value, "processed"),
        success_count: read_i64(&value, "successCount"),
        failed_count: read_i64(&value, "failedCount"),
        remaining_due: read_i64(&value, "remainingDue"),
        last_error: document_string(&value, "lastError"),
    }
}

async fn seller_order_summary(db: &mongodb::Database) -> OrderSummary {
    let now = DateTime::now();
    match db
        .collection::<Document>("digiflazzsellerorders")
        .aggregate(vec![doc! { "$group": {
            "_id": Bson::Null,
            "total": { "$sum": 1 },
            "pending": { "$sum": { "$cond": [ { "$eq": ["$status", "pending"] }, 1, 0 ] } },
            "callbackPending": { "$sum": { "$cond": [ callback_pending_expression(), 1, 0 ] } },
            "callbackDueRetry": { "$sum": { "$cond": [ { "$and": [
                { "$eq": ["$callbackRequired", true] },
                { "$ne": ["$status", "pending"] },
                { "$or": [
                    { "$eq": [ { "$ifNull": ["$callbackNextRetryAt", Bson::Null] }, Bson::Null ] },
                    { "$lte": ["$callbackNextRetryAt", now] }
                ] }
            ] }, 1, 0 ] } },
            "callbackHighAttempt": { "$sum": { "$cond": [ { "$and": [
                { "$eq": ["$callbackRequired", true] },
                { "$gte": [ { "$ifNull": ["$callbackAttemptCount", 0] }, HIGH_CALLBACK_ATTEMPT_THRESHOLD ] }
            ] }, 1, 0 ] } }
        } }])
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .first()
            .map(|doc| OrderSummary {
                total: read_i64(doc, "total"),
                pending: read_i64(doc, "pending"),
                callback_pending: read_i64(doc, "callbackPending"),
                callback_due_retry: read_i64(doc, "callbackDueRetry"),
                callback_high_attempt: read_i64(doc, "callbackHighAttempt"),
            })
            .unwrap_or_default(),
        Err(_) => OrderSummary::default(),
    }
}
