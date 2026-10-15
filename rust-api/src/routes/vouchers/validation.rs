use axum::response::Response;
use serde_json::Value;

use super::status_message;

pub(super) fn normalize_amount(value: Option<Value>) -> Result<i64, Response> {
    let amount = value.and_then(number_value).unwrap_or_default();
    if amount <= 0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nominal voucher harus lebih besar dari 0",
        ));
    }
    if amount > 100_000_000 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nominal voucher terlalu besar",
        ));
    }
    Ok(amount)
}

pub(super) fn normalize_quantity(value: Option<Value>) -> i64 {
    value.and_then(number_value).unwrap_or(1).clamp(1, 200)
}

pub(super) fn normalize_voucher_code(value: Option<Value>) -> Result<String, Response> {
    let code = text_value(value).unwrap_or_default().trim().to_uppercase();
    if code.is_empty() {
        return Ok(String::new());
    }
    let valid_len = (4..=32).contains(&code.len());
    let mut chars = code.chars();
    let valid_first = chars
        .next()
        .is_some_and(|value| value.is_ascii_alphanumeric());
    let valid_chars = code
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-');
    if !valid_len || !valid_first || !valid_chars {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode voucher hanya boleh berisi huruf besar, angka, garis bawah, atau strip, minimal 4 karakter",
        ));
    }
    Ok(code)
}

pub(super) fn normalize_archive_reason(value: Option<Value>) -> Result<String, Response> {
    let reason = text_value(value).unwrap_or_default().trim().to_string();
    if reason.len() > 500 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan arsip voucher maksimal 500 karakter",
        ));
    }
    Ok(reason)
}

pub(super) fn normalize_voucher_prefix(value: Option<Value>) -> Result<String, Response> {
    let prefix = text_value(value).unwrap_or_default().trim().to_uppercase();
    if prefix.is_empty() {
        return Ok(String::new());
    }
    // Leave room for a 10-char random suffix so total stays within code max (32).
    if prefix.len() > 20 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Prefix voucher maksimal 20 karakter",
        ));
    }
    let valid_chars = prefix
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-');
    if !valid_chars {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Prefix voucher hanya boleh huruf, angka, garis bawah, atau strip",
        ));
    }
    Ok(prefix)
}

fn number_value(value: Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.round() as i64)
        }),
        Value::String(value) => value
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| value.round() as i64),
        _ => None,
    }
}

fn text_value(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) | None => None,
    }
}
