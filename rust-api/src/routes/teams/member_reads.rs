use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId};

use crate::{security::require_permission, state::AppState};

use super::{
    mappers::team_member_from_doc,
    queries::{aggregate_documents, team_member_read_pipeline, update_summary},
    responses::{status_message, unavailable},
    types::{TeamListResponse, TeamMemberResponse, TeamSummary},
    validation::build_team_filter,
};

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTeam").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let filter = build_team_filter(&query);
    let docs = aggregate_documents(&db, "users", team_member_read_pipeline(filter, true)).await;
    let mut summary = TeamSummary::default();
    let members = docs
        .into_iter()
        .map(|document| {
            update_summary(&mut summary, &document);
            team_member_from_doc(document)
        })
        .collect::<Vec<_>>();
    Json(TeamListResponse { members, summary }).into_response()
}

pub async fn admin_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTeam").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(member_id) = ObjectId::parse_str(&id) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID anggota tim tidak valid",
        );
    };

    let db = client.database(&state.mongo_db);
    let docs = aggregate_documents(
        &db,
        "users",
        team_member_read_pipeline(
            doc! { "_id": member_id, "role": { "$in": ["admin", "cs"] } },
            false,
        ),
    )
    .await;

    let Some(member) = docs.into_iter().next() else {
        return status_message(
            axum::http::StatusCode::NOT_FOUND,
            "Anggota tim tidak ditemukan",
        );
    };

    Json(TeamMemberResponse {
        member: team_member_from_doc(member),
    })
    .into_response()
}
