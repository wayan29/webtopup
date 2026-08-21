use mongodb::bson::{Bson, DateTime, Document};
use serde_json::Value;

use crate::utils::bson::read_string;

const DEFAULT_ALLOWED_IP: &str = "52.74.250.133";

pub(super) fn allowed_ips(value: Option<&Bson>) -> Vec<String> {
    let items = match value {
        Some(Bson::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::trim).map(ToString::to_string))
            .collect::<Vec<_>>(),
        Some(Bson::String(value)) => value
            .split([',', ';', '\n'])
            .map(str::trim)
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>();

    if items.is_empty() {
        vec![DEFAULT_ALLOWED_IP.to_string()]
    } else {
        items
    }
}

pub(super) fn text_from_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string().trim().to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

pub(super) fn non_negative_i64(value: Option<&Value>, fallback: i64) -> i64 {
    value
        .and_then(number_from_value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as i64)
        .unwrap_or(fallback)
}

pub(super) fn bool_from_value(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub(super) fn validate_http_url(
    value: &str,
    error_code: &'static str,
) -> Result<String, &'static str> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return Err(error_code);
    };
    if !matches!(scheme, "http" | "https") || rest.trim().is_empty() {
        return Err(error_code);
    }
    Ok(value.trim_end_matches('/').to_string())
}

pub(super) fn validate_allowed_ips(value: &Value) -> Result<Vec<String>, &'static str> {
    let items = match value {
        Value::Array(values) => values.iter().map(text_from_value).collect::<Vec<_>>(),
        Value::String(value) => value
            .split([',', ';', '\n'])
            .map(str::trim)
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        Value::Null => Vec::new(),
        _ => Vec::new(),
    };
    let ips = items
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if ips.iter().any(|ip| !is_valid_ip_or_cidr(ip)) {
        return Err("DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID");
    }
    Ok(ips)
}

fn is_valid_ip_or_cidr(value: &str) -> bool {
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let Some((ip, prefix)) = value.split_once('/') else {
        return false;
    };
    ip.parse::<std::net::Ipv4Addr>().is_ok()
        && prefix.parse::<u8>().is_ok_and(|prefix| prefix <= 32)
}

pub(super) fn ip_matches_rule(client_ip: &str, rule: &str) -> bool {
    if client_ip == rule {
        return true;
    }
    let Some((range_ip, prefix)) = rule.split_once('/') else {
        return false;
    };
    let Ok(client) = client_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(range) = range_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    if prefix > 32 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(client) & mask) == (u32::from(range) & mask)
}

pub(super) fn is_valid_pulsa_code(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

pub(super) fn insert_optional_i64(document: &mut Document, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        document.insert(key, value);
    } else {
        document.insert(key, Bson::Null);
    }
}

pub(super) fn join_url(base_url: &str, path: &str) -> String {
    if base_url.is_empty() {
        return String::new();
    }
    format!(
        "{}{}{}",
        base_url,
        if path.starts_with('/') { "" } else { "/" },
        path
    )
}

pub(super) fn normalize_url(value: String) -> String {
    value.trim_end_matches('/').to_string()
}

pub(super) fn document_id(document: &Document) -> String {
    document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default()
}

pub(super) fn document_string(document: &Document, key: &str) -> String {
    read_string(document, key).trim().to_string()
}

pub(super) fn optional_bool(document: &Document, key: &str) -> Option<bool> {
    document.get_bool(key).ok()
}

pub(super) fn optional_i64(document: &Document, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) => Some(*value as i64),
        _ => None,
    }
}

pub(super) fn optional_date_or_string(document: &Document, key: &str) -> Option<String> {
    match document.get(key) {
        Some(Bson::DateTime(value)) => Some(date_to_string(value)),
        Some(Bson::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    optional_date_string(document, key).unwrap_or_default()
}

pub(super) fn optional_date_string(document: &Document, key: &str) -> Option<String> {
    document.get_datetime(key).ok().map(date_to_string)
}

pub(super) fn date_to_string(value: &DateTime) -> String {
    value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string())
}

pub(super) fn date_key(date: DateTime) -> String {
    date.try_to_rfc3339_string()
        .ok()
        .and_then(|value| value.get(0..10).map(ToString::to_string))
        .unwrap_or_else(|| "unknown-date".to_string())
}

pub(super) trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}
