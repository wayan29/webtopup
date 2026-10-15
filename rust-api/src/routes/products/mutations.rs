use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use uuid::Uuid;

use crate::{security::require_sql_permission, state::AppState};

use super::{
    internal_error, lock_catalog, mappers, payload::build_product_payload, status_message,
    ProductPayload,
};

pub async fn create_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ProductPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if lock_catalog(&mut tx).await.is_err() {
        return internal_error();
    }
    let normalized = match build_product_payload(&mut tx, &payload.0, None).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    match sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM products WHERE code=$1)")
        .bind(&normalized.code)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(true) => return duplicate_code(&normalized.code),
        Ok(false) => {}
        Err(_) => return internal_error(),
    }
    let sort_order = match normalized.sort_order {
        Some(order) => order,
        None => match sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(max(sort_order),0)+1 FROM products WHERE product_type_id=$1",
        )
        .bind(normalized.product_type_id)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(value) => value,
            Err(_) => return internal_error(),
        },
    };
    let inserted = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO products(name,code,category,category_id,operator_id,product_type_id,payment_type,brand,cost_price,price_basic,price_gold,price_platinum,reward_points,icon,vendor_name,vendor_sku,status,sort_order) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id",
    )
    .bind(&normalized.name)
    .bind(&normalized.code)
    .bind(&normalized.category)
    .bind(normalized.category_id)
    .bind(normalized.operator_id)
    .bind(normalized.product_type_id)
    .bind(&normalized.payment_type)
    .bind(&normalized.brand)
    .bind(normalized.cost_price)
    .bind(normalized.price.basic)
    .bind(normalized.price.gold)
    .bind(normalized.price.platinum)
    .bind(normalized.reward_points)
    .bind(&normalized.icon)
    .bind(&normalized.vendor.name)
    .bind(&normalized.vendor.sku)
    .bind(normalized.status)
    .bind(sort_order)
    .fetch_one(&mut *tx)
    .await;
    let id = match inserted {
        Ok(id) => id,
        Err(error) => return insert_error(error, &normalized.code),
    };
    let product = mappers::load(&mut tx, id, true).await.ok().flatten();
    if tx.commit().await.is_err() {
        return internal_error();
    }
    (
        StatusCode::CREATED,
        Json(json!({"message":"Product created","product":product})),
    )
        .into_response()
}

pub async fn update_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ProductPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(id) = Uuid::parse_str(id.trim()).ok() else {
        return internal_error();
    };
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    let existing_row = match sqlx::query(&format!("{} WHERE p.id=$1", mappers::PRODUCT_SELECT))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(row) => row,
        Err(_) => return internal_error(),
    };
    let Some(existing_row) = existing_row else {
        return status_message(StatusCode::NOT_FOUND, "Product not found");
    };
    let existing = mappers::document(&existing_row, false, false);
    let normalized = match build_product_payload(&mut tx, &payload.0, Some(&existing)).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    match sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM products WHERE code=$1 AND id<>$2)",
    )
    .bind(&normalized.code)
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(true) => return duplicate_code(&normalized.code),
        Ok(false) => {}
        Err(_) => return internal_error(),
    }
    let updated = sqlx::query(
        "UPDATE products SET name=$2,code=$3,category=$4,category_id=$5,operator_id=$6,product_type_id=$7,payment_type=$8,brand=$9,cost_price=$10,price_basic=$11,price_gold=$12,price_platinum=$13,reward_points=$14,icon=$15,vendor_name=$16,vendor_sku=$17,status=$18,sort_order=COALESCE($19,sort_order),updated_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(&normalized.name)
    .bind(&normalized.code)
    .bind(&normalized.category)
    .bind(normalized.category_id)
    .bind(normalized.operator_id)
    .bind(normalized.product_type_id)
    .bind(&normalized.payment_type)
    .bind(&normalized.brand)
    .bind(normalized.cost_price)
    .bind(normalized.price.basic)
    .bind(normalized.price.gold)
    .bind(normalized.price.platinum)
    .bind(normalized.reward_points)
    .bind(&normalized.icon)
    .bind(&normalized.vendor.name)
    .bind(&normalized.vendor.sku)
    .bind(normalized.status)
    .bind(normalized.sort_order)
    .execute(&mut *tx)
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 0 => {
            return status_message(StatusCode::NOT_FOUND, "Product not found")
        }
        Ok(_) => {}
        Err(error) => return insert_error(error, ""),
    }
    let product = mappers::load(&mut tx, id, true).await.ok().flatten();
    if tx.commit().await.is_err() {
        return internal_error();
    }
    Json(json!({"message":"Product updated","product":product})).into_response()
}

pub async fn delete_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(id) = Uuid::parse_str(id.trim()).ok() else {
        return internal_error();
    };
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    let existing = match sqlx::query_as::<_, (bool,)>(
        "SELECT status FROM products WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(row)) => row.0,
        Ok(None) => return status_message(StatusCode::NOT_FOUND, "Product not found"),
        Err(_) => return internal_error(),
    };
    if !existing {
        if sqlx::query("DELETE FROM products WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return internal_error();
        }
        if tx.commit().await.is_err() {
            return internal_error();
        }
        return Json(json!({
            "message": "Product removed permanently",
            "productId": id.to_string(),
        }))
        .into_response();
    }
    if sqlx::query("UPDATE products SET status=false,updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return internal_error();
    }
    let product = mappers::load(&mut tx, id, true).await.ok().flatten();
    if tx.commit().await.is_err() {
        return internal_error();
    }
    Json(json!({
        "message": "Product deactivated (soft delete)",
        "product": product,
    }))
    .into_response()
}

fn insert_error(error: sqlx::Error, code: &str) -> Response {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation())
    {
        duplicate_code(code)
    } else {
        internal_error()
    }
}

fn duplicate_code(code: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "message": "Kode produk sudah digunakan, gunakan kode unik lain",
            "field": "code",
            "duplicate": code,
        })),
    )
        .into_response()
}
