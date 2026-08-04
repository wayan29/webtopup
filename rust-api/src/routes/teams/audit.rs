use mongodb::bson::{doc, Bson, DateTime, Document};
use serde_json::Value;

use crate::utils::bson::read_string;

use super::types::ActorScope;

pub(super) async fn write_team_audit_log(
    db: &mongodb::Database,
    actor: &ActorScope,
    target: &Document,
    action: &str,
    summary: String,
    metadata: Option<Value>,
) {
    let now = DateTime::now();
    let mut document = doc! {
        "actor": actor.id,
        "actorName": &actor.name,
        "actorEmail": &actor.email,
        "targetUser": target.get_object_id("_id").ok(),
        "targetName": read_string(target, "name"),
        "targetEmail": read_string(target, "email"),
        "targetRole": read_string(target, "role"),
        "action": action,
        "summary": summary,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if let Some(metadata) = metadata {
        document.insert("metadata", json_to_bson(metadata));
    }
    let _ = db
        .collection::<Document>("teamauditlogs")
        .insert_one(document)
        .await;
}

fn json_to_bson(value: Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(value),
        Value::Number(value) => value
            .as_i64()
            .map(Bson::Int64)
            .or_else(|| value.as_f64().map(Bson::Double))
            .unwrap_or(Bson::Null),
        Value::String(value) => Bson::String(value),
        Value::Array(values) => Bson::Array(values.into_iter().map(json_to_bson).collect()),
        Value::Object(map) => Bson::Document(
            map.into_iter()
                .map(|(key, value)| (key, json_to_bson(value)))
                .collect(),
        ),
    }
}
