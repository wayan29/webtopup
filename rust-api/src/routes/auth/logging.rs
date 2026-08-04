use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use super::security_audit::{
    bounded_device_context, write_security_audit, SecurityAuditEvent, EVENT_LOGIN_FAILURE,
    EVENT_LOGIN_SUCCESS,
};
use crate::services::correlation;

pub(super) async fn write_login_log(
    db: &mongodb::Database,
    user_id: Option<&str>,
    email: &str,
    role: Option<&str>,
    ip: &str,
    user_agent: &str,
    status: &str,
    fail_reason: Option<&str>,
) {
    let mut document = doc! {
        "email": email,
        "ip": ip,
        "userAgent": user_agent,
        "status": status,
        "createdAt": DateTime::now(),
        "updatedAt": DateTime::now(),
        "__v": 0_i64,
    };
    match user_id.and_then(|id| ObjectId::parse_str(id).ok()) {
        Some(id) => document.insert("user", id),
        None => document.insert("user", Bson::Null),
    };
    match role {
        Some(role) if !role.is_empty() => document.insert("role", role),
        _ => document.insert("role", Bson::Null),
    };
    if let Some(reason) = fail_reason {
        document.insert("failReason", reason);
    }
    let _ = db
        .collection::<Document>("loginlogs")
        .insert_one(document)
        .await;

    // Bounded security audit companion (never stores password/OTP/token/body).
    let parsed_user = user_id.and_then(|id| ObjectId::parse_str(id).ok());
    let span_trace = correlation::current_span_correlation_trace_id();
    let correlation = correlation::resolve_correlation_untrusted(
        &axum::http::HeaderMap::new(),
        span_trace.as_deref(),
    );
    let (event, outcome) = if status == "success" {
        (EVENT_LOGIN_SUCCESS, "success")
    } else {
        (EVENT_LOGIN_FAILURE, "failure")
    };
    write_security_audit(
        db,
        SecurityAuditEvent {
            event,
            outcome,
            user_id: parsed_user,
            session_id: None,
            trace_id: correlation.trace_id,
            correlation_source: correlation.source.as_str(),
            action_group: None,
            reason: fail_reason.and_then(bounded_login_reason),
            device: Some(bounded_device_context("", ip, user_agent)),
        },
    )
    .await;
}

fn bounded_login_reason(reason: &str) -> Option<&'static str> {
    match reason {
        "invalid_credentials" | "invalid_password" => Some("invalid_credentials"),
        "account_disabled" | "inactive" => Some("account_disabled"),
        "maintenance" => Some("maintenance"),
        "two_factor_required" => Some("two_factor_required"),
        "two_factor_invalid" => Some("two_factor_invalid"),
        _ => Some("other"),
    }
}

pub(super) fn client_info(headers: &axum::http::HeaderMap) -> (String, String) {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    (ip, user_agent)
}
