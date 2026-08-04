use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use super::{internal_error, status_message, unavailable};
use super::{mappers::*, points_helpers::*, types::*, validation::*};
use crate::{
    security::{require_permission, require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

const POINT_TYPES: [&str; 3] = ["earn", "redeem", "admin_adjustment"];

pub async fn points_settings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let settings = client
        .database(&state.mongo_db)
        .collection::<Document>("settings");
    let points = settings
        .find_one(doc! { "key": "points_per_transaction" })
        .await
        .ok()
        .flatten();
    let rate = settings
        .find_one(doc! { "key": "point_value_rate" })
        .await
        .ok()
        .flatten();

    Json(PointsSettingsResponse {
        id: points.as_ref().map(id_from_doc).unwrap_or_default(),
        key: points
            .as_ref()
            .map(|doc| read_string(doc, "key"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "points_per_transaction".to_string()),
        value: points
            .as_ref()
            .and_then(|doc| number_from_bson(doc.get("value")))
            .unwrap_or(100),
        description: points
            .as_ref()
            .map(|doc| read_string(doc, "description"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Points earned per Rp 10,000 transaction".to_string()),
        point_value_rate: rate
            .as_ref()
            .and_then(|doc| number_from_bson(doc.get("value")))
            .unwrap_or(1),
    })
    .into_response()
}

pub async fn points_settings_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PointsSettingsPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
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
    let settings = client
        .database(&state.mongo_db)
        .collection::<Document>("settings");
    if let Some(value) = value {
        if upsert_setting(
            &settings,
            "points_per_transaction",
            value,
            "Points earned per Rp 10,000 transaction",
        )
        .await
        .is_err()
        {
            return internal_error();
        }
    }
    if let Some(point_value_rate) = point_value_rate {
        if upsert_setting(
            &settings,
            "point_value_rate",
            point_value_rate,
            "Value of 1 point in Rupiah",
        )
        .await
        .is_err()
        {
            return internal_error();
        }
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
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let point_transactions = db.collection::<Document>("pointtransactions");
    let users = db.collection::<Document>("users");
    let earned = sum_points(&point_transactions, doc! { "type": "earn" }, false).await;
    let redeemed = sum_points(&point_transactions, doc! { "type": "redeem" }, true).await;
    let active_users = users
        .count_documents(doc! { "points": { "$gt": 0 } })
        .await
        .unwrap_or_default() as i64;
    let total_users = users
        .count_documents(doc! { "role": "member" })
        .await
        .unwrap_or_default() as i64;
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
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(payload.user_id.trim()) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };

    let db = client.database(&state.mongo_db);
    let users = db.collection::<Document>("users");
    let mut filter = doc! { "_id": user_id };
    if payload.points < 0 {
        filter.insert("points", doc! { "$gte": payload.points.abs() });
    }

    let updated_user = users
        .find_one_and_update(
            filter,
            doc! { "$inc": { "points": payload.points }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .await;
    let Ok(Some(user)) = updated_user else {
        let exists = users
            .find_one(doc! { "_id": user_id })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten()
            .is_some();
        return if exists {
            status_message(axum::http::StatusCode::BAD_REQUEST, "Insufficient points")
        } else {
            status_message(axum::http::StatusCode::NOT_FOUND, "User not found")
        };
    };

    let now = DateTime::now();
    let insert_result = db
        .collection::<Document>("pointtransactions")
        .insert_one(doc! {
            "user": user_id,
            "type": "admin_adjustment",
            "points": payload.points,
            "description": payload.description,
            "createdAt": now,
            "updatedAt": now,
        })
        .await;
    if insert_result.is_err() {
        rollback_user_points(&users, user_id, payload.points).await;
        return internal_error();
    }

    Json(PointsAdjustResponse {
        message: "Points adjusted successfully",
        new_points: read_i64(&user, "points"),
    })
    .into_response()
}

pub async fn point_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<PointTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
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
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let mut filter = Document::new();
    if !transaction_type.is_empty() && transaction_type != "all" {
        filter.insert("type", transaction_type);
    }

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("pointtransactions");
    let total = collection
        .count_documents(filter.clone())
        .await
        .unwrap_or_default() as i64;
    let docs = match collection
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .skip(((page - 1) * limit) as u64)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let user_map = user_briefs(&db, &docs).await;
    let reward_map = reward_briefs(&db, &docs).await;
    let total_pages = std::cmp::max(1, (total + limit - 1) / limit);

    Json(PointTransactionsResponse {
        items: docs
            .into_iter()
            .map(|doc| point_transaction_from_doc(doc, &user_map, &reward_map))
            .collect(),
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
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = proxy_context.user_id else {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                message: "Unauthorized",
            }),
        )
            .into_response();
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
    let user_object_id = ObjectId::parse_str(&user_id).ok();
    let user_filter_value = user_object_id
        .map(Bson::ObjectId)
        .unwrap_or_else(|| Bson::String(user_id.clone()));
    let mut filter = doc! { "user": user_filter_value };
    if !transaction_type.is_empty() && transaction_type != "all" {
        filter.insert("type", transaction_type);
    }

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("pointtransactions");
    let total = collection
        .count_documents(filter.clone())
        .await
        .unwrap_or_default() as i64;
    let docs = match collection
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .skip(((page - 1) * limit) as u64)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    let reward_map = reward_briefs(&db, &docs).await;
    let transaction_map = transaction_briefs(&db, &docs).await;
    let current_points = user_points(&db, user_object_id, &user_id).await;
    let point_value_rate = setting_value(&db, "point_value_rate", 1).await.max(1);
    let points_per_transaction = setting_value(&db, "points_per_transaction", 100)
        .await
        .max(1);
    let earned_filter = doc! { "user": user_object_id.map(Bson::ObjectId).unwrap_or_else(|| Bson::String(user_id.clone())), "type": "earn" };
    let redeemed_filter = doc! { "user": user_object_id.map(Bson::ObjectId).unwrap_or_else(|| Bson::String(user_id.clone())), "type": "redeem" };
    let total_earned = sum_points(&collection, earned_filter, false).await;
    let total_redeemed = sum_points(&collection, redeemed_filter, true).await;
    let total_pages = std::cmp::max(1, (total + limit - 1) / limit);
    let items = docs
        .into_iter()
        .map(|doc| points_history_item_from_doc(doc, &reward_map, &transaction_map))
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
