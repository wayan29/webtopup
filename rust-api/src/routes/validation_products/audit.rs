use axum::http::HeaderMap;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::routes::audit_logs::mappers::audit_log_item_from_doc;
use crate::security::AuthenticatedProxyUser;

pub(super) const RESOURCE_TYPE: &str = "validation_product";
const AUDIT_SOURCE: &str = "rust_domain";
const SNAPSHOT_CODE_MAX_LEN: usize = 80;
const SNAPSHOT_NAME_MAX_LEN: usize = 120;
const SNAPSHOT_VALIDATION_TYPE_MAX_LEN: usize = 20;
const SNAPSHOT_VALIDATION_GAME_MAX_LEN: usize = 30;
const SNAPSHOT_VALIDATION_LABEL_MAX_LEN: usize = 60;
const SNAPSHOT_PRICE_MAX: i64 = 100_000_000;
const SNAPSHOT_MAX_SERIALIZED_BYTES: usize = 16_384;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ValidationProductAuditOperation {
    Create,
    Update,
    StatusChange,
    Archive,
}

impl ValidationProductAuditOperation {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::StatusChange => "status_change",
            Self::Archive => "archive",
        }
    }

    fn audit_action(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update | Self::StatusChange => "update",
            Self::Archive => "delete",
        }
    }

    fn http_method(self) -> &'static str {
        match self {
            Self::Create => "POST",
            Self::Update | Self::StatusChange => "PUT",
            Self::Archive => "DELETE",
        }
    }

    fn http_path(self, resource_id: &ObjectId) -> String {
        let id = resource_id.to_hex();
        match self {
            Self::Create => "/v2/validation-products".to_string(),
            Self::Update | Self::StatusChange | Self::Archive => {
                format!("/v2/validation-products/{id}")
            }
        }
    }

    fn summary(self, sku: &str) -> String {
        match self {
            Self::Create => format!("Membuat produk validasi {sku}"),
            Self::Update => format!("Memperbarui produk validasi {sku}"),
            Self::StatusChange => format!("Mengubah status produk validasi {sku}"),
            Self::Archive => format!("Mengarsipkan produk validasi {sku}"),
        }
    }
}

pub(super) fn build_validation_product_audit_document(
    actor: &AuthenticatedProxyUser,
    operation: ValidationProductAuditOperation,
    resource_id: ObjectId,
    sku: &str,
    before: Option<&Document>,
    after: Option<&Document>,
    headers: &HeaderMap,
    timestamp: DateTime,
) -> Document {
    let mut metadata = Document::new();
    metadata.insert("operation", operation.as_str());
    metadata.insert("resourceId", resource_id);
    metadata.insert("sku", sku);
    if let Some(before) = before {
        metadata.insert("before", snapshot_to_bson(before));
    }
    if let Some(after) = after {
        metadata.insert("after", snapshot_to_bson(after));
    }
    let correlation = actor.resolve_correlation(headers);
    metadata.insert("correlationSource", correlation.source.as_str());
    metadata.insert("auditSource", AUDIT_SOURCE);
    if let Some(trace_id) = correlation.trace_id {
        metadata.insert("traceId", trace_id);
    }

    doc! {
        "actorId": actor.id,
        "actorName": &actor.email,
        "actorEmail": &actor.email,
        "actorRole": &actor.role,
        "action": operation.audit_action(),
        "resource": RESOURCE_TYPE,
        "method": operation.http_method(),
        "path": operation.http_path(&resource_id),
        "statusCode": 200_i32,
        "summary": operation.summary(sku),
        "metadata": metadata,
        "timestamp": timestamp,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "__v": 0_i64,
    }
}

pub(super) async fn persist_validation_product_audit(
    db: &mongodb::Database,
    document: Document,
    resource_id: ObjectId,
    operation: ValidationProductAuditOperation,
) {
    if let Err(error) = db
        .collection::<Document>("adminauditlogs")
        .insert_one(document)
        .await
    {
        tracing::error!(
            %error,
            resource_id = %resource_id.to_hex(),
            operation = operation.as_str(),
            "Failed to write validation product audit log"
        );
    }
}

pub(super) fn log_validation_product_audit_state_failure(
    resource_id: ObjectId,
    operation: ValidationProductAuditOperation,
    reason: &'static str,
) {
    tracing::error!(
        resource_id = %resource_id.to_hex(),
        operation = operation.as_str(),
        reason,
        "Failed to capture validation product audit state after mutation"
    );
}

fn truncate_snapshot_str(value: &str, max_len: usize) -> String {
    value.chars().take(max_len).collect()
}

fn snapshot_money_field(document: &Document, field: &str) -> Option<i64> {
    let value = if let Ok(value) = document.get_i64(field) {
        value
    } else if let Ok(value) = document.get_i32(field) {
        i64::from(value)
    } else {
        return None;
    };
    if (0..=SNAPSHOT_PRICE_MAX).contains(&value) {
        Some(value)
    } else {
        None
    }
}

fn snapshot_validation_subdocument(document: &Document) -> Document {
    let mut snapshot = Document::new();
    if let Ok(enabled) = document.get_bool("enabled") {
        snapshot.insert("enabled", enabled);
    }
    if let Ok(archived) = document.get_bool("archived") {
        snapshot.insert("archived", archived);
    }
    if let Ok(value) = document.get_str("type") {
        snapshot.insert(
            "type",
            truncate_snapshot_str(value, SNAPSHOT_VALIDATION_TYPE_MAX_LEN),
        );
    }
    if let Ok(value) = document.get_str("game") {
        snapshot.insert(
            "game",
            truncate_snapshot_str(value, SNAPSHOT_VALIDATION_GAME_MAX_LEN),
        );
    }
    if let Ok(value) = document.get_str("targetLabel") {
        snapshot.insert(
            "targetLabel",
            truncate_snapshot_str(value, SNAPSHOT_VALIDATION_LABEL_MAX_LEN),
        );
    }
    if let Ok(value) = document.get_str("secondaryTargetLabel") {
        snapshot.insert(
            "secondaryTargetLabel",
            truncate_snapshot_str(value, SNAPSHOT_VALIDATION_LABEL_MAX_LEN),
        );
    }
    if let Ok(value) = document.get_str("resultLabel") {
        snapshot.insert(
            "resultLabel",
            truncate_snapshot_str(value, SNAPSHOT_VALIDATION_LABEL_MAX_LEN),
        );
    }
    snapshot
}

fn snapshot_price_subdocument(document: &Document) -> Document {
    let mut snapshot = Document::new();
    if let Some(value) = snapshot_money_field(document, "basic") {
        snapshot.insert("basic", value);
    }
    if let Some(value) = snapshot_money_field(document, "gold") {
        snapshot.insert("gold", value);
    }
    if let Some(value) = snapshot_money_field(document, "platinum") {
        snapshot.insert("platinum", value);
    }
    snapshot
}

fn serialized_snapshot_len(snapshot: &Document) -> usize {
    mongodb::bson::to_vec(snapshot)
        .map(|value| value.len())
        .unwrap_or(0)
}

fn enforce_snapshot_size_ceiling(mut snapshot: Document) -> Document {
    if serialized_snapshot_len(&snapshot) <= SNAPSHOT_MAX_SERIALIZED_BYTES {
        return snapshot;
    }
    for key in ["name", "code"] {
        if let Ok(value) = snapshot.get_str(key) {
            let truncated = truncate_snapshot_str(value, value.len() / 2);
            snapshot.insert(key, truncated);
            if serialized_snapshot_len(&snapshot) <= SNAPSHOT_MAX_SERIALIZED_BYTES {
                return snapshot;
            }
        }
    }
    if let Ok(validation) = snapshot.get_document("validation").cloned() {
        let mut trimmed = validation;
        for key in [
            "targetLabel",
            "secondaryTargetLabel",
            "resultLabel",
            "game",
            "type",
        ] {
            if let Ok(value) = trimmed.get_str(key) {
                trimmed.insert(key, truncate_snapshot_str(value, 16));
            }
        }
        snapshot.insert("validation", trimmed);
    }
    snapshot
}

fn snapshot_to_bson(document: &Document) -> Bson {
    Bson::Document(sanitize_snapshot(document))
}

fn sanitize_snapshot(document: &Document) -> Document {
    let mut snapshot = Document::new();
    if let Ok(id) = document.get_object_id("_id") {
        snapshot.insert("_id", id);
    }
    if let Ok(code) = document.get_str("code") {
        snapshot.insert("code", truncate_snapshot_str(code, SNAPSHOT_CODE_MAX_LEN));
    }
    if let Ok(name) = document.get_str("name") {
        snapshot.insert("name", truncate_snapshot_str(name, SNAPSHOT_NAME_MAX_LEN));
    }
    if let Ok(status) = document.get_bool("status") {
        snapshot.insert("status", status);
    }
    if let Ok(validation) = document.get_document("validation") {
        snapshot.insert("validation", snapshot_validation_subdocument(validation));
    }
    if let Ok(price) = document.get_document("price") {
        snapshot.insert("price", snapshot_price_subdocument(price));
    }
    if let Some(version) = super::concurrency::validation_product_version_for_response(document) {
        snapshot.insert("version", version);
    }
    enforce_snapshot_size_ceiling(snapshot)
}

pub(super) fn resolve_audit_operation(
    archive: bool,
    status_only: bool,
) -> ValidationProductAuditOperation {
    if archive {
        ValidationProductAuditOperation::Archive
    } else if status_only {
        ValidationProductAuditOperation::StatusChange
    } else {
        ValidationProductAuditOperation::Update
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::test_authenticated_proxy_user;
    use crate::services::correlation::GATEWAY_CORRELATION_HEADER;
    use mongodb::bson::oid::ObjectId;

    fn trusted_actor(actor_id: ObjectId) -> AuthenticatedProxyUser {
        test_authenticated_proxy_user(
            actor_id,
            "admin",
            "admin@example.com",
            vec!["manageSettings".to_string()],
        )
    }

    #[test]
    fn audit_document_uses_trusted_actor_and_admin_schema_fields() {
        let actor_id = ObjectId::new();
        let resource_id = ObjectId::new();
        let actor = trusted_actor(actor_id);
        let before = doc! { "_id": resource_id, "code": "SKU-1", "status": true, "__v": 2_i64 };
        let mut headers = HeaderMap::new();
        headers.insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .expect("traceparent"),
        );
        let document = build_validation_product_audit_document(
            &actor,
            ValidationProductAuditOperation::StatusChange,
            resource_id,
            "SKU-1",
            Some(&before),
            None,
            &headers,
            DateTime::now(),
        );
        assert_eq!(document.get_object_id("actorId").ok(), Some(actor_id));
        assert_eq!(document.get_str("action").ok(), Some("update"));
        assert_eq!(document.get_str("resource").ok(), Some(RESOURCE_TYPE));
        assert_eq!(document.get_str("method").ok(), Some("PUT"));
        let expected_path = format!("/v2/validation-products/{}", resource_id.to_hex());
        assert_eq!(document.get_str("path").ok(), Some(expected_path.as_str()));
        assert!(document
            .get_str("summary")
            .ok()
            .unwrap_or("")
            .contains("SKU-1"));
        let metadata = document.get_document("metadata").expect("metadata");
        assert_eq!(metadata.get_str("operation").ok(), Some("status_change"));
        assert_eq!(metadata.get_object_id("resourceId").ok(), Some(resource_id));
        assert_eq!(metadata.get_str("sku").ok(), Some("SKU-1"));
        assert_eq!(metadata.get_str("auditSource").ok(), Some("rust_domain"));
        assert_eq!(metadata.get_str("correlationSource").ok(), Some("absent"));
        assert!(metadata.get_str("traceId").ok().is_none());
        assert!(metadata.get("before").is_some());
        assert!(!document.contains_key("operation"));
        assert!(!document.contains_key("resourceType"));
    }

    #[test]
    fn validation_product_audit_ignores_raw_traceparent_without_gateway_header() {
        let actor_id = ObjectId::new();
        let resource_id = ObjectId::new();
        let actor = trusted_actor(actor_id);
        let before = doc! { "_id": resource_id, "code": "SKU-1", "status": true, "__v": 2_i64 };
        let mut headers = HeaderMap::new();
        headers.insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .expect("traceparent"),
        );
        let document = build_validation_product_audit_document(
            &actor,
            ValidationProductAuditOperation::StatusChange,
            resource_id,
            "SKU-1",
            Some(&before),
            None,
            &headers,
            DateTime::now(),
        );
        assert_eq!(document.get_object_id("actorId").ok(), Some(actor_id));
        assert_eq!(document.get_str("resource").ok(), Some(RESOURCE_TYPE));
        let metadata = document.get_document("metadata").expect("metadata");
        assert_eq!(metadata.get_str("auditSource").ok(), Some("rust_domain"));
        assert_eq!(metadata.get_str("correlationSource").ok(), Some("absent"));
        assert!(metadata.get_str("traceId").ok().is_none());
        assert!(metadata.get("before").is_some());
    }

    #[test]
    fn validation_product_audit_uses_trusted_gateway_correlation_header() {
        let actor_id = ObjectId::new();
        let resource_id = ObjectId::new();
        let actor = trusted_actor(actor_id);
        let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::HeaderName::from_static(GATEWAY_CORRELATION_HEADER),
            trace_id.parse().expect("value"),
        );
        let document = build_validation_product_audit_document(
            &actor,
            ValidationProductAuditOperation::Create,
            resource_id,
            "SKU-9",
            None,
            None,
            &headers,
            DateTime::now(),
        );
        let metadata = document.get_document("metadata").expect("metadata");
        assert_eq!(metadata.get_str("traceId").ok(), Some(trace_id));
        assert_eq!(
            metadata.get_str("correlationSource").ok(),
            Some("gateway_header")
        );
        assert_eq!(metadata.get_str("auditSource").ok(), Some("rust_domain"));
    }

    #[test]
    fn produced_audit_document_maps_through_admin_audit_mapper() {
        let actor_id = ObjectId::new();
        let resource_id = ObjectId::new();
        let actor = trusted_actor(actor_id);
        let after = doc! {
            "_id": resource_id,
            "code": "SKU-2",
            "status": false,
            "validation": { "archived": true },
            "__v": 3_i64,
        };
        let document = build_validation_product_audit_document(
            &actor,
            ValidationProductAuditOperation::Archive,
            resource_id,
            "SKU-2",
            None,
            Some(&after),
            &HeaderMap::new(),
            DateTime::now(),
        );
        let item = audit_log_item_from_doc(document);
        assert_eq!(item.action, "delete");
        assert_eq!(item.resource, RESOURCE_TYPE);
        assert_eq!(item.method, "DELETE");
        assert!(item.summary.contains("SKU-2"));
        let metadata = item.metadata.expect("metadata");
        assert_eq!(metadata.get_str("operation").ok(), Some("archive"));
        assert!(metadata.get("after").is_some());
    }

    #[test]
    fn sanitize_snapshot_omits_unknown_nested_fields_and_truncates_labels() {
        let resource_id = ObjectId::new();
        let oversized_label = "l".repeat(120);
        let document = doc! {
            "_id": resource_id,
            "code": "SKU-1",
            "name": "Produk",
            "status": true,
            "validation": {
                "enabled": true,
                "archived": false,
                "type": "operator",
                "game": "",
                "targetLabel": oversized_label.as_str(),
                "secondaryTargetLabel": "secondary",
                "resultLabel": "hasil",
                "unexpected": "omit-me",
                "nested": { "deep": true },
            },
            "price": {
                "basic": 1_500_i64,
                "gold": 0_i64,
                "platinum": 0_i64,
                "unexpectedTier": 99_i64,
                "overflow": SNAPSHOT_PRICE_MAX + 1,
            },
            "__v": 2_i64,
        };
        let snapshot = sanitize_snapshot(&document);
        let validation = snapshot
            .get_document("validation")
            .expect("validation snapshot");
        assert!(!validation.contains_key("unexpected"));
        assert!(!validation.contains_key("nested"));
        assert_eq!(
            validation.get_str("targetLabel").ok().map(str::len),
            Some(60)
        );
        let price = snapshot.get_document("price").expect("price snapshot");
        assert!(!price.contains_key("unexpectedTier"));
        assert!(!price.contains_key("overflow"));
        assert_eq!(price.get_i64("basic").ok(), Some(1_500));
        assert_eq!(snapshot.get_i64("version").ok(), Some(2));
    }

    #[test]
    fn resolve_audit_operation_distinguishes_status_change_and_archive() {
        assert_eq!(
            resolve_audit_operation(false, true),
            ValidationProductAuditOperation::StatusChange
        );
        assert_eq!(
            resolve_audit_operation(true, false),
            ValidationProductAuditOperation::Archive
        );
        assert_eq!(
            resolve_audit_operation(false, false),
            ValidationProductAuditOperation::Update
        );
    }
}
