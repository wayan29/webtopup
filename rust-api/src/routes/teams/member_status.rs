use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, require_proxy_context},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    audit::write_team_audit_log,
    mappers::team_member_from_doc,
    queries::team_member_lookup,
    responses::{internal_error, status_message, unavailable},
    session::actor_scope,
    validation::{ensure_manage_scope, parse_team_member_id},
};

pub async fn toggle_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    set_member_active(headers, state, id, None).await
}

pub async fn archive_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    set_member_active(headers, state, id, Some(false)).await
}

async fn set_member_active(
    headers: axum::http::HeaderMap,
    state: Arc<AppState>,
    id: String,
    forced_active: Option<bool>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "team.manage_privileged") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let actor_scope = match actor_scope(&db, &context).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    if id == actor_scope.id.to_hex() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            if forced_active.is_some() {
                "Akun sendiri tidak dapat diarsipkan dari halaman ini"
            } else {
                "Akun sendiri tidak dapat diaktifkan atau dinonaktifkan dari halaman ini"
            },
        );
    }
    let member_id = match parse_team_member_id(&id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let users = db.collection::<Document>("users");
    let user = match users
        .find_one(doc! { "_id": member_id, "role": { "$in": ["admin", "cs"] } })
        .await
    {
        Ok(Some(user)) => user,
        Ok(None) => {
            return status_message(
                axum::http::StatusCode::NOT_FOUND,
                "Anggota tim tidak ditemukan",
            )
        }
        Err(_) => return internal_error(),
    };
    if let Err(response) = ensure_manage_scope(&actor_scope.role, &read_string(&user, "role")) {
        return response;
    }
    let next_active = forced_active.unwrap_or(!user.get_bool("active").unwrap_or(true));
    let mut update = doc! { "active": next_active, "updatedAt": DateTime::now() };
    if !next_active {
        update.insert("sessionVersion", read_i64(&user, "sessionVersion") + 1);
    }
    if users
        .update_one(doc! { "_id": member_id }, doc! { "$set": update })
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(member) = team_member_lookup(&db, member_id).await else {
        return internal_error();
    };
    let (action, summary, message) = if forced_active.is_some() {
        (
            "archive",
            "Mengarsipkan akun tim tanpa menghapus histori audit",
            "Anggota tim diarsipkan dan dinonaktifkan",
        )
    } else if next_active {
        (
            "activate",
            "Mengaktifkan kembali akun tim",
            "Akun tim berhasil diaktifkan",
        )
    } else {
        (
            "deactivate",
            "Menonaktifkan akun tim",
            "Akun tim berhasil dinonaktifkan",
        )
    };
    write_team_audit_log(
        &db,
        &actor_scope,
        &member,
        action,
        summary.to_string(),
        None,
    )
    .await;

    if forced_active.is_some() {
        Json(serde_json::json!({ "message": message })).into_response()
    } else {
        Json(serde_json::json!({
            "message": message,
            "user": team_member_from_doc(member),
        }))
        .into_response()
    }
}
