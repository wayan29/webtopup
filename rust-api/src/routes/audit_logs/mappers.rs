use mongodb::bson::Document;

use crate::utils::bson::{optional_i64, optional_string, read_string};

use super::types::AuditLogItem;

pub fn audit_log_item_from_doc(mut document: Document) -> AuditLogItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let created_at = document
        .get_datetime("createdAt")
        .ok()
        .and_then(|value| value.try_to_rfc3339_string().ok())
        .unwrap_or_default();
    let updated_at = document
        .get_datetime("updatedAt")
        .ok()
        .and_then(|value| value.try_to_rfc3339_string().ok());

    AuditLogItem {
        id,
        actor_name: read_string(&document, "actorName"),
        actor_email: read_string(&document, "actorEmail"),
        actor_role: read_string(&document, "actorRole"),
        action: read_string(&document, "action"),
        resource: read_string(&document, "resource"),
        method: read_string(&document, "method"),
        path: read_string(&document, "path"),
        status_code: optional_i64(&document, "statusCode"),
        ip: optional_string(&document, "ip"),
        user_agent: optional_string(&document, "userAgent"),
        summary: read_string(&document, "summary"),
        metadata: document.get_document("metadata").ok().cloned(),
        created_at,
        updated_at,
    }
}
