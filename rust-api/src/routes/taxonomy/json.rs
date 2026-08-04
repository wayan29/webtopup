use mongodb::bson::{Bson, Document};
use serde_json::Value;

pub(super) fn object_id_string(document: &Document, key: &str) -> String {
    document
        .get_object_id(key)
        .map(|id| id.to_hex())
        .unwrap_or_default()
}

pub(super) fn optional_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_str(key)
        .ok()
        .map(ToString::to_string)
        .filter(|value| !value.is_empty())
}

pub(super) fn document_to_json(document: Document) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in document {
        map.insert(key, bson_to_json(value));
    }
    Value::Object(map)
}

pub(super) fn bson_to_json(value: Bson) -> Value {
    match value {
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::DateTime(value) => Value::String(date_time_to_mongoose_string(value)),
        Bson::String(value) => Value::String(value),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => serde_json::json!(value),
        Bson::Int64(value) => serde_json::json!(value),
        Bson::Double(value) => serde_json::json!(value),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_to_json).collect()),
        Bson::Document(document) => document_to_json(document),
        Bson::Null => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

pub(super) fn date_time_to_mongoose_string(value: mongodb::bson::DateTime) -> String {
    let millis = value.timestamp_millis();
    let seconds = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let base = value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string());
    let Some((date_time, _)) = base.split_once('.') else {
        return base.replace('Z', &format!(".{ms:03}Z"));
    };
    let _ = seconds;
    format!("{date_time}.{ms:03}Z")
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}

pub(super) fn normalize_non_negative_number(value: f64) -> i64 {
    if !value.is_finite() || value < 0.0 {
        0
    } else {
        value.trunc() as i64
    }
}
