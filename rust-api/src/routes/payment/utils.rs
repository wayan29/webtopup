use std::time::{SystemTime, UNIX_EPOCH};

use mongodb::bson::{Bson, Document};
use serde_json::Value;

use crate::utils::bson::read_string;

use super::types::PaymentCategoryBrief;

pub(super) fn is_valid_time_string(value: &str) -> bool {
    let Some((hours, minutes)) = value.split_once(':') else {
        return false;
    };
    hours.len() == 2
        && minutes.len() == 2
        && hours.chars().all(|character| character.is_ascii_digit())
        && minutes.chars().all(|character| character.is_ascii_digit())
        && time_to_minutes(value).is_some()
}

pub(super) fn visibility_issues(
    method_status: &str,
    category: Option<&PaymentCategoryBrief>,
    is_operational: bool,
    operational_start: &str,
    operational_end: &str,
) -> Vec<String> {
    let mut issues = Vec::new();
    match category {
        None => issues.push("Kategori metode tidak ditemukan".to_string()),
        Some(category) if category.status != "active" => {
            issues.push("Kategori sedang nonaktif".to_string())
        }
        Some(_) => {}
    }
    if method_status != "active" {
        issues.push("Metode pembayaran sedang nonaktif".to_string());
    }
    if !is_operational {
        issues.push(format!(
            "Di luar jam operasional {operational_start}-{operational_end}"
        ));
    }
    issues
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

pub(super) fn read_f64(document: &Document, key: &str) -> f64 {
    read_f64_default(document, key, 0.0)
}

pub(super) fn read_f64_default(document: &Document, key: &str, default: f64) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        _ => default,
    }
}

pub(super) fn read_string_default(document: &Document, key: &str, default: &str) -> String {
    let value = read_string(document, key);
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| date_time_to_mongoose_string(*value))
        .unwrap_or_default()
}

fn date_time_to_mongoose_string(value: mongodb::bson::DateTime) -> String {
    let millis = value.timestamp_millis();
    let ms = millis.rem_euclid(1000);
    let base = value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string());
    let Some((date_time, _)) = base.split_once('.') else {
        return base.replace('Z', &format!(".{ms:03}Z"));
    };
    format!("{date_time}.{ms:03}Z")
}

pub(super) fn read_i64_optional(document: &Document, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) => Some(*value as i64),
        _ => None,
    }
}

pub(super) fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 {
        Value::Number((value as i64).into())
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

pub(super) fn escape_regex(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(super) fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}
