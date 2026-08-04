use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::Document;
use std::sync::Arc;

use crate::{
    security::{require_permission, ErrorResponse},
    state::AppState,
};

mod catalog_audit;
pub(in crate::routes) mod mappers;
mod mutations;
mod payload;
mod queries;
mod read;
mod sorting;
mod types;
pub(in crate::routes) mod utils;

use catalog_audit::*;
use mappers::*;
pub use mutations::{create_product, delete_product, update_product};
use payload::*;
use queries::*;
pub use read::{admin_all, public_detail, public_list};
pub use sorting::{admin_sorting, sort_by_price, update_sort_order};
use types::*;
use utils::*;

pub async fn catalog_audit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<CatalogAuditQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let limit = query.limit.unwrap_or(15).clamp(1, 100) as usize;
    let database = client.database(&state.mongo_db);
    let categories = load_documents(database.collection::<Document>("categories")).await;
    let operators = load_documents(database.collection::<Document>("operators")).await;
    let product_types = load_documents(database.collection::<Document>("producttypes")).await;
    let products = load_documents(database.collection::<Document>("products")).await;

    Json(run_catalog_audit(
        limit,
        categories
            .into_iter()
            .map(catalog_category_from_doc)
            .collect(),
        operators
            .into_iter()
            .map(catalog_operator_from_doc)
            .collect(),
        product_types
            .into_iter()
            .map(catalog_product_type_from_doc)
            .collect(),
        products.into_iter().map(catalog_product_from_doc).collect(),
    ))
    .into_response()
}

pub(super) fn normalize_non_negative_number(value: f64) -> i64 {
    if !value.is_finite() || value < 0.0 {
        0
    } else {
        value.trunc() as i64
    }
}

pub(super) fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub(super) fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
