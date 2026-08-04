use axum::response::Response;
use mongodb::bson::{Bson, Document};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use super::responses::status_message;

pub(super) fn normalize_deposit_amount(value: Option<Value>) -> Result<i64, Response> {
    let amount = match value {
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0),
        Some(Value::String(value)) => value.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    if !amount.is_finite() || amount <= 0.0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nominal deposit tidak valid",
        ));
    }
    Ok(amount as i64)
}

pub(super) fn round_percent(amount: i64, percent: f64) -> i64 {
    ((amount as f64 * percent) / 100.0).round() as i64
}

pub(super) fn read_number_f64(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        _ => 0.0,
    }
}

pub(super) fn generate_unique_code() -> i64 {
    (rand::random::<u32>() % 999 + 1) as i64
}

pub(super) fn is_operational_now(start: &str, end: &str) -> bool {
    let Some(start_minutes) = time_to_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = time_to_minutes(end) else {
        return false;
    };
    if start_minutes == end_minutes {
        return true;
    }
    let current_minutes = current_utc_minutes();
    if start_minutes < end_minutes {
        return current_minutes >= start_minutes && current_minutes <= end_minutes;
    }
    current_minutes >= start_minutes || current_minutes <= end_minutes
}

fn time_to_minutes(value: &str) -> Option<u64> {
    let (hours, minutes) = value.split_once(':')?;
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(hours * 60 + minutes)
}

fn current_utc_minutes() -> u64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    (seconds % 86_400) / 60
}

pub(super) fn format_idr(value: i64) -> String {
    let mut digits = value.abs().to_string();
    let mut parts = Vec::new();
    while digits.len() > 3 {
        let rest = digits.split_off(digits.len() - 3);
        parts.push(rest);
    }
    parts.push(digits);
    parts.reverse();
    let formatted = parts.join(".");
    if value < 0 {
        format!("-{}", formatted)
    } else {
        formatted
    }
}
