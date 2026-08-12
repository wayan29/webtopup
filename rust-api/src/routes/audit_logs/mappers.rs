use mongodb::bson::Document;

use crate::utils::bson::{optional_i64, optional_string, read_string};

use super::sanitize::sanitize_audit_document;
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
        metadata: document
            .get_document("metadata")
            .ok()
            .map(sanitize_audit_document),
        created_at,
        updated_at,
    }
}

#[cfg(test)]
mod tests {
    use mongodb::bson::doc;

    use super::audit_log_item_from_doc;
    use crate::routes::audit_logs::sanitize::AUDIT_REDACTION;

    #[test]
    fn mapper_redacts_historical_metadata_pin() {
        let item = audit_log_item_from_doc(doc! {
            "_id": mongodb::bson::oid::ObjectId::new(),
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
            "createdAt": mongodb::bson::DateTime::now(),
        });
        let metadata = item.metadata.expect("metadata");
        assert_eq!(metadata.get_str("pin").unwrap(), AUDIT_REDACTION);
        assert_eq!(metadata.get_str("shipping").unwrap(), "visible");
    }
}
