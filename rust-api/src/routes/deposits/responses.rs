use axum::{
    response::{IntoResponse, Response},
    Json,
};

use crate::security::ErrorResponse;

pub(super) fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn status_message_owned(status: axum::http::StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

pub(super) fn deposit_assignment_conflict() -> Response {
    status_message(
        axum::http::StatusCode::CONFLICT,
        "Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain",
    )
}

pub(super) fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub(super) fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}
