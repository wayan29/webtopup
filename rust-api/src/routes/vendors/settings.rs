use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group, security::require_proxy_context, state::AppState,
};

use super::{
    config::{
        digiflazz_credentials, find_vendor_by_name, mask_secret, normalize_payload_string,
        normalized_config_string, tokovoucher_credentials, vendor_base_url,
    },
    internal_error,
    providers::{fetch_digiflazz_balance_with_base_url, fetch_tokovoucher_balance_with_base_url},
    status_message,
    types::{
        DigiflazzSettingsPayload, DigiflazzSettingsResponse, TokovoucherSettingsPayload,
        TokovoucherSettingsResponse, VendorCredentials,
    },
    unavailable, vendor_id,
};

pub async fn digiflazz_settings(
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
    let config = vendor
        .as_ref()
        .and_then(|doc| doc.get_document("config").ok());
    let username = config
        .and_then(|doc| normalized_config_string(doc, "username"))
        .unwrap_or_default();
    let api_key = config
        .and_then(|doc| normalized_config_string(doc, "apiKey"))
        .unwrap_or_default();

    Json(DigiflazzSettingsResponse {
        configured: !username.is_empty() && !api_key.is_empty(),
        vendor_id: vendor.as_ref().map(vendor_id),
        username,
        api_key: mask_secret(&api_key),
        status: vendor
            .as_ref()
            .and_then(|doc| doc.get_bool("status").ok())
            .unwrap_or(true),
    })
    .into_response()
}

pub async fn save_digiflazz_settings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DigiflazzSettingsPayload>,
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
    let vendors = client
        .database(&state.mongo_db)
        .collection::<Document>("vendors");
    let vendor = find_vendor_by_name(client, &state.mongo_db, "digiflazz").await;
    let current = digiflazz_credentials(vendor.as_ref());
    let next_username = normalize_payload_string(payload.username).unwrap_or(current.username);
    let next_api_key = normalize_payload_string(payload.api_key).unwrap_or(current.secret);

    if next_username.is_empty() || next_api_key.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Username dan API Key wajib tersedia. Lengkapi field yang masih kosong.",
        );
    }

    let credentials = VendorCredentials {
        username: next_username.clone(),
        secret: next_api_key.clone(),
    };
    let base_url = vendor
        .as_ref()
        .map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
        .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let balance = fetch_digiflazz_balance_with_base_url(&credentials, &base_url).await;

    let vendor_id = if let Some(vendor) = vendor {
        let Ok(object_id) = vendor.get_object_id("_id") else {
            return internal_error();
        };
        let mut config = vendor.get_document("config").cloned().unwrap_or_default();
        config.insert("username", next_username);
        config.insert("apiKey", next_api_key);
        let update =
            doc! { "$set": { "config": config, "status": true, "updatedAt": DateTime::now() } };
        if vendors
            .update_one(doc! { "_id": object_id }, update)
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Failed to save settings. Check your credentials.",
            );
        }
        object_id.to_hex()
    } else {
        let now = DateTime::now();
        let document = doc! { "name": "Digiflazz", "apiBaseUrl": "https://api.digiflazz.com/v1", "config": { "username": next_username, "apiKey": next_api_key }, "status": true, "createdAt": now, "updatedAt": now, "__v": 0 };
        let Ok(result) = vendors.insert_one(document).await else {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Failed to save settings. Check your credentials.",
            );
        };
        result
            .inserted_id
            .as_object_id()
            .map(|id| id.to_hex())
            .unwrap_or_default()
    };

    Json(serde_json::json!({ "success": true, "message": "Settings saved successfully", "balance": balance, "vendorId": vendor_id })).into_response()
}

pub async fn tokovoucher_settings(
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
    let config = vendor
        .as_ref()
        .and_then(|doc| doc.get_document("config").ok());
    let member_code = config
        .and_then(|doc| {
            normalized_config_string(doc, "memberCode")
                .or_else(|| normalized_config_string(doc, "apiKey"))
        })
        .unwrap_or_default();
    let secret = config
        .and_then(|doc| normalized_config_string(doc, "secret"))
        .unwrap_or_default();

    Json(TokovoucherSettingsResponse {
        configured: !member_code.is_empty() && !secret.is_empty(),
        vendor_id: vendor.as_ref().map(vendor_id),
        member_code,
        secret: mask_secret(&secret),
        status: vendor
            .as_ref()
            .and_then(|doc| doc.get_bool("status").ok())
            .unwrap_or(true),
    })
    .into_response()
}

pub async fn save_tokovoucher_settings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TokovoucherSettingsPayload>,
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
    let vendors = client
        .database(&state.mongo_db)
        .collection::<Document>("vendors");
    let vendor = find_vendor_by_name(client, &state.mongo_db, "tokovoucher").await;
    let current = tokovoucher_credentials(vendor.as_ref());
    let next_member_code =
        normalize_payload_string(payload.member_code).unwrap_or(current.username);
    let next_secret = normalize_payload_string(payload.secret).unwrap_or(current.secret);

    if next_member_code.is_empty() || next_secret.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Member Code dan Secret wajib tersedia. Lengkapi field yang masih kosong.",
        );
    }

    let credentials = VendorCredentials {
        username: next_member_code.clone(),
        secret: next_secret.clone(),
    };
    let base_url = vendor
        .as_ref()
        .map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net"))
        .unwrap_or_else(|| "https://api.tokovoucher.net".to_string());
    let balance = match fetch_tokovoucher_balance_with_base_url(&credentials, &base_url).await {
        Ok(balance) => balance,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Failed to save settings. Check your credentials.",
            )
        }
    };

    let vendor_id = if let Some(vendor) = vendor {
        let Ok(object_id) = vendor.get_object_id("_id") else {
            return internal_error();
        };
        let mut config = vendor.get_document("config").cloned().unwrap_or_default();
        config.insert("memberCode", next_member_code);
        config.insert("secret", next_secret);
        let update =
            doc! { "$set": { "config": config, "status": true, "updatedAt": DateTime::now() } };
        if vendors
            .update_one(doc! { "_id": object_id }, update)
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Failed to save settings. Check your credentials.",
            );
        }
        object_id.to_hex()
    } else {
        let now = DateTime::now();
        let document = doc! { "name": "Tokovoucher", "slug": "tokovoucher", "apiBaseUrl": "https://api.tokovoucher.id", "config": { "memberCode": next_member_code, "secret": next_secret }, "status": true, "createdAt": now, "updatedAt": now, "__v": 0 };
        let Ok(result) = vendors.insert_one(document).await else {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Failed to save settings. Check your credentials.",
            );
        };
        result
            .inserted_id
            .as_object_id()
            .map(|id| id.to_hex())
            .unwrap_or_default()
    };

    Json(serde_json::json!({ "success": true, "message": "Settings saved successfully", "balance": balance, "vendorId": vendor_id })).into_response()
}
