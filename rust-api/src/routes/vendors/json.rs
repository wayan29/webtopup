use mongodb::bson::{Bson, DateTime, Document};
use serde_json::{Map, Value};

pub(super) fn normalize_non_negative_number(value: Option<&Value>, fallback: i64) -> i64 {
    let Some(value) = value else {
        return fallback;
    };
    let numeric_value = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    };

    numeric_value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or(fallback)
}

pub(super) fn value_to_bson(value: Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(value),
        Value::Number(value) => value
            .as_i64()
            .map(Bson::Int64)
            .or_else(|| value.as_f64().map(Bson::Double))
            .unwrap_or(Bson::Null),
        Value::String(value) => Bson::String(value),
        Value::Array(values) => Bson::Array(values.into_iter().map(value_to_bson).collect()),
        Value::Object(map) => Bson::Document(
            map.into_iter()
                .map(|(key, value)| (key, value_to_bson(value)))
                .collect(),
        ),
    }
}

pub(super) fn document_to_json(document: Document) -> Value {
    Value::Object(document_to_map(document))
}

fn document_to_map(document: Document) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in document {
        map.insert(key, bson_to_json_owned(value));
    }
    map
}

fn bson_to_json_owned(value: Bson) -> Value {
    match value {
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::DateTime(value) => Value::String(date_time_to_mongoose_string(value)),
        Bson::String(value) => Value::String(value),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => serde_json::json!(value),
        Bson::Int64(value) => serde_json::json!(value),
        Bson::Double(value) => serde_json::json!(value),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_to_json_owned).collect()),
        Bson::Document(document) => document_to_json(document),
        Bson::Null => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

pub(super) fn date_time_to_mongoose_string(value: DateTime) -> String {
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

pub(super) fn date_key(value: DateTime) -> String {
    date_time_to_mongoose_string(value)
        .chars()
        .take(10)
        .collect()
}

pub(super) fn config_to_json(config: &Document) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (key, value) in config.iter() {
        map.insert(key.to_string(), bson_to_json(value));
    }
    serde_json::Value::Object(map)
}

fn bson_to_json(value: &Bson) -> serde_json::Value {
    match value {
        Bson::String(value) => serde_json::Value::String(value.clone()),
        Bson::Boolean(value) => serde_json::Value::Bool(*value),
        Bson::Int32(value) => serde_json::json!(*value),
        Bson::Int64(value) => serde_json::json!(*value),
        Bson::Double(value) => serde_json::json!(*value),
        Bson::Document(document) => config_to_json(document),
        Bson::Array(values) => serde_json::Value::Array(values.iter().map(bson_to_json).collect()),
        Bson::Null => serde_json::Value::Null,
        _ => serde_json::Value::String(value.to_string()),
    }
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
