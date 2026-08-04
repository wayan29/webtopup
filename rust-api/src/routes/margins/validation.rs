use axum::response::Response;
use serde_json::Value;

use super::{
    responses::{status_message, string_message},
    types::MAX_MARGIN_PERCENT,
};

pub fn normalize_margin_input(value: Value, label: &'static str) -> Result<f64, Response> {
    let Some(normalized) = number_value(value) else {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{} harus berupa angka yang valid", label),
        ));
    };
    if normalized < 0.0 {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{} tidak boleh negatif", label),
        ));
    }
    if normalized > MAX_MARGIN_PERCENT {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "{} tidak boleh lebih dari {}%",
                label, MAX_MARGIN_PERCENT as i64
            ),
        ));
    }
    Ok(normalized)
}

pub fn normalize_note(value: Value) -> Result<String, Response> {
    let note = text_value(value).unwrap_or_default().trim().to_string();
    if note.chars().count() > 500 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan tidak boleh lebih dari 500 karakter",
        ));
    }
    Ok(note)
}

fn number_value(value: Value) -> Option<f64> {
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

fn text_value(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}
