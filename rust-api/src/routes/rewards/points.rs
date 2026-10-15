use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use uuid::Uuid;

use super::{internal_error, status_message, unavailable};
use super::{mappers::*, points_helpers::*, types::*, validation::*};
use crate::{
    security::{require_sql_permission, require_sql_user, ErrorResponse},
    state::AppState,
};

const POINT_TYPES: [&str; 3] = ["earn", "redeem", "admin_adjustment"];

pub async fn points_settings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let value = match site_setting_i64(&state.pg_pool, POINTS_PER_TRANSACTION_KEY, 100).await {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let point_value_rate = match site_setting_i64(&state.pg_pool, POINT_VALUE_RATE_KEY, 1).await {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };

    Json(PointsSettingsResponse {
        id: POINTS_PER_TRANSACTION_KEY.to_string(),
        key: POINTS_PER_TRANSACTION_KEY.to_string(),
        value,
        description: "Points earned per Rp 10,000 transaction".to_string(),
        point_value_rate,
    })
    .into_response()
}

pub async fn points_settings_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PointsSettingsPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let value = payload.value.and_then(number_value);
    let point_value_rate = payload.point_value_rate.and_then(number_value);
    if value.is_some_and(|value| value < 1) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Points per transaction must be at least 1",
        );
    }
    if point_value_rate.is_some_and(|value| value < 1) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Point value rate must be at least 1 Rupiah",
        );
    }
    if value.is_none() && point_value_rate.is_none() {
        return Json(PointsSettingsUpdateResponse {
            message: "Points settings updated successfully",
            points_per_transaction: None,
            point_value_rate: None,
        })
        .into_response();
    }

    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return unavailable(),
    };
    if let Some(value) = value {
        if upsert_points_setting(&mut tx, POINTS_PER_TRANSACTION_KEY, value)
            .await
            .is_err()
        {
            return internal_error();
        }
    }
    if let Some(point_value_rate) = point_value_rate {
        if upsert_points_setting(&mut tx, POINT_VALUE_RATE_KEY, point_value_rate)
            .await
            .is_err()
        {
            return internal_error();
        }
    }
    if tx.commit().await.is_err() {
        return internal_error();
    }

    Json(PointsSettingsUpdateResponse {
        message: "Points settings updated successfully",
        points_per_transaction: value,
        point_value_rate,
    })
    .into_response()
}

pub async fn points_stats(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let earned = match sum_points(&state.pg_pool, None, "earn", false).await {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let redeemed = match sum_points(&state.pg_pool, None, "redeem", true).await {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let Ok((active_users, total_users)) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM users WHERE points > 0) AS active_users, \
         (SELECT COUNT(*) FROM users WHERE role = 'member') AS total_users",
    )
    .fetch_one(&state.pg_pool)
    .await
    else {
        return unavailable();
    };
    let engagement_rate = if total_users > 0 {
        ((active_users as f64 / total_users as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    Json(PointsStatsResponse {
        total_points_earned: earned,
        total_points_redeemed: redeemed,
        active_users,
        total_users,
        engagement_rate,
    })
    .into_response()
}

pub async fn points_adjust(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PointsAdjustPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Ok(user_id) = Uuid::parse_str(payload.user_id.trim()) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };

    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return unavailable(),
    };
    let current_points = match sqlx::query_scalar::<_, i64>("SELECT points FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(points) => points,
        Err(_) => return internal_error(),
    };
    let Some(current_points) = current_points else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    if payload.points < 0 && current_points + payload.points < 0 {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Insufficient points");
    }
    let new_points = match sqlx::query_scalar::<_, i64>(
        "UPDATE users SET points = points + $2, updated_at = now() WHERE id = $1 RETURNING points",
    )
    .bind(user_id)
    .bind(payload.points)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(points) => points,
        Err(_) => return internal_error(),
    };
    if sqlx::query(
        "INSERT INTO point_ledger (user_ref, claim_key, points, transaction_type, description) \
         VALUES ($1::text, 'admin:' || gen_random_uuid()::text, $2, 'admin_adjustment', $3)",
    )
    .bind(user_id)
    .bind(payload.points)
    .bind(payload.description.trim())
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return internal_error();
    }
    if tx.commit().await.is_err() {
        return internal_error();
    }

    Json(PointsAdjustResponse {
        message: "Points adjusted successfully",
        new_points,
    })
    .into_response()
}

pub async fn point_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<PointTransactionsQuery>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await {
        return response;
    }

    let transaction_type = query.transaction_type.as_deref().unwrap_or_default().trim();
    if !transaction_type.is_empty()
        && transaction_type != "all"
        && !POINT_TYPES.contains(&transaction_type)
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Invalid transaction type",
            }),
        )
            .into_response();
    }

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let type_filter = if transaction_type.is_empty() || transaction_type == "all" {
        String::new()
    } else {
        transaction_type.to_string()
    };
    let total = match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM point_ledger WHERE ($1::text = '' OR transaction_type = $1::text)",
    )
    .bind(&type_filter)
    .fetch_one(&state.pg_pool)
    .await
    {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let rows = match sqlx::query(
        "SELECT l.id, l.user_ref, l.transaction_type, l.points, l.description, l.reward_id, l.created_at, \
                u.id AS ledger_user_id, u.name AS user_name, u.email AS user_email, \
                r.name AS reward_name \
         FROM point_ledger l \
         LEFT JOIN users u ON u.id::text = l.user_ref \
         LEFT JOIN rewards r ON r.id = l.reward_id \
         WHERE ($1::text = '' OR l.transaction_type = $1::text) \
         ORDER BY l.created_at DESC, l.id DESC \
         LIMIT $2 OFFSET $3",
    )
    .bind(&type_filter)
    .bind(limit)
    .bind((page - 1) * limit)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return unavailable(),
    };
    let total_pages = std::cmp::max(1, (total + limit - 1) / limit);

    Json(PointTransactionsResponse {
        items: rows.iter().map(point_transaction_from_row).collect(),
        meta: PointTransactionsMeta {
            page,
            limit,
            total,
            total_pages,
        },
    })
    .into_response()
}

pub async fn points_history(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<PointTransactionsQuery>,
) -> Response {
    let user = match require_sql_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    let transaction_type = query.transaction_type.as_deref().unwrap_or_default().trim();
    if !transaction_type.is_empty()
        && transaction_type != "all"
        && !POINT_TYPES.contains(&transaction_type)
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Invalid transaction type",
            }),
        )
            .into_response();
    }

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(15).clamp(1, 100);
    let user_ref = user.id.to_string();
    let type_filter = if transaction_type.is_empty() || transaction_type == "all" {
        String::new()
    } else {
        transaction_type.to_string()
    };
    let total = match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM point_ledger \
         WHERE user_ref = $1 AND ($2::text = '' OR transaction_type = $2::text)",
    )
    .bind(&user_ref)
    .bind(&type_filter)
    .fetch_one(&state.pg_pool)
    .await
    {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let rows = match sqlx::query(
        "SELECT l.id, l.user_ref, l.transaction_type, l.points, l.description, l.reward_id, l.created_at, \
                r.name AS reward_name, \
                ft.id AS related_tx_id, ft.amount AS related_tx_amount, ft.status AS related_tx_status, \
                ft.snapshot ->> 'target' AS related_tx_target, \
                p.id AS product_id, p.name AS product_name \
         FROM point_ledger l \
         LEFT JOIN rewards r ON r.id = l.reward_id \
         LEFT JOIN financial_transactions ft ON ft.id::text = l.related_transaction \
         LEFT JOIN products p ON p.id = ft.product_id \
         WHERE l.user_ref = $1 AND ($2::text = '' OR l.transaction_type = $2::text) \
         ORDER BY l.created_at DESC, l.id DESC \
         LIMIT $3 OFFSET $4",
    )
    .bind(&user_ref)
    .bind(&type_filter)
    .bind(limit)
    .bind((page - 1) * limit)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return unavailable(),
    };

    let current_points = match user_points(&state.pg_pool, user.id).await {
        Ok(points) => points,
        Err(_) => return unavailable(),
    };
    let point_value_rate = match site_setting_i64(&state.pg_pool, POINT_VALUE_RATE_KEY, 1).await {
        Ok(value) => value.max(1),
        Err(_) => return unavailable(),
    };
    let points_per_transaction = match site_setting_i64(
        &state.pg_pool,
        POINTS_PER_TRANSACTION_KEY,
        100,
    )
    .await
    {
        Ok(value) => value.max(1),
        Err(_) => return unavailable(),
    };
    let total_earned = match sum_points(&state.pg_pool, Some(user_ref.as_str()), "earn", false)
        .await
    {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let total_redeemed = match sum_points(&state.pg_pool, Some(user_ref.as_str()), "redeem", true)
        .await
    {
        Ok(total) => total,
        Err(_) => return unavailable(),
    };
    let total_pages = std::cmp::max(1, (total + limit - 1) / limit);
    let items = rows
        .iter()
        .map(points_history_item_from_row)
        .collect::<Vec<_>>();
    let last_activity_at = items.first().map(|item| item.created_at.clone());

    Json(PointsHistoryResponse {
        current_points,
        point_value_rate,
        points_per_transaction,
        estimated_value: current_points * point_value_rate,
        history: items.clone(),
        items,
        summary: PointsHistorySummary {
            current_points,
            total_earned,
            total_redeemed,
            activity_count: total,
            last_activity_at,
        },
        meta: PointsHistoryMeta {
            page,
            limit,
            total,
            total_pages,
            transaction_type: if transaction_type.is_empty() {
                "all".to_string()
            } else {
                transaction_type.to_string()
            },
        },
    })
    .into_response()
}
