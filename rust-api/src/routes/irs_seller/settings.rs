use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, response::IntoResponse, response::Response, Json};
use serde_json::{json, Value};

use crate::{security::require_proxy_context, state::AppState};

use super::{internal_error, status_message, DEFAULT_ENDPOINT, DEFAULT_PREPAID_PATH};
use super::types::{validated_irs_formatter, IrsFormatterMarkers, IrsFormatterSnMarkers, IrsMappingSummary, IrsSettingsResponse, SaveIrsSettingsPayload};

fn read_config(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned() }
fn read_config_i64(value: &Value, key: &str) -> i64 { value.get(key).and_then(Value::as_i64).unwrap_or_default() }
fn config_string_array(value: &Value, key: &str) -> Vec<String> { value.get(key).and_then(Value::as_array).map(|items|items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default() }

pub async fn settings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = crate::security::require_sql_permission(&headers, &state, "manageSettings").await { return response; }
    let config = match crate::services::seller_sql::stored_settings(&state.pg_pool, "irs").await { Ok(config)=>config,Err(_)=>return internal_error() };
    let active_mappings = match sqlx::query_scalar::<_,i64>("SELECT count(*)::bigint FROM seller_mappings WHERE channel='irs' AND enabled=true").fetch_one(&state.pg_pool).await { Ok(count)=>count,Err(_)=>return internal_error() };
    Json(irs_settings_response(&config, active_mappings)).into_response()
}

pub(super) fn irs_settings_response(config: &Value, active_mappings: i64) -> IrsSettingsResponse {
    let merchant_configured = config.get("merchantId").and_then(Value::as_str).is_some_and(|value| crate::services::seller_secrets::is_valid("irs", "merchantId", value));
    let merchant_id = String::new();
    let password_configured = config.get("password").and_then(Value::as_str).is_some_and(|value| crate::services::seller_secrets::is_valid("irs", "password", value));
    let pin_configured = config.get("pin").and_then(Value::as_str).is_some_and(|value| crate::services::seller_secrets::is_valid("irs", "pin", value));
    let secret_configured = config.get("secret").and_then(Value::as_str).is_some_and(|value| crate::services::seller_secrets::is_valid("irs", "secret", value));
    let configured = merchant_configured && password_configured && pin_configured && secret_configured;
    let response = IrsSettingsResponse { configured, ready:configured&&active_mappings>0, enabled:config.get("enabled").and_then(Value::as_bool).unwrap_or(false),merchant_id,password_configured,pin_configured,secret_configured,endpoint_url:if read_config(config,"endpointUrl").is_empty(){DEFAULT_ENDPOINT.to_owned()}else{read_config(config,"endpointUrl")},allowed_ips:config_string_array(config,"allowedIps"),seller_margin_flat:read_config_i64(config,"sellerMarginFlat"),callback_enabled:config.get("callbackEnabled").and_then(Value::as_bool).unwrap_or(false),callback_url:read_config(config,"callbackUrl"),prepaid_endpoint_path:DEFAULT_PREPAID_PATH.to_owned(),mapping_summary:IrsMappingSummary{active:active_mappings},formatter:IrsFormatterMarkers{sn:IrsFormatterSnMarkers{start:config.pointer("/formatter/sn/start").and_then(Value::as_str).unwrap_or_default().to_owned(),end:config.pointer("/formatter/sn/end").and_then(Value::as_str).unwrap_or_default().to_owned()}} };
    response
}


pub async fn save_settings(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<Value>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let user = match crate::security::require_sql_user(&headers, &state).await { Ok(user)=>user,Err(response)=>return response };
    if let Err(auth) = crate::sql_auth::verify_step_up(&headers, &state, &user, "integrations.credentials", chrono::Utc::now()) { return (axum::http::StatusCode::FORBIDDEN, Json(json!({"message":auth.message}))).into_response(); }
    let current = match crate::services::seller_sql::stored_settings(&state.pg_pool, "irs").await { Ok(value) => value, Err(_) => return internal_error() };
    let mut next = current.clone();
    for (aliases, field) in [(&["merchantId", "merchant_id"][..], "merchantId"), (&["password", "pass"][..], "password"), (&["pin"][..], "pin"), (&["secret", "id"][..], "secret")] {
        let stored = current.get(field).and_then(Value::as_str).unwrap_or_default();
        let submitted = crate::routes::irs_seller::types::text_value(&payload, aliases);
        let sealed = match submitted {
            Some(mut value) => {
                let sealed = match crate::services::seller_secrets::seal("irs", field, &value) { Ok(value) => value, Err(_) => { use zeroize::Zeroize; value.zeroize(); return internal_error(); } };
                use zeroize::Zeroize;
                value.zeroize();
                sealed
            },
            None if crate::services::seller_secrets::is_envelope(stored) && crate::services::seller_secrets::open("irs", field, stored).is_ok() => stored.to_owned(),
            None => return status_message(axum::http::StatusCode::BAD_REQUEST, "IRS seller credentials required"),
        };
        next[field] = json!(sealed);
    }
    if let Some(value) = payload.get("enabled").and_then(Value::as_bool) { next["enabled"] = json!(value); }
    if let Some(value) = crate::routes::irs_seller::types::text_value(&payload, &["endpointUrl", "endpoint_url"]) { next["endpointUrl"] = json!(value); }
    if let Some(value) = payload.get("allowedIps").or_else(|| payload.get("allowed_ips")) { next["allowedIps"] = value.clone(); }
    if let Some(value) = payload.get("sellerMarginFlat").or_else(|| payload.get("seller_margin_flat")) { next["sellerMarginFlat"] = value.clone(); }
    if let Some(value) = payload.get("callbackEnabled").or_else(|| payload.get("callback_enabled")) { next["callbackEnabled"] = value.clone(); }
    if let Some(value) = crate::routes::irs_seller::types::text_value(&payload, &["callbackUrl", "callback_url"]) { next["callbackUrl"] = json!(value); }
    if let Some(value) = payload.get("formatter") { next["formatter"] = value.clone(); }
    if crate::services::seller_sql::save_settings(&state.pg_pool, "irs", &next).await.is_err() { return internal_error(); }
    Json(irs_settings_response(&next, 0)).into_response()
}
