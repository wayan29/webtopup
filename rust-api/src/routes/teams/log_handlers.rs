use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{
    security::{require_permission, require_proxy_context},
    state::AppState,
    utils::bson::read_string,
};

use super::{
    logs::{login_logs_response, parse_positive_i64},
    mappers::team_audit_log_from_doc,
    responses::{status_message, unavailable},
    session::actor_scope,
    types::TeamAuditLogsResponse,
};

pub async fn audit_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let page = parse_positive_i64(query.get("page"), 1, i64::MAX);
    let limit = parse_positive_i64(query.get("limit"), 10, 50);
    let skip = u64::try_from((page - 1) * limit).unwrap_or(0);
    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("teamauditlogs");
    let docs = match collection
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let total_logs = collection.count_documents(doc! {}).await.unwrap_or(0) as i64;
    Json(TeamAuditLogsResponse {
        logs: docs.into_iter().map(team_audit_log_from_doc).collect(),
        current_page: page,
        total_pages: std::cmp::max(1, ((total_logs as f64) / (limit as f64)).ceil() as i64),
        total_logs,
        page_size: limit,
    })
    .into_response()
}

pub async fn login_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let actor_scope = match actor_scope(&db, &context).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    let Ok(member_id) = ObjectId::parse_str(&id) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID anggota tim tidak valid",
        );
    };
    let member = match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": member_id, "role": { "$in": ["admin", "cs"] } })
        .await
    {
        Ok(Some(member)) => member,
        _ => {
            return status_message(
                axum::http::StatusCode::NOT_FOUND,
                "Anggota tim tidak ditemukan",
            )
        }
    };
    if !actor_scope.is_owner && read_string(&member, "role") != "cs" {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya owner yang dapat melihat log login admin",
        );
    }

    login_logs_response(
        &db,
        doc! { "user": member_id },
        &query,
        Some(if actor_scope.is_owner {
            "owner".to_string()
        } else {
            actor_scope.role
        }),
    )
    .await
}

pub async fn all_login_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let actor_scope = match actor_scope(&db, &context).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    let role_filter = if actor_scope.is_owner {
        doc! { "role": { "$in": ["owner", "admin", "cs"] } }
    } else {
        doc! { "role": "cs" }
    };
    let member_ids = match db
        .collection::<Document>("users")
        .find(role_filter)
        .projection(doc! { "_id": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| doc.get_object_id("_id").ok())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    login_logs_response(&db, doc! { "user": { "$in": member_ids } }, &query, None).await
}
