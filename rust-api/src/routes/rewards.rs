use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{
    security::{require_permission, ErrorResponse},
    services::managed_assets::{
        abort_legacy_managed_write, commit_legacy_managed_write, effectively_changed_cover_path,
        fence_legacy_managed_writes, managed_asset_registry_unavailable_response,
        start_legacy_managed_write,
    },
    state::AppState,
};

mod mappers;
mod points;
mod points_helpers;
mod types;
mod validation;
use mappers::*;
pub use points::{
    point_transactions, points_adjust, points_history, points_settings, points_settings_update,
    points_stats,
};
pub use types::RewardPayload;
use types::*;
use validation::*;

pub async fn rewards_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("rewards")
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(docs.into_iter().map(reward_from_doc).collect::<Vec<_>>()).into_response()
}

pub async fn rewards_public(State(state): State<Arc<AppState>>) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("rewards")
        .find(doc! { "status": true })
        .sort(doc! { "pointsRequired": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(docs.into_iter().map(reward_from_doc).collect::<Vec<_>>()).into_response()
}

pub async fn reward_public_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return reward_not_found();
    };

    match client
        .database(&state.mongo_db)
        .collection::<Document>("rewards")
        .find_one(doc! { "_id": object_id, "status": true })
        .await
        .ok()
        .flatten()
    {
        Some(document) => Json(reward_from_doc(document)).into_response(),
        None => reward_not_found(),
    }
}

pub async fn reward_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RewardPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let normalized = match normalize_reward_payload(payload, None) {
        Ok(normalized) => normalized,
        Err(response) => return response,
    };
    let now = DateTime::now();
    let image_url = normalized.image_url.clone();
    let rewards = client
        .database(&state.mongo_db)
        .collection::<Document>("rewards");
    let document = doc! {
        "name": normalized.name,
        "description": normalized.description,
        "pointsRequired": normalized.points_required,
        "stock": normalized.stock,
        "imageUrl": &image_url,
        "category": normalized.category,
        "status": normalized.status,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    let insert_result = if let Some(path) = effectively_changed_cover_path(None, &image_url) {
        if !state.mongo_transactions_enabled {
            return managed_asset_registry_unavailable_response();
        }
        let mut session = match start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return managed_asset_registry_unavailable_response(),
        };
        if fence_legacy_managed_writes(&mut session, &client.database(&state.mongo_db), &[path]).await.is_err() {
            let _ = abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            ).await;
            return managed_asset_registry_unavailable_response();
        }
        let result = match rewards.insert_one(document).session(&mut session).await {
            Ok(result) => result,
            Err(_) => {
                let _ = session.abort_transaction().await;
                return internal_error();
            }
        };
        if commit_legacy_managed_write(&mut session).await.is_err() {
            return managed_asset_registry_unavailable_response();
        }
        result
    } else {
        match rewards.insert_one(document).await {
            Ok(result) => result,
            Err(_) => return internal_error(),
        }
    };
    let Some(id) = insert_result.inserted_id.as_object_id() else {
        return internal_error();
    };
    let Some(reward) = rewards.find_one(doc! { "_id": id }).await.ok().flatten() else {
        return reward_not_found();
    };
    (
        axum::http::StatusCode::CREATED,
        Json(RewardResponse {
            message: "Reward created successfully",
            reward: reward_from_doc(reward),
        }),
    )
        .into_response()
}

pub async fn reward_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<RewardPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return reward_not_found();
    };
    let rewards = client
        .database(&state.mongo_db)
        .collection::<Document>("rewards");
    let Some(current) = rewards
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return reward_not_found();
    };
    let normalized = match normalize_reward_payload(payload, Some(&current)) {
        Ok(normalized) => normalized,
        Err(response) => return response,
    };
    let previous_image = crate::utils::bson::read_string(&current, "imageUrl");
    let next_image = normalized.image_url.clone();
    let image_path = effectively_changed_cover_path(Some(&previous_image), &next_image);
    let update_doc = doc! { "$set": {
        "name": normalized.name,
        "description": normalized.description,
        "pointsRequired": normalized.points_required,
        "stock": normalized.stock,
        "imageUrl": &next_image,
        "category": normalized.category,
        "status": normalized.status,
        "updatedAt": DateTime::now(),
    } };
    if let Some(path) = image_path {
        if !state.mongo_transactions_enabled {
            return managed_asset_registry_unavailable_response();
        }
        let mut session = match start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return managed_asset_registry_unavailable_response(),
        };
        if fence_legacy_managed_writes(&mut session, &client.database(&state.mongo_db), &[path]).await.is_err() {
            let _ = abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            ).await;
            return managed_asset_registry_unavailable_response();
        }
        if rewards.update_one(doc! { "_id": object_id }, update_doc).session(&mut session).await.is_err() {
            let _ = session.abort_transaction().await;
            return internal_error();
        }
        if commit_legacy_managed_write(&mut session).await.is_err() {
            return managed_asset_registry_unavailable_response();
        }
    } else if rewards.update_one(doc! { "_id": object_id }, update_doc).await.is_err() {
        return internal_error();
    }
    let Some(reward) = rewards
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return reward_not_found();
    };
    Json(RewardResponse {
        message: "Reward updated successfully",
        reward: reward_from_doc(reward),
    })
    .into_response()
}

pub async fn reward_delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return reward_not_found();
    };
    let db = client.database(&state.mongo_db);
    let rewards = db.collection::<Document>("rewards");
    let Some(_) = rewards
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return reward_not_found();
    };
    let has_redemption_history = db
        .collection::<Document>("pointtransactions")
        .find_one(doc! { "relatedReward": object_id, "type": "redeem" })
        .await
        .ok()
        .flatten()
        .is_some();
    if has_redemption_history {
        if rewards
            .update_one(
                doc! { "_id": object_id },
                doc! { "$set": { "status": false, "stock": 0, "updatedAt": DateTime::now() } },
            )
            .await
            .is_err()
        {
            return internal_error();
        }
        return Json(RewardDeleteResponse {
            message: "Reward has redemption history and was archived instead of deleted",
            archived: Some(true),
        })
        .into_response();
    }
    if rewards.delete_one(doc! { "_id": object_id }).await.is_err() {
        return internal_error();
    }
    Json(RewardDeleteResponse {
        message: "Reward deleted successfully",
        archived: None,
    })
    .into_response()
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

fn reward_not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            message: "Reward not found",
        }),
    )
        .into_response()
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
