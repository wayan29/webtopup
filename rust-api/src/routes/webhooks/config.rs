use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::Document;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    responses::{internal_error, provider_not_found, status_message, unavailable},
    store::{setting_string, tokovoucher_credentials_configured, upsert_setting},
    types::{
        DigiflazzWebhookConfig, TokovoucherWebhookConfig, WebhookConfigPayload, WebhookSaveResponse,
    },
    utils::{has_whitelist, normalize_whitelist, protection_mode},
};

pub async fn config(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match provider.as_str() {
        "digiflazz" => digiflazz_config(client, &state.mongo_db).await,
        "tokovoucher" => tokovoucher_config(client, &state.mongo_db).await,
        _ => provider_not_found(),
    }
}

pub async fn save_config(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    Json(payload): Json<WebhookConfigPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match provider.as_str() {
        "digiflazz" => save_digiflazz_config(client, &state.mongo_db, payload).await,
        "tokovoucher" => save_tokovoucher_config(client, &state.mongo_db, payload).await,
        _ => provider_not_found(),
    }
}

async fn digiflazz_config(client: &mongodb::Client, db_name: &str) -> Response {
    let settings = client.database(db_name).collection::<Document>("settings");
    let secret = setting_string(&settings, "digiflazzWebhookSecret").await;
    let whitelist_ip = setting_string(&settings, "digiflazzWhitelistIP").await;
    let has_secret = !secret.is_empty();
    let has_whitelist = has_whitelist(&whitelist_ip);
    Json(DigiflazzWebhookConfig {
        secret: if has_secret {
            "********".to_string()
        } else {
            String::new()
        },
        configured: has_secret,
        whitelist_ip,
        protected: has_secret || has_whitelist,
        protection_mode: protection_mode(has_secret, has_whitelist).to_string(),
    })
    .into_response()
}

async fn save_digiflazz_config(
    client: &mongodb::Client,
    db_name: &str,
    payload: WebhookConfigPayload,
) -> Response {
    let settings = client.database(db_name).collection::<Document>("settings");
    let normalized_secret = payload
        .secret
        .as_deref()
        .map(str::trim)
        .map(ToString::to_string);
    let normalized_whitelist = payload.whitelist_ip.as_deref().map(normalize_whitelist);
    let current_secret = setting_string(&settings, "digiflazzWebhookSecret").await;
    let next_secret = normalized_secret
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or(current_secret);
    let next_whitelist = normalized_whitelist.clone().unwrap_or_default();
    if next_secret.is_empty() && next_whitelist.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Minimal atur secret atau whitelist IP untuk mengamankan webhook Digiflazz",
        );
    }
    if let Some(secret) = normalized_secret.filter(|value| !value.is_empty()) {
        if upsert_setting(&settings, "digiflazzWebhookSecret", secret)
            .await
            .is_err()
        {
            return internal_error();
        }
    }
    if let Some(whitelist) = normalized_whitelist {
        if upsert_setting(&settings, "digiflazzWhitelistIP", whitelist)
            .await
            .is_err()
        {
            return internal_error();
        }
    }
    Json(WebhookSaveResponse {
        message: "Webhook config saved",
    })
    .into_response()
}

async fn tokovoucher_config(client: &mongodb::Client, db_name: &str) -> Response {
    let settings = client.database(db_name).collection::<Document>("settings");
    let whitelist_ip = setting_string(&settings, "tokovoucherWhitelistIP").await;
    let has_whitelist = has_whitelist(&whitelist_ip);
    let has_signature = tokovoucher_credentials_configured(client, db_name).await;
    Json(TokovoucherWebhookConfig {
        whitelist_ip,
        configured: has_signature,
        protected: has_signature || has_whitelist,
        protection_mode: protection_mode(has_signature, has_whitelist).to_string(),
    })
    .into_response()
}

async fn save_tokovoucher_config(
    client: &mongodb::Client,
    db_name: &str,
    payload: WebhookConfigPayload,
) -> Response {
    if !tokovoucher_credentials_configured(client, db_name).await {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Konfigurasi kredensial Tokovoucher terlebih dahulu sebelum mengatur webhook",
        );
    }
    if let Some(whitelist) = payload.whitelist_ip.as_deref().map(normalize_whitelist) {
        let settings = client.database(db_name).collection::<Document>("settings");
        if upsert_setting(&settings, "tokovoucherWhitelistIP", whitelist)
            .await
            .is_err()
        {
            return internal_error();
        }
    }
    Json(WebhookSaveResponse {
        message: "Webhook config saved",
    })
    .into_response()
}
