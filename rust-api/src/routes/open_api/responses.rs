use axum::{response::IntoResponse, response::Response, Json};

use crate::security::ErrorResponse;

use super::types::ApiErrorResponse;

pub fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub fn api_error(status: axum::http::StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(ApiErrorResponse {
            success: false,
            message,
        }),
    )
        .into_response()
}

pub fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}
