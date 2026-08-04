use mongodb::bson::{Bson, DateTime, Document};

use crate::utils::bson::read_i64;

pub(super) fn normalize_payload_text(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

pub(super) fn normalize_phone(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

pub(super) fn optional_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_str(key)
        .ok()
        .map(ToString::to_string)
        .filter(|value| !value.is_empty())
}

pub(super) fn read_string_default(document: &Document, key: &str, fallback: &str) -> String {
    optional_string(document, key).unwrap_or_else(|| fallback.to_string())
}

pub(super) fn read_i64_default(document: &Document, key: &str, fallback: i64) -> i64 {
    match document.get(key) {
        Some(_) => read_i64(document, key),
        None => fallback,
    }
}

pub(super) fn read_f64(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        Some(Bson::String(value)) => value.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub(super) fn bson_to_bool(value: &Bson) -> bool {
    match value {
        Bson::Boolean(value) => *value,
        Bson::String(value) => value == "true" || value == "1",
        Bson::Int32(value) => *value != 0,
        Bson::Int64(value) => *value != 0,
        Bson::Double(value) => *value != 0.0,
        _ => false,
    }
}

pub(super) fn bson_number_to_i64(value: &Bson) -> i64 {
    match value {
        Bson::Int32(value) => i64::from(*value),
        Bson::Int64(value) => *value,
        Bson::Double(value) => *value as i64,
        Bson::String(value) => value.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

pub(super) fn format_date_part(format: &str, day: u32, month: u32, year: i32) -> String {
    let yy = year.rem_euclid(100).to_string();
    match format {
        "DDMMYYYY" => format!("{day:02}{month:02}{year:04}"),
        "MMDDYYYY" => format!("{month:02}{day:02}{year:04}"),
        "DDMMYY" => format!("{day:02}{month:02}{yy:0>2}"),
        "YYMMDD" => format!("{yy:0>2}{month:02}{day:02}"),
        "NONE" => String::new(),
        _ => format!("{year:04}{month:02}{day:02}"),
    }
}

pub(super) fn format_rupiah(value: i64) -> String {
    value.to_string()
}

pub(super) fn date_time_string(value: &DateTime) -> String {
    value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string())
}

pub(super) fn date_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_datetime(key)
        .map(|value| date_time_string(value))
        .ok()
}

pub(super) fn object_id_string(document: &Document, key: &str) -> Option<String> {
    document.get_object_id(key).map(|id| id.to_hex()).ok()
}
