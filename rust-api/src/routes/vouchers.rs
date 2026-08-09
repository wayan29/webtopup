use axum::{
    response::{IntoResponse, Response},
    Json,
};

use crate::security::ErrorResponse;

mod admin;
mod discount;
mod giveaway;
mod mappers;
mod queries;
mod redeem;
mod redeem_helpers;
mod types;
mod validation;
pub use admin::{admin_export, admin_list, archive, create, restore};
pub use discount::{
    consume_discount_voucher, release_discount_slot, validate_discount_code, AppliedDiscount,
    DiscountProductContext,
};
pub use giveaway::{
    giveaway_detail, giveaway_execute, giveaway_list, giveaway_preview,
};
pub use redeem::redeem;

pub async fn validate_discount(
    headers: axum::http::HeaderMap,
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Json(payload): Json<types::DiscountValidatePayload>,
) -> Response {
    // Members or guests (via proxy without member) can validate; prefer member when present.
    let user_id = crate::security::require_member_user(&headers, &state)
        .await
        .ok()
        .map(|user| user.id);
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let code = payload
        .code
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_uppercase();
    if code.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode voucher wajib diisi",
        );
    }
    let amount = payload.amount.unwrap_or(0).max(0);
    if amount < 1 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nominal belanja wajib diisi",
        );
    }
    let vouchers = client
        .database(&state.mongo_db)
        .collection::<mongodb::bson::Document>("vouchers");
    let product_ctx = DiscountProductContext {
        product_id: payload
            .product_id
            .as_deref()
            .and_then(|value| mongodb::bson::oid::ObjectId::parse_str(value.trim()).ok()),
        category_id: payload
            .category_id
            .as_deref()
            .and_then(|value| mongodb::bson::oid::ObjectId::parse_str(value.trim()).ok()),
        operator_id: payload
            .operator_id
            .as_deref()
            .and_then(|value| mongodb::bson::oid::ObjectId::parse_str(value.trim()).ok()),
    };
    match validate_discount_code(&vouchers, &code, amount, user_id, &product_ctx).await {
        Ok(response) => Json(response).into_response(),
        Err(response) => response,
    }
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

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
