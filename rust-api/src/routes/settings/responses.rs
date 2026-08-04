use axum::{response::IntoResponse, response::Response, Json};
use serde_json::json;

use crate::security::ErrorResponse;

pub fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}

pub fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub fn string_message(status: axum::http::StatusCode, message: String) -> Response {
    (status, Json(json!({ "message": message }))).into_response()
}

pub fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}
