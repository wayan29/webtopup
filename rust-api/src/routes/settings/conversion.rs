use serde_json::{json, Value};

use super::defaults::default_text;

pub fn normalize_setting_value(key: &str, value: &Value) -> Value {
    match key {
        "maintenanceMode" | "registrationEnabled" | "guestCheckoutEnabled" | "botProtectionEnabled" | "popupBannerEnabled" => Value::Bool(value.as_bool().unwrap_or(false)),
        "minDeposit" | "maxDeposit" | "depositFee" => json!(clamp_i64(value, 0, 100_000_000)),
        "refIdSequenceDigits" => json!(clamp_i64(value, 1, 10)),
        "invoiceRandomLength" => json!(crate::services::identifier_integrity::safe_invoice_length("alphanumeric", clamp_i64(value, 1, 12)) as i64),
        "depositFeeType" => enum_string(value, &["fixed", "percent"], "fixed"),
        "refIdDateFormat" => {
            let text = text_value(value, default_text(key)).trim().to_string();
            Value::String(crate::services::identifier_integrity::effective_ref_id_date_format(Some(&text)).to_string())
        }
        "invoiceDateFormat" => enum_string(value, crate::services::identifier_integrity::INVOICE_DATE_FORMATS, default_text(key)),
        "refIdSeparator" | "invoiceSeparator" => enum_string(value, &["", "-", "_"], ""),
        "invoiceRandomType" => enum_string(value, &["alphanumeric", "numeric"], "alphanumeric"),
        "favicon" | "logo" | "popupBannerImage" | "termsUrl" | "privacyUrl" | "popupBannerLink" => Value::String(normalize_url_or_path(value, default_text(key))),
        _ => Value::String(text_value(value, default_text(key)).trim().to_string()),
    }
}

pub fn normalize_cross_field_settings(settings: &mut serde_json::Map<String, Value>) {
    let min_deposit = settings.get("minDeposit").and_then(Value::as_i64).unwrap_or(0);
    let max_deposit = settings.get("maxDeposit").and_then(Value::as_i64).unwrap_or(0);
    if max_deposit < min_deposit { settings.insert("maxDeposit".to_string(), json!(min_deposit)); }
    if settings.get("depositFeeType").and_then(Value::as_str) == Some("percent") {
        if let Some(fee) = settings.get("depositFee").and_then(Value::as_i64) { settings.insert("depositFee".to_string(), json!(fee.min(100))); }
    }
    let random_type = settings.get("invoiceRandomType").and_then(Value::as_str).unwrap_or("alphanumeric");
    let raw_length = settings.get("invoiceRandomLength").and_then(Value::as_i64).unwrap_or(8);
    settings.insert("invoiceRandomLength".to_string(), json!(crate::services::identifier_integrity::safe_invoice_length(random_type, raw_length) as i64));
    if let Some(Value::String(raw)) = settings.get("refIdDateFormat").cloned() {
        settings.insert("refIdDateFormat".to_string(), json!(crate::services::identifier_integrity::effective_ref_id_date_format(Some(&raw))));
    }
}

fn enum_string(value: &Value, allowed: &[&str], fallback: &str) -> Value {
    let text = text_value(value, fallback).trim().to_string();
    if allowed.contains(&text.as_str()) { Value::String(text) } else { Value::String(fallback.to_string()) }
}

fn clamp_i64(value: &Value, min: i64, max: i64) -> i64 {
    let number = value.as_i64().or_else(|| value.as_f64().map(|number| number.floor() as i64)).unwrap_or(min);
    std::cmp::min(max, std::cmp::max(min, number))
}

fn normalize_url_or_path(value: &Value, fallback: &str) -> String {
    let text = text_value(value, fallback).trim().to_string();
    if text.is_empty() { return fallback.to_string(); }
    if text.starts_with('/') { return if text.starts_with("//") { fallback.to_string() } else { text }; }
    if text.starts_with("https://") { return text; }
    fallback.to_string()
}

fn text_value<'a>(value: &'a Value, fallback: &'a str) -> &'a str {
    value.as_str().unwrap_or(fallback)
}

