use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::Value;

pub(in crate::routes) fn id_from_document(document: &Document) -> String {
    id_from_bson(document.get("_id"))
}

pub(super) fn id_from_bson(value: Option<&Bson>) -> String {
    match value {
        Some(Bson::ObjectId(id)) => id.to_hex(),
        Some(Bson::String(id)) => id.to_string(),
        Some(other) => other.to_string(),
        _ => String::new(),
    }
}

pub(super) fn get_non_empty(value: &str) -> Option<&str> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(super) fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(super) fn object_id(value: Option<&str>) -> Option<ObjectId> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| ObjectId::parse_str(value).ok())
}

pub(in crate::routes) fn lookup_stage(from: &str, local_field: &str, as_field: &str) -> Document {
    doc! { "$lookup": { "from": from, "localField": local_field, "foreignField": "_id", "as": as_field } }
}

pub(in crate::routes) fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}

pub(in crate::routes) fn optional_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_str(key)
        .ok()
        .map(ToString::to_string)
        .filter(|value| !value.is_empty())
}

pub(in crate::routes) fn document_to_json(document: Document) -> Value {
    let mut map = serde_json::Map::new();
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

pub(in crate::routes) fn date_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .ok()
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
