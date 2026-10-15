use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    security::{require_sql_permission, require_sql_user},
    services::managed_assets::{effectively_changed_managed_field, ManagedFieldFolderPolicy},
    state::AppState,
};

use super::{
    responses::{not_found, status_message, string_message},
    types::{
        MessageResponse, PaymentCategoryItem, PaymentCategoryPayload, PaymentCategoryResponse,
        ReorderPaymentCategoriesPayload,
    },
    utils::slugify,
};

fn unavailable() -> Response {
    status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Database unavailable")
}
fn category_item(row: &sqlx::postgres::PgRow, stats: (i64, i64, i64)) -> PaymentCategoryItem {
    let id: Uuid = row.get("id");
    let method_count = stats.0;
    PaymentCategoryItem {
        id: id.to_string(),
        name: row.get("name"),
        slug: row.get("slug"),
        icon: row.get("icon"),
        order: row.get("sort_order"),
        status: row.get("status"),
        created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        updated_at: row.get::<DateTime<Utc>, _>("updated_at").to_rfc3339(),
        method_count,
        active_method_count: stats.1,
        inactive_method_count: stats.2,
        can_delete: method_count == 0,
        delete_blocked_reason: if method_count > 0 {
            format!("Kategori masih dipakai oleh {method_count} metode pembayaran.")
        } else {
            String::new()
        },
    }
}

fn public_category(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "_id": row.get::<Uuid, _>("id").to_string(),
        "name": row.get::<String, _>("name"),
        "slug": row.get::<String, _>("slug"),
        "icon": row.get::<String, _>("icon"),
        "order": row.get::<i64, _>("sort_order"),
        "status": row.get::<String, _>("status"),
        "createdAt": row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        "updatedAt": row.get::<DateTime<Utc>, _>("updated_at").to_rfc3339(),
        "__v": 0
    })
}

async fn category_method_stats(
    pool: &sqlx::PgPool,
) -> Result<HashMap<Uuid, (i64, i64, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT c.id, COUNT(m.id)::bigint AS total, \
         COUNT(m.id) FILTER (WHERE m.status='active')::bigint AS active, \
         COUNT(m.id) FILTER (WHERE m.status='inactive')::bigint AS inactive \
         FROM payment_categories c LEFT JOIN payment_methods m ON m.category_id=c.id \
         GROUP BY c.id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get("id"),
                (row.get("total"), row.get("active"), row.get("inactive")),
            )
        })
        .collect())
}

async fn category_rows(
    pool: &sqlx::PgPool,
    active_only: bool,
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    let query = if active_only {
        "SELECT id,name,slug,icon,sort_order,status,created_at,updated_at FROM payment_categories WHERE status='active' ORDER BY sort_order ASC,created_at DESC"
    } else {
        "SELECT id,name,slug,icon,sort_order,status,created_at,updated_at FROM payment_categories ORDER BY sort_order ASC,created_at DESC"
    };
    sqlx::query(query).fetch_all(pool).await
}

fn duplicate_response() -> Response {
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "Kategori dengan nama atau slug tersebut sudah ada",
    )
}

fn sql_error_response(error: &sqlx::Error) -> Response {
    if let sqlx::Error::Database(db) = error {
        if db.code().as_deref() == Some("23505") {
            return duplicate_response();
        }
    }
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub async fn categories_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewPayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let (rows, stats) = match (
        category_rows(pool, false).await,
        category_method_stats(pool).await,
    ) {
        (Ok(rows), Ok(stats)) => (rows, stats),
        _ => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    Json(
        rows.iter()
            .map(|row| {
                let id: Uuid = row.get("id");
                category_item(row, stats.get(&id).copied().unwrap_or_default())
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn categories_public(State(state): State<Arc<AppState>>) -> Response {
    categories_public_response(&state).await
}

pub async fn categories_active(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_user(&headers, &state).await {
        return response;
    }
    categories_public_response(&state).await
}

pub async fn categories_reorder(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReorderPaymentCategoriesPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let Some(orders) = payload.orders else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload reorder tidak valid",
        );
    };
    if orders.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload reorder tidak valid",
        );
    }
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::with_capacity(orders.len());
    for item in orders {
        let id = match Uuid::parse_str(&item.id) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Ada ID kategori yang tidak valid pada payload reorder",
                )
            }
        };
        if !seen.insert(id) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payload reorder mengandung ID kategori duplikat",
            );
        }
        if item.order < 1 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Urutan kategori harus berupa bilangan bulat positif",
            );
        }
        normalized.push((id, item.order));
    }
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let ids = normalized.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let count: i64 =
        match sqlx::query_scalar("SELECT COUNT(*) FROM payment_categories WHERE id=ANY($1)")
            .bind(&ids)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(count) => count,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            }
        };
    if count as usize != normalized.len() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada kategori yang tidak ditemukan saat reorder",
        );
    }
    for (id, order) in normalized {
        if sqlx::query("UPDATE payment_categories SET sort_order=$2,updated_at=now() WHERE id=$1")
            .bind(id)
            .bind(order)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    }
    if tx.commit().await.is_err() {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    Json(MessageResponse {
        message: "Order updated successfully",
    })
    .into_response()
}

pub async fn category_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PaymentCategoryPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let name = payload
        .name
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori wajib diisi",
        );
    }
    let slug_candidate = match payload.slug.as_deref() {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => name.clone(),
    };
    let slug = slugify(&slug_candidate);
    if slug.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Slug kategori tidak valid",
        );
    }
    let status = payload.status.unwrap_or_else(|| "active".to_string());
    if status != "active" && status != "inactive" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status kategori tidak valid",
        );
    }
    let duplicate: Result<bool, _> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM payment_categories WHERE slug=$1 OR lower(name)=lower($2))",
    )
    .bind(&slug)
    .bind(&name)
    .fetch_one(pool)
    .await;
    match duplicate {
        Ok(true) => return duplicate_response(),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
        _ => {}
    }
    let max_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order),0) FROM payment_categories")
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    let order = match payload.order {
        Some(v) if v.is_finite() && v > 0.0 => v.floor() as i64,
        _ => max_order + 1,
    };
    let icon = payload.icon.unwrap_or_default().trim().to_string();
    if let Err(response) = crate::services::managed_assets::ensure_managed_field(
        &crate::routes::uploads::upload_root(),
        &icon,
        ManagedFieldFolderPolicy::Icons,
    ) {
        return response;
    }
    let row = match sqlx::query("INSERT INTO payment_categories(name,slug,icon,status,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING id,name,slug,icon,status,sort_order,created_at,updated_at")
        .bind(&name).bind(&slug).bind(&icon).bind(&status).bind(order).fetch_one(pool).await { Ok(row) => row, Err(e) => return sql_error_response(&e) };
    let value = json!({"_id": row.get::<Uuid,_>("id").to_string(), "name": row.get::<String,_>("name"), "slug": row.get::<String,_>("slug"), "icon": row.get::<String,_>("icon"), "order": row.get::<i64,_>("sort_order"), "status": row.get::<String,_>("status"), "createdAt": row.get::<DateTime<Utc>,_>("created_at").to_rfc3339(), "updatedAt": row.get::<DateTime<Utc>,_>("updated_at").to_rfc3339(), "__v": 0});
    (
        axum::http::StatusCode::CREATED,
        Json(PaymentCategoryResponse {
            message: "Payment category created",
            category: value,
        }),
    )
        .into_response()
}

pub async fn category_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PaymentCategoryPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let category_id = match Uuid::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID kategori tidak valid",
            )
        }
    };
    let current = match sqlx::query(
        "SELECT id,name,slug,icon,status,sort_order FROM payment_categories WHERE id=$1",
    )
    .bind(category_id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Payment category not found"),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let current_name: String = current.get("name");
    let name = payload
        .name
        .as_deref()
        .unwrap_or(&current_name)
        .trim()
        .to_string();
    if name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori wajib diisi",
        );
    }
    let current_slug: String = current.get("slug");
    let slug_candidate = match payload.slug.as_deref() {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        Some(_) => name.clone(),
        None if payload.name.is_some() => name.clone(),
        None => current_slug,
    };
    let slug = slugify(&slug_candidate);
    if slug.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Slug kategori tidak valid",
        );
    }
    let current_status: String = current.get("status");
    let status = payload.status.unwrap_or(current_status);
    if status != "active" && status != "inactive" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status kategori tidak valid",
        );
    }
    let duplicate: Result<bool, _> = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_categories WHERE id<>$1 AND (slug=$2 OR lower(name)=lower($3)))").bind(category_id).bind(&slug).bind(&name).fetch_one(pool).await;
    match duplicate {
        Ok(true) => return duplicate_response(),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
        _ => {}
    }
    let previous_icon: String = current.get("icon");
    let icon = payload
        .icon
        .unwrap_or_else(|| previous_icon.clone())
        .trim()
        .to_string();
    if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
        &crate::routes::uploads::upload_root(),
        &icon,
        ManagedFieldFolderPolicy::Icons,
        effectively_changed_managed_field(Some(&previous_icon), &icon),
    ) {
        return response;
    }
    let order = payload
        .order
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or_else(|| current.get("sort_order"));
    let updated = match sqlx::query("UPDATE payment_categories SET name=$2,slug=$3,icon=$4,status=$5,sort_order=$6,updated_at=now() WHERE id=$1 RETURNING id,name,slug,icon,status,sort_order,created_at,updated_at")
        .bind(category_id).bind(&name).bind(&slug).bind(&icon).bind(&status).bind(order).fetch_one(pool).await { Ok(row) => row, Err(e) => return sql_error_response(&e) };
    Json(PaymentCategoryResponse { message: "Payment category updated", category: json!({"_id": updated.get::<Uuid,_>("id").to_string(), "name": updated.get::<String,_>("name"), "slug": updated.get::<String,_>("slug"), "icon": updated.get::<String,_>("icon"), "order": updated.get::<i64,_>("sort_order"), "status": updated.get::<String,_>("status"), "createdAt": updated.get::<DateTime<Utc>,_>("created_at").to_rfc3339(), "updatedAt": updated.get::<DateTime<Utc>,_>("updated_at").to_rfc3339(), "__v": 0}) }).into_response()
}

pub async fn category_delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let category_id = match Uuid::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID kategori tidak valid",
            )
        }
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let category = match sqlx::query("SELECT name FROM payment_categories WHERE id=$1 FOR UPDATE")
        .bind(category_id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Payment category not found"),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let method_count: i64 =
        match sqlx::query_scalar("SELECT COUNT(*) FROM payment_methods WHERE category_id=$1")
            .bind(category_id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(count) => count,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            }
        };
    if method_count > 0 {
        let name: String = category.get("name");
        return string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Kategori \"{}\" masih dipakai oleh {} metode pembayaran dan tidak bisa dihapus.",
                name, method_count
            ),
        );
    }
    if sqlx::query("DELETE FROM payment_categories WHERE id=$1")
        .bind(category_id)
        .execute(&mut *tx)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    Json(MessageResponse {
        message: "Payment category deleted",
    })
    .into_response()
}

async fn categories_public_response(state: &AppState) -> Response {
    let pool = &state.pg_pool;
    match category_rows(pool, true).await {
        Ok(rows) => Json(rows.iter().map(public_category).collect::<Vec<_>>()).into_response(),
        Err(_) => Json(Vec::<Value>::new()).into_response(),
    }
}
