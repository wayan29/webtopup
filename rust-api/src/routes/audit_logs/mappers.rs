use serde_json::Value;
use sqlx::{postgres::PgRow, Row};

use crate::utils::bson::{optional_i64, optional_string, read_string};

use crate::services::audit_sanitize::sanitize_audit_document;
use super::types::AuditLogItem;

/// Mirrors the historical audit document shape built from a SQL row: payload fields win,
/// actor/action defaults fill the gaps, and `correlation` is merged into the metadata object.
pub(super) fn audit_event_value(row: &PgRow) -> Value {
    let id: i64 = row.get("id");
    let actor: String = row.get("actor");
    let action: String = row.get("action");
    let correlation: String = row.get("correlation");
    let payload: Value = row.get("payload");
    let created_at: chrono::DateTime<chrono::Utc> = row.get("created_at");
    let payload_object = payload.as_object().cloned().unwrap_or_default();

    let mut document = serde_json::Map::new();
    document.insert("_id".to_string(), Value::String(id.to_string()));
    document.insert("action".to_string(), Value::String(action));
    document.insert(
        "createdAt".to_string(),
        Value::String(created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    for field in ["actorName", "actorEmail", "actorRole", "resource", "method", "path", "summary", "ip", "userAgent"] {
        if let Some(value) = payload_object.get(field) {
            document.insert(field.to_string(), value.clone());
        }
    }
    let defaults = [
        ("actorName", actor.clone()),
        ("actorEmail", actor),
        ("actorRole", String::new()),
        ("resource", String::new()),
        ("method", String::new()),
        ("path", String::new()),
        ("summary", String::new()),
    ];
    for (field, value) in defaults {
        document.entry(field.to_string()).or_insert(Value::String(value));
    }
    if let Some(code) = payload.get("statusCode").and_then(Value::as_i64) {
        document.insert("statusCode".to_string(), Value::from(code));
    }
    let mut metadata = payload_object
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("correlation".to_string(), Value::String(correlation));
    document.insert("metadata".to_string(), Value::Object(metadata));
    Value::Object(document)
}

pub fn audit_log_item_from_doc(document: &Value) -> AuditLogItem {
    let id = document
        .get("_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let created_at = document
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let updated_at = document
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_owned);

    AuditLogItem {
        id,
        actor_name: read_string(document, "actorName"),
        actor_email: read_string(document, "actorEmail"),
        actor_role: read_string(document, "actorRole"),
        action: read_string(document, "action"),
        resource: read_string(document, "resource"),
        method: read_string(document, "method"),
        path: read_string(document, "path"),
        status_code: optional_i64(document, "statusCode"),
        ip: optional_string(document, "ip"),
        user_agent: optional_string(document, "userAgent"),
        summary: read_string(document, "summary"),
        metadata: document.get("metadata").map(sanitize_audit_document),
        created_at,
        updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::audit_log_item_from_doc;
    use crate::routes::audit_logs::sanitize::AUDIT_REDACTION;
    use serde_json::json;

    #[test]
    fn mapper_redacts_historical_metadata_pin() {
        let item = audit_log_item_from_doc(&json!({
            "_id": "42",
            "actorName": "Audit Fixture",
            "actorEmail": "audit-fixture@task14.invalid",
            "actorRole": "cs",
            "action": "update",
            "resource": "Products",
            "method": "PUT",
            "path": "/api/v2/products/admin/update",
            "summary": "PUT /api/v2/products/admin/update",
            "metadata": {
                "pin": "fixture-value",
                "shipping": "visible",
            },
            "createdAt": "2023-11-14T22:13:20.000Z",
        }));
        let metadata = item.metadata.expect("metadata");
        assert_eq!(metadata["pin"], AUDIT_REDACTION);
        assert_eq!(metadata["shipping"], "visible");
    }
}
