use serde_json::Value;
use sqlx::PgPool;

use sqlx::Row;
use super::types::VendorCredentials;
use super::IfEmpty;

pub(super) async fn find_vendor_by_name(pool: &PgPool, name: &str) -> Option<Value> {
    let row = sqlx::query("SELECT id::text AS id, name, api_base_url, config, low_balance_threshold, status FROM vendors WHERE lower(name) LIKE $1 ORDER BY id LIMIT 1")
        .bind(format!("%{}%", name.to_lowercase()))
        .fetch_optional(pool).await.ok().flatten()?;
    Some(serde_json::json!({
        "id": row.try_get::<String, _>("id").ok()?,
        "name": row.try_get::<String, _>("name").ok()?,
        "apiBaseUrl": row.try_get::<String, _>("api_base_url").ok()?,
        "config": row.try_get::<Value, _>("config").ok()?,
        "lowBalanceThreshold": row.try_get::<i64, _>("low_balance_threshold").ok()?,
        "status": row.try_get::<bool, _>("status").ok()?,
    }))
}

pub(super) fn digiflazz_credentials(vendor: Option<&Value>) -> VendorCredentials {
    let config = vendor.and_then(|value| value.get("config"));
    VendorCredentials {
        username: config.and_then(|value| normalized_config_string(value, "username"))
            .or_else(|| env_string("DIGIFLAZZ_USERNAME")).unwrap_or_default(),
        secret: config.and_then(|value| normalized_config_string(value, "apiKey"))
            .or_else(|| env_string("DIGIFLAZZ_API_KEY")).unwrap_or_default(),
    }
}

pub(super) fn tokovoucher_credentials(vendor: Option<&Value>) -> VendorCredentials {
    let config = vendor.and_then(|value| value.get("config"));
    VendorCredentials {
        username: config.and_then(|value| normalized_config_string(value, "memberCode")
            .or_else(|| normalized_config_string(value, "apiKey")))
            .or_else(|| env_string("TOKOVOUCHER_MEMBER_CODE"))
            .or_else(|| env_string("TOKOVOUCHER_API_KEY")).unwrap_or_default(),
        secret: config.and_then(|value| normalized_config_string(value, "secret"))
            .or_else(|| env_string("TOKOVOUCHER_SECRET")).unwrap_or_default(),
    }
}

pub(super) fn env_string(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

pub(super) fn vendor_base_url(vendor: &Value, fallback: &str) -> String {
    vendor.get("apiBaseUrl").and_then(Value::as_str).unwrap_or("").trim().to_string().if_empty(fallback)
}

pub(super) fn short_mask(value: &str) -> String {
    format!("{}***", value.chars().take(4).collect::<String>())
}

pub(super) fn normalized_config_string(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string)
}

pub(super) fn normalize_payload_string(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

pub(super) fn mask_secret(value: &str) -> String {
    if value.is_empty() { String::new() } else {
        format!("***{}", value.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>())
    }
}

pub(super) fn has_any_non_empty_value(config: &Value) -> bool {
    config.as_object().map(|config| config.values().any(|value| match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Null => false,
        _ => true,
    })).unwrap_or(false)
}
