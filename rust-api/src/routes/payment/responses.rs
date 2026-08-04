use axum::{
    response::{IntoResponse, Response},
    Json,
};

use crate::security::ErrorResponse;

pub(super) fn not_found(message: &'static str) -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse { message }),
    )
        .into_response()
}

pub(super) fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn string_message(status: axum::http::StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

pub(super) fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}
