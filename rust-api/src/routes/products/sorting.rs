use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

use crate::{security::require_sql_permission, state::AppState};

use super::{normalize_non_negative_number, status_message, unavailable, ProductSortingQuery, SortByPricePayload, SortOrderPayload};

#[derive(Serialize)]
pub struct SortOrderResponse {
    success: bool,
    message: String,
}

pub async fn admin_sorting(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProductSortingQuery>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let Some((column, id)) = selected_filter(&query.category_id, &query.operator_id, &query.product_type_id) else {
        return status_message(StatusCode::BAD_REQUEST, "Please provide categoryId, operatorId, or productTypeId");
    };
    let sql = format!("{} WHERE {column}=$1 ORDER BY sort_order,created_at,id", super::mappers::PRODUCT_SELECT);
    match sqlx::query(&sql).bind(id).fetch_all(&state.pg_pool).await {
        Ok(rows) => Json(rows.iter().map(|row| super::mappers::document(row, false, false)).collect::<Vec<_>>()).into_response(),
        Err(_) => unavailable(),
    }
}

pub async fn update_sort_order(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SortOrderPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let Some(products) = payload.products else { return status_message(StatusCode::BAD_REQUEST, "Products array is required"); };
    let mut seen = std::collections::HashSet::with_capacity(products.len());
    let mut parsed = Vec::with_capacity(products.len());
    for product in &products {
        let Some(id) = canonical_uuid(&product.id) else { return status_message(StatusCode::BAD_REQUEST, "Product ID is invalid"); };
        if !seen.insert(id) { return status_message(StatusCode::BAD_REQUEST, "Product ID is duplicated"); }
        parsed.push((id, normalize_non_negative_number(product.sort_order.unwrap_or_default())));
    }
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    for (id, order) in &parsed {
        match sqlx::query("UPDATE products SET sort_order=$2,updated_at=now() WHERE id=$1").bind(id).bind(order).execute(&mut *tx).await {
            Ok(result) if result.rows_affected() == 1 => {}
            Ok(_) => return status_message(StatusCode::NOT_FOUND, "Product not found"),
            Err(_) => return unavailable(),
        }
    }
    if tx.commit().await.is_err() { return unavailable(); }
    Json(SortOrderResponse { success: true, message: format!("{} products updated", parsed.len()) }).into_response()
}

pub async fn sort_by_price(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SortByPricePayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let Some((column, id)) = selected_filter(&payload.category_id, &payload.operator_id, &payload.product_type_id) else {
        return status_message(StatusCode::BAD_REQUEST, "Please provide categoryId, operatorId, or productTypeId");
    };
    let direction = if payload.order.as_deref() == Some("desc") { "DESC" } else { "ASC" };
    let sql = format!("SELECT id FROM products WHERE {column}=$1 ORDER BY price_basic {direction},id");
    let ids = match sqlx::query_scalar::<_, Uuid>(&sql).bind(id).fetch_all(&state.pg_pool).await {
        Ok(ids) => ids,
        Err(_) => return unavailable(),
    };
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    for (index, id) in ids.iter().enumerate() {
        if sqlx::query("UPDATE products SET sort_order=$2,updated_at=now() WHERE id=$1").bind(id).bind((index + 1) as i64).execute(&mut *tx).await.is_err() { return unavailable(); }
    }
    if tx.commit().await.is_err() { return unavailable(); }
    Json(SortOrderResponse { success: true, message: format!("{} products sorted by price", ids.len()) }).into_response()
}

fn selected_filter(category: &Option<String>, operator: &Option<String>, product_type: &Option<String>) -> Option<(&'static str, Uuid)> {
    for (column, value) in [("category_id", category), ("operator_id", operator), ("product_type_id", product_type)] {
        if let Some(value) = value.as_deref().filter(|value| !value.trim().is_empty()) {
            return canonical_uuid(value.trim()).map(|id| (column, id));
        }
    }
    None
}

fn canonical_uuid(value: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(value).ok()?;
    (id.to_string() == value).then_some(id)
}
