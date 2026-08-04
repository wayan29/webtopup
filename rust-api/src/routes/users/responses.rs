use axum::{response::IntoResponse, Json};

use crate::security::ErrorResponse;

pub(super) fn not_found(message: &'static str) -> axum::response::Response {
    status_message(axum::http::StatusCode::NOT_FOUND, message)
}

pub(super) fn status_message(
    status: axum::http::StatusCode,
    message: &'static str,
) -> axum::response::Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn internal_error() -> axum::response::Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub(super) fn unavailable() -> axum::response::Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
