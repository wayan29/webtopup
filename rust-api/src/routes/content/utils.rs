use mongodb::bson::{oid::ObjectId, Bson, DateTime, Document};
use serde_json::{Map, Value};

pub(super) fn json_to_bson(value: Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(value),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Bson::Int64(value)
            } else if let Some(value) = value.as_f64() {
                Bson::Double(value)
            } else {
                Bson::Null
            }
        }
        Value::String(value) => Bson::String(value),
        Value::Array(values) => Bson::Array(values.into_iter().map(json_to_bson).collect()),
        Value::Object(values) => Bson::Document(
            values
                .into_iter()
                .map(|(key, value)| (key, json_to_bson(value)))
                .collect(),
        ),
    }
}

pub(super) fn object_id_from_bson(value: Option<&Bson>) -> Option<ObjectId> {
    match value {
        Some(Bson::ObjectId(id)) => Some(*id),
        Some(Bson::String(id)) => ObjectId::parse_str(id).ok(),
        _ => None,
    }
}

pub(super) fn number_from_bson(value: Option<&Bson>) -> Option<i64> {
    match value {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) => Some(*value as i64),
        _ => None,
    }
}

pub(super) fn date_value(document: &Document, key: &str) -> DateTime {
    document
        .get_datetime(key)
        .copied()
        .unwrap_or_else(|_| DateTime::from_millis(0))
}

pub(super) fn date_to_string(value: &DateTime) -> String {
    date_time_to_mongoose_string(*value)
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| date_time_to_mongoose_string(*value))
        .unwrap_or_default()
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

pub(super) fn document_to_json(document: Document) -> Value {
    let mut map = Map::new();
    for (key, value) in document {
        map.insert(key, bson_to_json(value));
    }
    Value::Object(map)
}

fn bson_to_json(value: Bson) -> Value {
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
