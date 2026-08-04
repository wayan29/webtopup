use mongodb::bson::{Bson, Document};

use crate::utils::bson::read_string;

use super::{
    types::{CreatedByItem, LoginLogItem, TeamAuditLogItem, TeamMemberItem},
    TEAM_PERMISSIONS,
};

pub(super) fn team_member_from_doc(document: Document) -> TeamMemberItem {
    TeamMemberItem {
        id: object_id_string(&document, "_id"),
        name: read_string(&document, "name"),
        email: read_string(&document, "email"),
        role: read_string(&document, "role"),
        active: document.get_bool("active").unwrap_or(true),
        two_factor_enabled: document.get_bool("twoFactorEnabled").unwrap_or(false),
        permissions: permissions_json(document.get_document("permissions").ok()),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        created_by: document
            .get_document("createdByData")
            .ok()
            .and_then(created_by_from_doc),
    }
}

fn created_by_from_doc(document: &Document) -> Option<CreatedByItem> {
    Some(CreatedByItem {
        id: object_id_string(document, "_id"),
        name: read_string(document, "name"),
        email: read_string(document, "email"),
        role: read_string(document, "role"),
    })
}

pub(super) fn team_audit_log_from_doc(document: Document) -> TeamAuditLogItem {
    TeamAuditLogItem {
        id: object_id_string(&document, "_id"),
        actor: optional_object_id_string(&document, "actor"),
        actor_name: read_string(&document, "actorName"),
        actor_email: read_string(&document, "actorEmail"),
        target_user: optional_object_id_string(&document, "targetUser"),
        target_name: read_string(&document, "targetName"),
        target_email: read_string(&document, "targetEmail"),
        target_role: read_string(&document, "targetRole"),
        action: read_string(&document, "action"),
        summary: read_string(&document, "summary"),
        metadata: document.get("metadata").map(bson_to_json),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn login_log_from_doc(document: Document) -> LoginLogItem {
    LoginLogItem {
        id: object_id_string(&document, "_id"),
        user: optional_object_id_string(&document, "user"),
        email: read_string(&document, "email"),
        role: read_string(&document, "role"),
        ip: read_string(&document, "ip"),
        user_agent: read_string(&document, "userAgent"),
        status: read_string(&document, "status"),
        fail_reason: optional_string(&document, "failReason"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn permissions_json(permissions: Option<&Document>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for key in TEAM_PERMISSIONS {
        map.insert(
            key.to_string(),
            serde_json::Value::Bool(
                permissions
                    .and_then(|document| document.get_bool(key).ok())
                    .unwrap_or(false),
            ),
        );
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
        Bson::Document(document) => {
            let mut map = serde_json::Map::new();
            for (key, value) in document.iter() {
                map.insert(key.clone(), bson_to_json(value));
            }
            serde_json::Value::Object(map)
        }
        Bson::Array(values) => serde_json::Value::Array(values.iter().map(bson_to_json).collect()),
        Bson::ObjectId(value) => serde_json::Value::String(value.to_hex()),
        Bson::Null => serde_json::Value::Null,
        _ => serde_json::Value::String(value.to_string()),
    }
}

fn object_id_string(document: &Document, key: &str) -> String {
    optional_object_id_string(document, key).unwrap_or_default()
}

fn optional_object_id_string(document: &Document, key: &str) -> Option<String> {
    document.get_object_id(key).ok().map(|id| id.to_hex())
}

fn optional_string(document: &Document, key: &str) -> Option<String> {
    document.get_str(key).ok().map(ToString::to_string)
}

fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}
