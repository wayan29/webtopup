use mongodb::bson::{oid::ObjectId, Bson, Document};
use rand::RngCore;
use serde_json::Value;

pub fn generate_api_key() -> String {
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("tv_{key}")
}

pub fn generate_api_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub fn member_code_from_id(id: &ObjectId) -> String {
    let hex = id.to_hex();
    let suffix = hex
        .get(hex.len().saturating_sub(10)..)
        .unwrap_or(hex.as_str())
        .to_uppercase();
    format!("MBR{suffix}")
}

pub fn add_optional_object_id_filter(filter: &mut Document, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(object_id) = ObjectId::parse_str(value) {
            filter.insert(key, object_id);
        } else {
            filter.insert(key, value);
        }
    }
}

pub fn user_bson(user_id: &str) -> Bson {
    ObjectId::parse_str(user_id)
        .map(Bson::ObjectId)
        .unwrap_or_else(|_| Bson::String(user_id.to_string()))
}

pub fn object_ids_from_docs(documents: &[Document], key: &str) -> Vec<ObjectId> {
    let mut ids = documents
        .iter()
        .filter_map(|doc| object_id_from_bson(doc.get(key)))
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    ids
}

pub fn object_id_from_bson(value: Option<&Bson>) -> Option<ObjectId> {
    match value {
        Some(Bson::ObjectId(id)) => Some(*id),
        Some(Bson::String(id)) => ObjectId::parse_str(id).ok(),
        _ => None,
    }
}

pub fn id_value(doc: &Document) -> Value {
    match doc.get_object_id("_id") {
        Ok(id) => Value::String(id.to_hex()),
        Err(_) => Value::Null,
    }
}

pub fn optional_string(doc: &Document, key: &str) -> Option<String> {
    doc.get_str(key).ok().map(ToString::to_string)
}

pub fn date_string(doc: &Document, key: &str) -> String {
    doc.get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}
