use std::sync::Arc;

use axum::{
    extract::State,
    http::HeaderMap,
    response::IntoResponse,
    response::Response,
    Json,
};
use mongodb::bson::{doc, Bson, DateTime, Document};
use serde_json::{json, Value};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::require_proxy_context,
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    internal_error, status_message, string_array, unavailable, EmptyStringFallback, CONFIG_KEY,
    DEFAULT_ENDPOINT, DEFAULT_PREPAID_PATH,
};
use super::types::{
    validated_irs_formatter, IrsMappingSummary, IrsSettingsResponse, SaveIrsSettingsPayload,
};

pub async fn settings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let config = match stored_config(&db).await {
        Ok(config) => config.unwrap_or_default(),
        Err(_) => return internal_error(),
    };
    let active_mappings = match db
        .collection::<Document>("digiflazzsellerproductmaps")
        .count_documents(doc! { "isActive": true })
        .await
    {
        Ok(count) => count as i64,
        Err(_) => return internal_error(),
    };
    Json(irs_settings_response(&config, active_mappings)).into_response()
}

pub(super) fn irs_settings_response(config: &Document, active_mappings: i64) -> IrsSettingsResponse {
    let merchant_id = read_string(config, "merchantId");
    let password_configured = !read_string(config, "password").is_empty();
    let pin_configured = !read_string(config, "pin").is_empty();
    let secret_configured = !read_string(config, "secret").is_empty();
    let configured =
        !merchant_id.is_empty() && password_configured && pin_configured && secret_configured;
    IrsSettingsResponse {
        configured,
        ready: configured && active_mappings > 0,
        enabled: config.get_bool("enabled").unwrap_or(false),
        merchant_id,
        password_configured,
        pin_configured,
        secret_configured,
        endpoint_url: read_string(config, "endpointUrl").if_empty(DEFAULT_ENDPOINT),
        allowed_ips: string_array(config, "allowedIps"),
        seller_margin_flat: read_i64(config, "sellerMarginFlat"),
        callback_enabled: config.get_bool("callbackEnabled").unwrap_or(false),
        callback_url: read_string(config, "callbackUrl"),
        prepaid_endpoint_path: DEFAULT_PREPAID_PATH.to_string(),
        mapping_summary: IrsMappingSummary {
            active: active_mappings,
        },
    }
}

pub(super) async fn stored_config(
    db: &mongodb::Database,
) -> mongodb::error::Result<Option<Document>> {
    let document = db
        .collection::<Document>("settings")
        .find_one(doc! { "key": CONFIG_KEY })
        .await?;
    Ok(document.and_then(|document| document.get_document("value").ok().cloned()))
}

pub async fn save_settings(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
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
    let current = match stored_config(&db).await {
        Ok(config) => config.unwrap_or_default(),
        Err(_) => return internal_error(),
    };
    let typed = SaveIrsSettingsPayload::from_value(&payload);
    let formatter = match validated_irs_formatter(typed.formatter.as_ref()) {
        Ok(Some(document)) => Bson::Document(document),
        Ok(None) => current
            .get("formatter")
            .cloned()
            .unwrap_or_else(default_formatter_bson),
        Err(_) => {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "Formatter IRS tidak valid")
        }
    };
    let value = doc! {
        "enabled": typed.enabled.unwrap_or_else(|| current.get_bool("enabled").unwrap_or(false)),
        "merchantId": typed.merchant_id.unwrap_or_else(|| read_string(&current, "merchantId")),
        "password": typed.password.unwrap_or_else(|| read_string(&current, "password")),
        "pin": typed.pin.unwrap_or_else(|| read_string(&current, "pin")),
        "secret": typed.secret.unwrap_or_else(|| read_string(&current, "secret")),
        "endpointUrl": typed.endpoint_url.unwrap_or_else(|| read_string(&current, "endpointUrl")).if_empty(DEFAULT_ENDPOINT),
        "allowedIps": typed.allowed_ips.map(|items| items.into_iter().map(Bson::String).collect::<Vec<_>>()).unwrap_or_else(|| current.get_array("allowedIps").cloned().unwrap_or_default()),
        "sellerMarginFlat": typed.seller_margin_flat.unwrap_or_else(|| read_i64(&current, "sellerMarginFlat")),
        "callbackEnabled": typed.callback_enabled.unwrap_or_else(|| current.get_bool("callbackEnabled").unwrap_or(false)),
        "callbackUrl": typed.callback_url.unwrap_or_else(|| read_string(&current, "callbackUrl")),
        "formatter": formatter,
        "updatedAt": DateTime::now(),
    };
    if db
        .collection::<Document>("settings")
        .update_one(
            doc! { "key": CONFIG_KEY },
            doc! { "$set": { "key": CONFIG_KEY, "value": value, "description": "Konfigurasi IRS Seller" } },
        )
        .upsert(true)
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(json!({ "success": true, "message": "Konfigurasi IRS Seller berhasil disimpan" }))
        .into_response()
}

fn default_formatter_bson() -> Bson {
    Bson::Document(doc! {"sn": {"start": "", "end": ""}})
}
