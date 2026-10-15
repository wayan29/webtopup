use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::{security::require_sql_permission, state::AppState};

use super::{
    mappers::{document, PRODUCT_SELECT},
    payload::{
        like_pattern, resolve_category_by_id, resolve_category_by_name, resolve_operator_by_id,
        resolve_operator_by_name, resolve_product_type_by_id,
    },
    status_message, AdminProductsQuery,
};

pub async fn admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminProductsQuery>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let mut builder = QueryBuilder::<Postgres>::new(PRODUCT_SELECT);
    builder.push(" WHERE true");
    let status = query.status.as_deref().map(str::trim).unwrap_or_default();
    if !status.is_empty() && status != "all" {
        builder.push(" AND p.status=").push_bind(status == "true" || status == "active");
    }
    if let Some(category) = trimmed(&query.category) {
        builder.push(" AND p.category=").push_bind(category);
    }
    if let Some(id) = parse_uuid(query.category_id.as_deref()) {
        builder.push(" AND p.category_id=").push_bind(id);
    }
    if let Some(id) = parse_uuid(query.operator_id.as_deref()) {
        builder.push(" AND p.operator_id=").push_bind(id);
    }
    if let Some(id) = parse_uuid(query.product_type_id.as_deref()) {
        builder.push(" AND p.product_type_id=").push_bind(id);
    }
    if let Some(brand) = trimmed(&query.brand) {
        builder
            .push(" AND lower(p.brand)=lower(")
            .push_bind(brand)
            .push(")");
    }
    if let Some(search) = trimmed(&query.search) {
        let pattern = like_pattern(&search);
        builder.push(" AND (p.name ILIKE ").push_bind(pattern.clone());
        builder.push(" OR p.code ILIKE ").push_bind(pattern.clone());
        builder.push(" OR p.brand ILIKE ").push_bind(pattern.clone());
        builder.push(" OR p.vendor_sku ILIKE ").push_bind(pattern);
        builder.push(")");
    }
    builder.push(" ORDER BY p.created_at DESC, p.id");
    let items = match builder.build().fetch_all(&state.pg_pool).await {
        Ok(rows) => rows.iter().map(|row| document(row, true, true)).collect(),
        Err(_) => Vec::new(),
    };
    Json(items).into_response()
}

pub async fn public_list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminProductsQuery>,
) -> Response {
    let mut conn = match state.pg_pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return unavailable(),
    };
    match public_products(&mut conn, &query).await {
        Ok(products) => Json(products).into_response(),
        Err(_) => unavailable(),
    }
}

pub async fn public_detail(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(id) = parse_uuid(Some(id.trim())) else {
        return status_message(StatusCode::NOT_FOUND, "Product not found");
    };
    let sql = format!("{PRODUCT_SELECT} WHERE p.id=$1");
    match sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&state.pg_pool)
        .await
    {
        Ok(Some(row)) => {
            let mut value = document(&row, false, false);
            super::mappers::normalize_validation(&mut value);
            Json(value).into_response()
        }
        Ok(None) => status_message(StatusCode::NOT_FOUND, "Product not found"),
        Err(_) => status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

async fn public_products(
    conn: &mut PgConnection,
    query: &AdminProductsQuery,
) -> Result<Vec<Value>, sqlx::Error> {
    let resolved_category = match parse_uuid(query.category_id.as_deref()) {
        Some(id) => resolve_category_by_id(conn, id).await,
        None => match trimmed(&query.category) {
            Some(name) => resolve_category_by_name(conn, &name).await,
            None => None,
        },
    };
    let resolved_operator = match parse_uuid(query.operator_id.as_deref()) {
        Some(id) => resolve_operator_by_id(conn, id).await,
        None => match trimmed(&query.brand) {
            Some(brand) => {
                resolve_operator_by_name(conn, &brand, resolved_category.as_ref()).await
            }
            None => None,
        },
    };
    let resolved_product_type = match parse_uuid(query.product_type_id.as_deref()) {
        Some(id) => resolve_product_type_by_id(conn, id).await,
        None => None,
    };
    let mut scoped_operator = resolved_operator.clone();
    let mut scoped_category = resolved_category.clone();
    if scoped_operator.is_none() {
        if let Some(product_type) = &resolved_product_type {
            scoped_operator = resolve_operator_by_id(conn, product_type.operator_id).await;
        }
    }
    if scoped_category.is_none() {
        if let Some(product_type) = &resolved_product_type {
            scoped_category = resolve_category_by_id(conn, product_type.category_id).await;
        }
    }
    if scoped_category.is_none() {
        if let Some(operator) = &scoped_operator {
            scoped_category = resolve_category_by_id(conn, operator.category_id).await;
        }
    }

    let mut builder = QueryBuilder::<Postgres>::new(PRODUCT_SELECT);
    builder.push(" WHERE true");
    match query.status.as_deref() {
        None => { builder.push(" AND p.status"); }
        Some("all") => {}
        Some(value) => { builder.push(" AND p.status=").push_bind(value == "true"); }
    }
    if let Some(search) = trimmed(&query.search) {
        let pattern = like_pattern(&search);
        builder.push(" AND (p.name ILIKE ").push_bind(pattern.clone());
        builder.push(" OR p.code ILIKE ").push_bind(pattern.clone());
        builder.push(" OR p.brand ILIKE ").push_bind(pattern);
        builder.push(")");
    }

    match (&resolved_product_type, &scoped_operator) {
        (Some(product_type), Some(operator)) => {
            let category_id = scoped_category.as_ref().map(|value| value.id);
            let category_name = scoped_category.as_ref().map(|value| value.name.clone());
            builder
                .push(" AND (p.product_type_id=")
                .push_bind(product_type.id);
            builder
                .push(")");
            builder.push(" OR (p.product_type_id IS NULL AND lower(p.brand)=lower(");
            builder.push_bind(operator.name.clone());
            builder.push(")");
            push_legacy_category_clause(&mut builder, category_id, category_name);
            builder.push("))");
        }
        (None, Some(operator)) => {
            let category_id = scoped_category
                .as_ref()
                .map(|value| value.id)
                .unwrap_or(operator.category_id);
            let category_name = scoped_category.as_ref().map(|value| value.name.clone());
            builder
                .push(" AND (p.operator_id=")
                .push_bind(operator.id)
                .push(" OR (lower(p.brand)=lower(");
            builder.push_bind(operator.name.clone());
            builder.push(") AND p.operator_id IS NULL");
            push_legacy_category_clause(&mut builder, Some(category_id), category_name);
            builder.push("))");
        }
        _ => {
            if scoped_operator.is_none() {
                let category_id = resolved_category
                    .as_ref()
                    .map(|value| value.id)
                    .or_else(|| parse_uuid(query.category_id.as_deref()));
                let category_name = resolved_category
                    .as_ref()
                    .map(|value| value.name.clone())
                    .or_else(|| trimmed(&query.category));
                if category_id.is_some() || category_name.is_some() {
                    builder.push(" AND (");
                    push_legacy_category_clause(
                        &mut builder,
                        category_id,
                        category_name.clone(),
                    );
                    builder.push(")");
                }
            }
        }
    }
    builder.push(" ORDER BY p.sort_order, p.created_at, p.id");
    let rows = builder.build().fetch_all(conn).await?;
    Ok(rows.iter().map(|row| document(row, true, true)).collect())
}

/// `(p.category_id=$n OR lower(p.category)=lower($m))`, matching the legacy name-or-id filter.
fn push_legacy_category_clause(
    builder: &mut QueryBuilder<'_, Postgres>,
    category_id: Option<Uuid>,
    category_name: Option<String>,
) {
    if category_id.is_none() && category_name.is_none() {
        return;
    }
    builder.push(" AND (");
    if let Some(id) = category_id {
        builder.push("p.category_id=").push_bind(id);
        if category_name.is_some() {
            builder.push(" OR ");
        }
    }
    if let Some(name) = category_name {
        builder.push("lower(p.category)=lower(").push_bind(name).push(")");
    }
    builder.push(")");
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn parse_uuid(value: Option<&str>) -> Option<Uuid> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Uuid::parse_str(value).ok())
}

fn unavailable() -> Response {
    status_message(StatusCode::SERVICE_UNAVAILABLE, "Layanan database belum tersedia")
}
