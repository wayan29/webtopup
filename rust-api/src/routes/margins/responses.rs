use axum::{response::IntoResponse, response::Response, Json};
use mongodb::bson::{Bson, DateTime, Document};

use crate::security::ErrorResponse;

use super::types::{MarginAuditUser, MarginData, MarginLimits, MarginResponse, MAX_MARGIN_PERCENT};

pub fn format_margin_response(setting: Option<&Document>) -> MarginResponse {
    let value = setting.and_then(|document| document.get_document("value").ok());
    MarginResponse {
        success: true,
        data: MarginData {
            basic: normalize_margin(value.and_then(|doc| doc.get("basic")), 10.0),
            gold: normalize_margin(value.and_then(|doc| doc.get("gold")), 5.0),
            platinum: normalize_margin(value.and_then(|doc| doc.get("platinum")), 0.0),
            note: value
                .and_then(|doc| doc.get_str("note").ok())
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
        },
        meta: super::types::MarginMeta {
            updated_at: value
                .and_then(|doc| doc.get_str("updatedAt").ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .or_else(|| setting.and_then(|document| date_string(document, "updatedAt"))),
            updated_by: value
                .and_then(|doc| doc.get_document("updatedBy").ok())
                .and_then(audit_user_from_doc),
        },
        limits: MarginLimits {
            max_percent: MAX_MARGIN_PERCENT as i64,
            tiers: ["basic", "gold", "platinum"],
        },
    }
}

pub fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub fn string_message(status: axum::http::StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

pub fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}

pub fn date_time_to_string(value: DateTime) -> String {
    value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string())
}

fn normalize_margin(value: Option<&Bson>, fallback: f64) -> f64 {
    let number = match value {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        _ => fallback,
    };
    if number.is_finite() && (0.0..=MAX_MARGIN_PERCENT).contains(&number) {
        number
    } else {
        fallback
    }
}

fn audit_user_from_doc(document: &Document) -> Option<MarginAuditUser> {
    let id = document.get_str("id").ok()?.trim().to_string();
    let email = document.get_str("email").ok()?.trim().to_string();
    let role = document.get_str("role").ok()?.trim().to_string();
    if id.is_empty() || email.is_empty() || role.is_empty() {
        return None;
    }
    Some(MarginAuditUser { id, email, role })
}

fn date_string(document: &Document, key: &str) -> Option<String> {
    document.get_datetime(key).ok().map(|value| {
        value
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| value.to_string())
    })
}
