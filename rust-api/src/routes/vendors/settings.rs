use std::sync::Arc;

use axum::{extract::State, response::{IntoResponse, Response}, Json};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{security::{require_proxy_context, require_sql_user}, sql_auth::verify_step_up, state::AppState};

use super::{
    config::{digiflazz_credentials, find_vendor_by_name, mask_secret, normalize_payload_string, normalized_config_string, tokovoucher_credentials, vendor_base_url},
    internal_error,
    providers::{fetch_digiflazz_balance_with_base_url, fetch_tokovoucher_balance_with_base_url},
    status_message,
    types::{DigiflazzSettingsPayload, DigiflazzSettingsResponse, TokovoucherSettingsPayload, TokovoucherSettingsResponse, VendorCredentials},
};

async fn require_credentials_step_up(headers: &axum::http::HeaderMap, state: &AppState) -> Result<(), Response> {
    let actor = require_sql_user(headers, state).await?;
    verify_step_up(headers, state, &actor, "integrations.credentials", Utc::now()).map_err(IntoResponse::into_response)
}



pub async fn digiflazz_settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let row = match sqlx::query("SELECT id::text AS id, config, status FROM vendors WHERE lower(name) LIKE $1 ORDER BY id LIMIT 1")
        .bind("%digiflazz%").fetch_optional(&state.pg_pool).await {
        Ok(row) => row, Err(_) => return internal_error(),
    };
    let vendor = row.map(|row| (row.try_get::<String, _>("id"), row.try_get::<Value, _>("config"), row.try_get::<bool, _>("status")));
    let (id, config, status) = match vendor { Some((Ok(id), Ok(config), Ok(status))) => (Some(id), config, status), Some(_) => return internal_error(), None => (None, Value::Null, true) };
    let username = normalized_config_string(&config, "username").unwrap_or_default();
    let api_key = normalized_config_string(&config, "apiKey").unwrap_or_default();
    Json(DigiflazzSettingsResponse { configured: !username.is_empty() && !api_key.is_empty(), vendor_id: id, username, api_key: mask_secret(&api_key), status }).into_response()
}

pub async fn save_digiflazz_settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<DigiflazzSettingsPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    if let Err(response) = require_credentials_step_up(&headers, &state).await { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool, "digiflazz").await;
    let current = digiflazz_credentials(vendor.as_ref());
    let username = normalize_payload_string(payload.username).unwrap_or(current.username);
    let api_key = normalize_payload_string(payload.api_key).unwrap_or(current.secret);
    if username.is_empty() || api_key.is_empty() { return status_message(axum::http::StatusCode::BAD_REQUEST, "Username dan API Key wajib tersedia. Lengkapi field yang masih kosong."); }
    let credentials = VendorCredentials { username: username.clone(), secret: api_key.clone() };
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1")).unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let balance = match fetch_digiflazz_balance_with_base_url(&credentials, &base_url).await { Ok(balance) => balance, Err(_) => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") };
    let vendor_id = if let Some(vendor) = vendor {
        let Some(id) = vendor.get("id").and_then(Value::as_str).and_then(|id| uuid::Uuid::parse_str(id).ok()) else { return internal_error(); };
        match sqlx::query("UPDATE vendors SET config=config || $2, status=true, updated_at=now() WHERE id=$1")
            .bind(id).bind(json!({"username":username,"apiKey":api_key})).execute(&state.pg_pool).await { Ok(result) if result.rows_affected()==1 => id.to_string(), _ => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") }
    } else {
        match sqlx::query_scalar::<_, String>("INSERT INTO vendors(name,slug,api_base_url,config,status) VALUES ('Digiflazz','digiflazz','https://api.digiflazz.com/v1',$1,true) RETURNING id::text")
            .bind(json!({"username":username,"apiKey":api_key})).fetch_one(&state.pg_pool).await { Ok(id) => id, Err(_) => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") }
    };
    Json(json!({"success":true,"message":"Settings saved successfully","balance":balance,"vendorId":vendor_id})).into_response()
}

pub async fn tokovoucher_settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool, "tokovoucher").await;
    let config = vendor.as_ref().and_then(|value| value.get("config"));
    let member_code = config.and_then(|value| normalized_config_string(value, "memberCode")).or_else(|| config.and_then(|value| normalized_config_string(value, "apiKey"))).unwrap_or_default();
    let secret = config.and_then(|value| normalized_config_string(value, "secret")).unwrap_or_default();
    Json(TokovoucherSettingsResponse {
        configured: !member_code.is_empty() && !secret.is_empty(),
        vendor_id: vendor.as_ref().and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned)),
        member_code, secret: mask_secret(&secret),
        status: vendor.as_ref().and_then(|value| value.get("status").and_then(Value::as_bool)).unwrap_or(true),
    }).into_response()
}

pub async fn save_tokovoucher_settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<TokovoucherSettingsPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    if let Err(response) = require_credentials_step_up(&headers, &state).await { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool, "tokovoucher").await;
    let current = tokovoucher_credentials(vendor.as_ref());
    let member_code = normalize_payload_string(payload.member_code).unwrap_or(current.username);
    let secret = normalize_payload_string(payload.secret).unwrap_or(current.secret);
    if member_code.is_empty() || secret.is_empty() { return status_message(axum::http::StatusCode::BAD_REQUEST, "Member Code dan Secret wajib tersedia. Lengkapi field yang masih kosong."); }
    let credentials = VendorCredentials { username: member_code.clone(), secret: secret.clone() };
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor, "https://api.tokovoucher.net")).unwrap_or_else(|| "https://api.tokovoucher.net".to_string());
    let balance = match fetch_tokovoucher_balance_with_base_url(&credentials, &base_url).await { Ok(balance) => balance, Err(_) => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") };
    let vendor_id = if let Some(vendor) = vendor {
        let Some(id) = vendor.get("id").and_then(Value::as_str).and_then(|id| uuid::Uuid::parse_str(id).ok()) else { return internal_error(); };
        match sqlx::query("UPDATE vendors SET config=config || $2, status=true, updated_at=now() WHERE id=$1")
            .bind(id).bind(json!({"memberCode":member_code,"secret":secret})).execute(&state.pg_pool).await { Ok(result) if result.rows_affected()==1 => id.to_string(), _ => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") }
    } else {
        match sqlx::query_scalar::<_, String>("INSERT INTO vendors(name,slug,api_base_url,config,status) VALUES ('Tokovoucher','tokovoucher','https://api.tokovoucher.id',$1,true) RETURNING id::text")
            .bind(json!({"memberCode":member_code,"secret":secret})).fetch_one(&state.pg_pool).await { Ok(id) => id, Err(_) => return status_message(axum::http::StatusCode::BAD_REQUEST, "Failed to save settings. Check your credentials.") }
    };
    Json(json!({"success":true,"message":"Settings saved successfully","balance":balance,"vendorId":vendor_id})).into_response()
}
