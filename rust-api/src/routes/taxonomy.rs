use axum::{
    response::{IntoResponse, Response},
    Json,
};

use crate::security::ErrorResponse;

mod categories;
mod dependencies;
mod description_html;
mod json;
mod mappers;
mod operators;
mod product_types;
mod queries;
mod types;

use dependencies::*;
use json::{document_to_json, normalize_non_negative_number};
use mappers::*;
use queries::*;
use types::*;

pub use categories::*;
pub use operators::*;
pub use product_types::*;

fn not_found(message: &'static str) -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse { message }),
    )
        .into_response()
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
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
