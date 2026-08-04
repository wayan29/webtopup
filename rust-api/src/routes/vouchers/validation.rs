use axum::response::Response;
use mongodb::bson::{doc, DateTime, Document};
use rand::{rngs::OsRng, RngCore};
use serde_json::Value;

use super::status_message;

pub(super) fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, &'static str> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let suffix = if end_of_day {
        "T23:59:59.999Z"
    } else {
        "T00:00:00.000Z"
    };
    DateTime::parse_rfc3339_str(format!("{}{}", value, suffix))
        .map(Some)
        .map_err(|_| "Format tanggal voucher tidak valid")
}

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

pub(super) async fn generate_voucher_codes(
    vouchers: &mongodb::Collection<Document>,
    quantity: i64,
) -> Result<Vec<String>, Response> {
    let mut codes = Vec::new();
    let mut attempts = 0;
    while codes.len() < quantity as usize {
        let code = random_voucher_code();
        attempts += 1;
        if attempts > quantity * 25 {
            return Err(status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Gagal membuat kode voucher unik",
            ));
        }
        if codes.contains(&code) {
            continue;
        }
        let exists = vouchers
            .find_one(doc! { "code": &code })
            .await
            .ok()
            .flatten()
            .is_some();
        if !exists {
            codes.push(code);
        }
    }
    Ok(codes)
}

fn random_voucher_code() -> String {
    let mut bytes = [0u8; 5];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
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
