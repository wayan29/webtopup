use axum::{response::IntoResponse, response::Response, Json};
use mongodb::bson::Document;

use crate::security::ErrorResponse;

mod actions;
mod admin;
mod config;
mod digiflazz;
mod health;
mod json;
mod providers;
mod settings;
mod sync_pricing;
mod tokovoucher;
mod types;

pub use actions::*;
pub use admin::*;
pub use digiflazz::*;
pub use health::{export_vendor_health_csv, vendor_health, vendor_health_snapshot, vendor_stats};
pub use settings::*;
pub use tokovoucher::*;
use types::*;

fn tokovoucher_query_bad_request(message: &'static str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "success": false,
            "message": message,
            "data": []
        })),
    )
        .into_response()
}

fn vendor_balance_bad_request(message: &str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(VendorBalanceErrorResponse {
            message: message.to_string(),
            balance: None,
        }),
    )
        .into_response()
}

fn vendor_id(document: &Document) -> String {
    document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default()
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
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
