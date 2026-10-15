use axum::{response::{IntoResponse, Response}, Json};
use serde_json::Value;

use crate::security::ErrorResponse;

use super::types::{MarginAuditUser, MarginData, MarginLimits, MarginResponse, MAX_MARGIN_PERCENT};

pub fn format_margin_response(setting: Option<&Value>) -> MarginResponse {
    let value = setting.and_then(|setting| setting.get("value"));
    let updated_by = value
        .and_then(|value| value.get("updatedBy"))
        .filter(|value| value.is_object())
        .and_then(|value| {
            Some(MarginAuditUser {
                id: value.get("id")?.as_str()?.trim().to_string(),
                email: value.get("email")?.as_str()?.trim().to_string(),
                role: value.get("role")?.as_str()?.trim().to_string(),
            })
        })
        .filter(|user| !user.id.is_empty() && !user.email.is_empty() && !user.role.is_empty());
    MarginResponse {
        success: true,
        data: MarginData {
            basic: normalize_margin(value.and_then(|value| value.get("basic")), 10.0),
            gold: normalize_margin(value.and_then(|value| value.get("gold")), 5.0),
            platinum: normalize_margin(value.and_then(|value| value.get("platinum")), 0.0),
            note: value
                .and_then(|value| value.get("note"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
        },
        meta: super::types::MarginMeta {
            updated_at: value
                .and_then(|value| value.get("updatedAt"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    setting
                        .and_then(|setting| setting.get("updatedAt"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                }),
            updated_by,
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

fn normalize_margin(value: Option<&Value>, fallback: f64) -> f64 {
    let number = value.and_then(Value::as_f64).unwrap_or(fallback);
    if number.is_finite() && (0.0..=MAX_MARGIN_PERCENT).contains(&number) {
        number
    } else {
        fallback
    }
}
