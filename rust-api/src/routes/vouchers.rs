use axum::{
    response::{IntoResponse, Response},
    Json,
};

use crate::security::ErrorResponse;

mod admin;
mod mappers;
mod queries;
mod redeem;
mod redeem_helpers;
mod types;
mod validation;
pub use admin::{admin_list, archive, create, restore};
pub use redeem::redeem;
fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
