use axum::{response::IntoResponse, response::Response, Json};

use crate::security::ErrorResponse;

pub fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
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
