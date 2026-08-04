use mongodb::bson::{Bson, Document};
use serde_json::{json, Value};

use super::defaults::default_text;

pub fn json_to_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(*value),
        Value::Number(value) => {
            if let Some(number) = value.as_i64() {
                Bson::Int64(number)
            } else if let Some(number) = value.as_f64() {
                Bson::Double(number)
            } else {
                Bson::Null
            }
        }
        Value::String(value) => Bson::String(value.clone()),
        Value::Array(values) => Bson::Array(values.iter().map(json_to_bson).collect()),
        Value::Object(values) => {
            let mut document = Document::new();
            for (key, value) in values {
                document.insert(key, json_to_bson(value));
            }
            Bson::Document(document)
        }
    }
}

pub fn normalize_setting_value(key: &str, value: &Bson) -> Value {
    match key {
        "maintenanceMode"
        | "registrationEnabled"
        | "guestCheckoutEnabled"
        | "popupBannerEnabled" => Value::Bool(matches!(value, Bson::Boolean(true))),
        "minDeposit" | "maxDeposit" | "depositFee" => json!(clamp_i64(value, 0, 100_000_000)),
        "refIdSequenceDigits" => json!(clamp_i64(value, 1, 10)),
        "invoiceRandomLength" => json!(clamp_i64(value, 1, 12)),
        "depositFeeType" => enum_string(value, &["fixed", "percent"], "fixed"),
        "refIdDateFormat" | "invoiceDateFormat" => enum_string(
            value,
            &[
                "DDMMYYYY", "YYYYMMDD", "MMDDYYYY", "DDMMYY", "YYMMDD", "NONE",
            ],
            default_text(key),
        ),
        "refIdSeparator" | "invoiceSeparator" => enum_string(value, &["", "-", "_"], ""),
        "invoiceRandomType" => enum_string(value, &["alphanumeric", "numeric"], "alphanumeric"),
        "favicon" | "logo" | "popupBannerImage" | "termsUrl" | "privacyUrl" | "popupBannerLink" => {
            Value::String(normalize_url_or_path(value, default_text(key)))
        }
        _ => Value::String(text_value(value, default_text(key)).trim().to_string()),
    }
}

pub fn normalize_cross_field_settings(settings: &mut serde_json::Map<String, Value>) {
    let min_deposit = settings
        .get("minDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let max_deposit = settings
        .get("maxDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if max_deposit < min_deposit {
        settings.insert("maxDeposit".to_string(), json!(min_deposit));
    }
    if settings.get("depositFeeType").and_then(Value::as_str) == Some("percent") {
        let deposit_fee = settings
            .get("depositFee")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        settings.insert(
            "depositFee".to_string(),
            json!(std::cmp::min(deposit_fee, 100)),
        );
    }
}

fn enum_string(value: &Bson, allowed: &[&str], fallback: &str) -> Value {
    let text = text_value(value, fallback).trim().to_string();
    if allowed.contains(&text.as_str()) {
        Value::String(text)
    } else {
        Value::String(fallback.to_string())
    }
}

fn clamp_i64(value: &Bson, min: i64, max: i64) -> i64 {
    let number = match value {
        Bson::Int32(value) => i64::from(*value),
        Bson::Int64(value) => *value,
        Bson::Double(value) => value.floor() as i64,
        _ => min,
    };
    std::cmp::min(max, std::cmp::max(min, number))
}

fn normalize_url_or_path(value: &Bson, fallback: &str) -> String {
    let text = text_value(value, fallback).trim().to_string();
    if text.is_empty() {
        return fallback.to_string();
    }
    if text.starts_with('/') {
        return if text.starts_with("//") {
            fallback.to_string()
        } else {
            text
        };
    }
    if text.starts_with("https://") {
        return text;
    }
    fallback.to_string()
}

fn text_value<'a>(value: &'a Bson, fallback: &'a str) -> &'a str {
    match value {
        Bson::String(value) => value.as_str(),
        _ => fallback,
    }
}
