use std::sync::Arc;

mod responses;
mod serialization;
mod types;
mod validation;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::{
    security::require_permission,
    services::managed_assets::{
        abort_legacy_managed_write, commit_legacy_managed_write, fence_legacy_managed_writes,
        effectively_changed_cover_path, managed_asset_registry_unavailable_response,
        start_legacy_managed_write,
    },
    state::AppState,
};

use responses::{internal_error, status_message, unavailable};
use serialization::{document_to_json, serialize_public_article};
use types::ArticlePayload;
use validation::build_article_payload;

pub async fn public_list(State(state): State<Arc<AppState>>) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("articles")
        .find(doc! { "status": "published" })
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(
        docs.into_iter()
            .map(serialize_public_article)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn public_detail(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match client
        .database(&state.mongo_db)
        .collection::<Document>("articles")
        .find_one(doc! { "slug": slug, "status": "published" })
        .await
    {
        Ok(Some(document)) => Json(serialize_public_article(document)).into_response(),
        Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "Article not found"),
        Err(_) => status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        ),
    }
}

pub async fn create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ArticlePayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let payload = match build_article_payload(payload, None) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let articles = client
        .database(&state.mongo_db)
        .collection::<Document>("articles");
    let existing = articles
        .find_one(doc! { "slug": &payload.slug })
        .await
        .ok()
        .flatten();
    if existing.is_some() {
        return status_message(
            axum::http::StatusCode::CONFLICT,
            "Slug artikel sudah digunakan",
        );
    }
    let now = DateTime::now();
    let image_path = payload.image.clone();
    let mut document = doc! {
        "title": payload.title,
        "slug": payload.slug,
        "excerpt": payload.excerpt,
        "content": payload.content,
        "category": payload.category,
        "status": payload.status,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if !payload.image.is_empty() {
        document.insert("image", payload.image);
    }
    let insert_result = if let Some(path) = effectively_changed_cover_path(None, &image_path) {
        if !state.mongo_transactions_enabled {
            return managed_asset_registry_unavailable_response();
        }
        let mut session = match start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return managed_asset_registry_unavailable_response(),
        };
        if fence_legacy_managed_writes(&mut session, &client.database(&state.mongo_db), &[path])
            .await
            .is_err()
        {
            let _ = abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            )
            .await;
            return managed_asset_registry_unavailable_response();
        }
        let result = match articles.insert_one(document).session(&mut session).await {
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
        match articles.insert_one(document).await {
            Ok(result) => result,
            Err(_) => return internal_error(),
        }
    };
    let Some(article_id) = insert_result.inserted_id.as_object_id() else {
        return internal_error();
    };
    let article = articles
        .find_one(doc! { "_id": article_id })
        .await
        .ok()
        .flatten();
    match article {
        Some(article) => (
            axum::http::StatusCode::CREATED,
            Json(document_to_json(article)),
        )
            .into_response(),
        None => internal_error(),
    }
}

pub async fn update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ArticlePayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let article_id = match ObjectId::parse_str(id.trim()) {
        Ok(id) => id,
        Err(_) => return internal_error(),
    };
    let articles = client
        .database(&state.mongo_db)
        .collection::<Document>("articles");
    let current = articles
        .find_one(doc! { "_id": article_id })
        .await
        .ok()
        .flatten();
    let Some(current) = current else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Article not found");
    };
    let previous_image = crate::utils::bson::read_string(&current, "image");
    let payload = match build_article_payload(payload, Some(&current)) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let existing = articles
        .find_one(doc! { "slug": &payload.slug, "_id": { "$ne": article_id } })
        .await
        .ok()
        .flatten();
    if existing.is_some() {
        return status_message(
            axum::http::StatusCode::CONFLICT,
            "Slug artikel sudah digunakan",
        );
    }
    let mut set_doc = doc! {
        "title": payload.title,
        "slug": payload.slug,
        "excerpt": payload.excerpt,
        "content": payload.content,
        "category": payload.category,
        "status": payload.status,
        "updatedAt": DateTime::now(),
    };
    let next_image = payload.image.clone();
    if next_image.is_empty() {
        set_doc.insert("image", Bson::Null);
    } else {
        set_doc.insert("image", next_image.clone());
    }
    if let Some(path) = effectively_changed_cover_path(Some(&previous_image), &next_image) {
        if !state.mongo_transactions_enabled {
            return managed_asset_registry_unavailable_response();
        }
        let mut session = match start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return managed_asset_registry_unavailable_response(),
        };
        if fence_legacy_managed_writes(&mut session, &client.database(&state.mongo_db), &[path])
            .await
            .is_err()
        {
            let _ = abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            )
            .await;
            return managed_asset_registry_unavailable_response();
        }
        if articles
            .update_one(doc! { "_id": article_id }, doc! { "$set": set_doc })
            .session(&mut session)
            .await
            .is_err()
        {
            let _ = session.abort_transaction().await;
            return internal_error();
        }
        if commit_legacy_managed_write(&mut session).await.is_err() {
            return managed_asset_registry_unavailable_response();
        }
    } else if articles
        .update_one(doc! { "_id": article_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return internal_error();
    }
    let article = articles
        .find_one(doc! { "_id": article_id })
        .await
        .ok()
        .flatten();
    match article {
        Some(article) => Json(document_to_json(article)).into_response(),
        None => status_message(axum::http::StatusCode::NOT_FOUND, "Article not found"),
    }
}

pub async fn delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let article_id = match ObjectId::parse_str(id.trim()) {
        Ok(id) => id,
        Err(_) => return internal_error(),
    };
    let deleted = client
        .database(&state.mongo_db)
        .collection::<Document>("articles")
        .find_one_and_delete(doc! { "_id": article_id })
        .await
        .ok()
        .flatten();
    if deleted.is_none() {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Article not found");
    }
    Json(serde_json::json!({ "message": "Article deleted" })).into_response()
}
