use axum::http::HeaderMap;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::sql_auth::SqlAuthenticatedUser;

pub(super) const RESOURCE_TYPE: &str = "validation_product";
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
        match self { Self::Create => "create", Self::Update => "update", Self::StatusChange => "status_change", Self::Archive => "archive" }
    }
    fn action(self) -> &'static str {
        match self { Self::Create => "create", Self::Update | Self::StatusChange => "update", Self::Archive => "delete" }
    }
    fn method(self) -> &'static str {
        match self { Self::Create => "POST", Self::Update | Self::StatusChange => "PUT", Self::Archive => "DELETE" }
    }
    fn summary(self, sku: &str) -> String {
        match self { Self::Create => format!("Membuat produk validasi {sku}"), Self::Update => format!("Memperbarui produk validasi {sku}"), Self::StatusChange => format!("Mengubah status produk validasi {sku}"), Self::Archive => format!("Mengarsipkan produk validasi {sku}") }
    }
}

pub(super) fn build_validation_product_audit_payload(
    actor: &SqlAuthenticatedUser,
    operation: ValidationProductAuditOperation,
    id: Uuid,
    sku: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    headers: &HeaderMap,
) -> Value {
    let span_trace = crate::services::correlation::current_span_correlation_trace_id();
    let gateway_trace = headers.get(crate::services::correlation::GATEWAY_CORRELATION_HEADER).and_then(|value| value.to_str().ok()).filter(|value| crate::services::correlation::validate_trace_id(value));
    let correlation = if let Some(trace_id) = gateway_trace {
        crate::services::correlation::CorrelationResolution { trace_id: Some(trace_id.to_ascii_lowercase()), source: crate::services::correlation::CorrelationSource::GatewayHeader }
    } else if let Some(trace_id) = span_trace {
        crate::services::correlation::CorrelationResolution { trace_id: Some(trace_id), source: crate::services::correlation::CorrelationSource::OtelSpan }
    } else {
        crate::services::correlation::CorrelationResolution { trace_id: None, source: crate::services::correlation::CorrelationSource::Absent }
    };
    let mut payload = json!({
        "resource": RESOURCE_TYPE,
        "resourceId": id,
        "operation": operation.as_str(),
        "sku": sku,
        "method": operation.method(),
        "path": if operation == ValidationProductAuditOperation::Create { "/v2/validation-products".to_string() } else { format!("/v2/validation-products/{id}") },
        "statusCode": 200,
        "summary": operation.summary(sku),
        "actorId": actor.id,
        "actorName": actor.email,
        "actorEmail": actor.email,
        "actorRole": actor.role,
        "auditSource": "rust_domain",
        "correlationSource": correlation.source.as_str(),
    });
    if let Some(trace_id) = correlation.trace_id { payload["traceId"] = json!(trace_id); }
    if let Some(before) = before { payload["before"] = sanitize_snapshot(before); }
    if let Some(after) = after { payload["after"] = sanitize_snapshot(after); }
    payload
}

pub(super) async fn persist_validation_product_audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: Uuid,
    operation: ValidationProductAuditOperation,
    payload: Value,
) -> Result<(), sqlx::Error> {
    let trace_id = payload.get("traceId").and_then(Value::as_str).unwrap_or("").to_owned();
    sqlx::query("INSERT INTO audit_events(actor, action, outcome, correlation, payload) VALUES($1,$2,'success',$3,$4)")
        .bind(actor.to_string())
        .bind(operation.action())
        .bind(trace_id)
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) fn resolve_audit_operation(archive: bool, status_only: bool) -> ValidationProductAuditOperation {
    if archive { ValidationProductAuditOperation::Archive } else if status_only { ValidationProductAuditOperation::StatusChange } else { ValidationProductAuditOperation::Update }
}

fn sanitize_snapshot(value: &Value) -> Value {
    let validation = &value["validation"];
    let mut snapshot = json!({
        "_id": value["_id"],
        "code": clipped(value["code"].as_str(), 80),
        "name": clipped(value["name"].as_str(), 120),
        "status": value["status"],
        "version": value["version"],
        "validation": {
            "enabled": validation["enabled"],
            "archived": validation["archived"],
            "type": clipped(validation["type"].as_str(),20),
            "game": clipped(validation["game"].as_str(),30),
            "targetLabel": clipped(validation["targetLabel"].as_str(),60),
            "secondaryTargetLabel": clipped(validation["secondaryTargetLabel"].as_str(),60),
            "resultLabel": clipped(validation["resultLabel"].as_str(),60),
        },
        "price": {
            "basic": bounded_money(value["price"]["basic"].as_i64()),
            "gold": bounded_money(value["price"]["gold"].as_i64()),
            "platinum": bounded_money(value["price"]["platinum"].as_i64()),
        }
    });
    if serde_json::to_vec(&snapshot).map_or(false, |bytes| bytes.len() > SNAPSHOT_MAX_SERIALIZED_BYTES) {
        for field in ["name", "code"] {
            if let Some(text) = snapshot[field].as_str() { snapshot[field] = json!(text.chars().take(text.chars().count()/2).collect::<String>()); }
        }
    }
    snapshot
}
fn clipped(value: Option<&str>, max: usize) -> Value { value.map(|v| json!(v.chars().take(max).collect::<String>())).unwrap_or(Value::Null) }
fn bounded_money(value: Option<i64>) -> Value { value.filter(|v| (0..=100_000_000).contains(v)).map(Value::from).unwrap_or(Value::Null) }
