use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    routes::auth::require_trusted_step_up_group, security::require_proxy_context, state::AppState,
};

use super::{
    bool_from_value, internal_error, join_url, non_negative_i64, normalize_url,
    save_settings_error, text_from_value, validate_allowed_ips, validate_http_url,
    MappingSummary, OrderSummary, RetryQueueHealth, SaveSettingsPayload,
    SaveSettingsResponse, SellerConfig, SellerSettingsResponse,
};

const CONFIG_KEY: &str = "digiflazz";
const RETRY_HEALTH_KEY: &str = "digiflazz_retry_health";
const DEFAULT_CALLBACK_URL: &str = "https://api.digiflazz.com/v1/seller/callback";
const DEFAULT_ALLOWED_IP: &str = "52.74.250.133";
const PREPAID_PATH: &str = "/api/v2/digiflazz-seller/prepaid";
const HIGH_CALLBACK_ATTEMPT_THRESHOLD: i64 = 5;

pub async fn settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let value = match crate::services::seller_sql::stored_settings(&state.pg_pool, CONFIG_KEY).await { Ok(value) => value, Err(_) => return internal_error() };
    let stored_key = value_string(&value, "apiKey");
    let configured_key = crate::services::seller_secrets::is_valid("digiflazz", "apiKey", &stored_key);
    let mut public_value = value;
    public_value["apiKey"] = json!(if configured_key { "configured" } else { "" });
    let config = seller_config_from_value(public_value);
    let row = match sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE enabled)::bigint AS active FROM seller_mappings WHERE channel='digiflazz'").fetch_one(&state.pg_pool).await { Ok(row) => row, Err(_) => return internal_error() };
    let total = row.get::<i64,_>("total"); let active = row.get::<i64,_>("active");
    let row = match sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE o.status='pending')::bigint AS pending,count(*) FILTER(WHERE c.delivered_at IS NULL AND c.ref_id IS NOT NULL)::bigint AS callback_pending,count(*) FILTER(WHERE c.delivered_at IS NULL AND c.ref_id IS NOT NULL AND (c.next_retry_at IS NULL OR c.next_retry_at<=now()))::bigint AS callback_due_retry,count(*) FILTER(WHERE c.attempt_count >= $1 AND c.ref_id IS NOT NULL)::bigint AS callback_high_attempt FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz'").bind(HIGH_CALLBACK_ATTEMPT_THRESHOLD).fetch_one(&state.pg_pool).await { Ok(row) => row, Err(_) => return internal_error() };
    let order_summary = OrderSummary { total: row.get("total"), pending: row.get("pending"), callback_pending: row.get("callback_pending"), callback_due_retry: row.get("callback_due_retry"), callback_high_attempt: row.get("callback_high_attempt") };
    let health = match crate::services::seller_sql::stored_settings(&state.pg_pool, RETRY_HEALTH_KEY).await { Ok(value) => value, Err(_) => return internal_error() };
    let configured = !config.username.is_empty() && configured_key;
    Json(SellerSettingsResponse { configured, ready: configured && !config.public_base_url.is_empty() && active > 0, username: config.username.clone(), api_key_configured: configured_key, public_base_url: config.public_base_url.clone(), digiflazz_callback_url: config.digiflazz_callback_url.clone(), server_ip: config.server_ip.clone(), reported_balance: config.reported_balance, seller_margin_flat: config.seller_margin_flat, allowed_ips: config.allowed_ips.clone(), callback_enabled: config.callback_enabled, prepaid_endpoint_path: config.prepaid_endpoint_path.clone(), prepaid_endpoint_url: config.prepaid_endpoint_url.clone(), mapping_summary: MappingSummary { total, active }, order_summary, retry_queue_health: retry_health_from_value(&health) }).into_response()
}

pub async fn save_settings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<SaveSettingsPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") { return response; }
    let current = match crate::services::seller_sql::stored_settings(&state.pg_pool, CONFIG_KEY).await { Ok(value) => value, Err(_) => return internal_error() };
    let stored_api_key = value_string(&current,"apiKey");
    let public_base_url = match validate_http_url(&normalize_url(payload.public_base_url.as_ref().map(text_from_value).unwrap_or_else(||value_string(&current,"publicBaseUrl"))),"DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID") { Ok(v)=>v,Err(e)=>return save_settings_error(e) };
    let callback_input = normalize_url(payload.digiflazz_callback_url.as_ref().map(text_from_value).unwrap_or_else(||value_string(&current,"digiflazzCallbackUrl")));
    let callback_url = match validate_http_url(&callback_input,"DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID") { Ok(v)=>v.if_empty(DEFAULT_CALLBACK_URL),Err(e)=>return save_settings_error(e) };
    let allowed_value = payload.allowed_ips.clone().unwrap_or_else(||current.get("allowedIps").cloned().unwrap_or(Value::Null));
    let allowed_ips = match validate_allowed_ips(&allowed_value) { Ok(v) if v.is_empty()=>vec![DEFAULT_ALLOWED_IP.to_string()],Ok(v)=>v,Err(e)=>return save_settings_error(e) };
    let username = payload.username.as_ref().map(text_from_value).filter(|v| !v.is_empty()).unwrap_or_else(|| value_string(&current,"username"));
    let submitted_key = payload.api_key.as_ref().map(text_from_value).filter(|value|!value.is_empty());
    let encrypted_api_key = match submitted_key {
        Some(mut value) => { let sealed = match crate::services::seller_secrets::seal("digiflazz","apiKey",&value) { Ok(value)=>value,Err(_)=>{ use zeroize::Zeroize; value.zeroize(); return internal_error(); } }; use zeroize::Zeroize; value.zeroize(); sealed },
        None if crate::services::seller_secrets::is_valid("digiflazz", "apiKey", &stored_api_key) => stored_api_key.clone(),
        None => return save_settings_error("DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED"),
    };
    if username.is_empty() { return save_settings_error("DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED"); }
    let next = json!({"username":username,"apiKey":encrypted_api_key,"publicBaseUrl":public_base_url,"digiflazzCallbackUrl":callback_url,"serverIp":payload.server_ip.as_ref().map(text_from_value).unwrap_or_else(||value_string(&current,"serverIp")),"reportedBalance":non_negative_i64(payload.reported_balance.as_ref(),value_i64(&current,"reportedBalance")),"sellerMarginFlat":non_negative_i64(payload.seller_margin_flat.as_ref(),value_i64(&current,"sellerMarginFlat")),"allowedIps":allowed_ips,"callbackEnabled":bool_from_value(payload.callback_enabled.as_ref()).unwrap_or_else(||optional_bool(&current,"callbackEnabled").unwrap_or(true))});
    if crate::services::seller_sql::save_settings(&state.pg_pool,CONFIG_KEY,&next).await.is_err() { return internal_error(); }
    let mut response_config=next.clone();
    response_config["apiKey"]=json!("********");
    let saved = seller_config_from_value(response_config);
    Json(SaveSettingsResponse { success:true,message:"Konfigurasi Digiflazz Seller berhasil disimpan",configured:true,username:saved.username,api_key_configured:true,public_base_url:saved.public_base_url,digiflazz_callback_url:saved.digiflazz_callback_url,server_ip:saved.server_ip,reported_balance:saved.reported_balance,seller_margin_flat:saved.seller_margin_flat,allowed_ips:saved.allowed_ips,callback_enabled:saved.callback_enabled,prepaid_endpoint_url:saved.prepaid_endpoint_url }).into_response()
}

pub(super) async fn seller_config(pool: &sqlx::PgPool) -> SellerConfig {
    let mut value=crate::services::seller_sql::stored_settings(pool,CONFIG_KEY).await.unwrap_or_else(|_|json!({}));
    let stored=value_string(&value,"apiKey");
    let api_key=if crate::services::seller_secrets::is_envelope(&stored){crate::services::seller_secrets::open("digiflazz","apiKey",&stored).unwrap_or_default()}else{String::new()};
    value["apiKey"]=json!(api_key);
    seller_config_from_value(value)
}
fn seller_config_from_value(value: Value) -> SellerConfig {
    let public_base_url=normalize_url(value_string(&value,"publicBaseUrl")); let prepaid_endpoint_path=PREPAID_PATH.to_string(); let prepaid_endpoint_url=join_url(&public_base_url,&prepaid_endpoint_path);
    let allowed_ips=value.get("allowedIps").and_then(Value::as_array).map(|items|items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_else(||vec![DEFAULT_ALLOWED_IP.to_string()]);
    SellerConfig { username:value_string(&value,"username"),api_key:value_string(&value,"apiKey"),public_base_url,digiflazz_callback_url:normalize_url(value_string(&value,"digiflazzCallbackUrl")).if_empty(DEFAULT_CALLBACK_URL),server_ip:value_string(&value,"serverIp"),reported_balance:value_i64(&value,"reportedBalance"),seller_margin_flat:value_i64(&value,"sellerMarginFlat"),allowed_ips,callback_enabled:optional_bool(&value,"callbackEnabled").unwrap_or(true),prepaid_endpoint_path,prepaid_endpoint_url }
}
fn retry_health_from_value(value:&Value)->RetryQueueHealth { RetryQueueHealth { status:value_string(value,"status").if_empty("never"),source:value_string(value,"source").if_empty("unknown"),last_run_at:optional_date_or_string(value,"lastRunAt"),processed:value_i64(value,"processed"),success_count:value_i64(value,"successCount"),failed_count:value_i64(value,"failedCount"),remaining_due:value_i64(value,"remainingDue"),last_error:value_string(value,"lastError") } }
fn value_string(value:&Value,key:&str)->String { value.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string() }
fn value_i64(value:&Value,key:&str)->i64 { value.get(key).and_then(Value::as_i64).unwrap_or_default() }
fn optional_bool(value:&Value,key:&str)->Option<bool> { value.get(key).and_then(Value::as_bool) }
fn optional_date_or_string(value:&Value,key:&str)->Option<String> { let v=value.get(key)?; v.as_str().filter(|s|!s.is_empty()).map(str::to_string).or_else(||v.as_i64().and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis).map(|d|d.to_rfc3339())) }

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() { fallback.to_owned() } else { self }
    }
}
