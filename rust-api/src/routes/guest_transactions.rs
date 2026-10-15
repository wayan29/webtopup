use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Datelike, Local};
use rand::{distributions::Alphanumeric, Rng};

use crate::{
    security::ErrorResponse,
};

const MAX_LIMIT: i64 = 100;

mod actions;
mod admin;
mod checkout;
mod idempotency;
mod list;
mod mappers;
mod provider;
mod public;
mod types;
mod utils;

use actions::*;
pub use admin::{admin_list, cancel_admin, confirm_admin, update_status_admin};
use checkout::*;
use list::*;
use mappers::*;
use provider::*;
pub use public::{check_public, create_public};
use types::*;
use utils::*;

fn generate_guest_ref_id() -> String {
    let now = Local::now();
    let random = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(4)
        .map(char::from)
        .collect::<String>()
        .to_uppercase();
    format!(
        "GUEST{:02}{:02}{}{random}",
        now.day(),
        now.month(),
        now.year()
    )
}


fn build_action_note(fallback_note: &str, note: Option<&str>) -> String {
    note.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_note)
        .to_string()
}

fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}


fn transaction_not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            message: "Transaction not found",
        }),
    )
        .into_response()
}


fn internal_error() -> Response {
    status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn status_message(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn status_message_owned(status: StatusCode, message: String) -> Response {
    (status, Json(OwnedErrorResponse { message })).into_response()
}
