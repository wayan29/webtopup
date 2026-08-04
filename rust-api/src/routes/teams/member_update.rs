use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use bcrypt::{hash, DEFAULT_COST};
use mongodb::bson::{doc, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, require_proxy_context},
    state::AppState,
    utils::bson::read_string,
};

use super::{
    audit::write_team_audit_log,
    mappers::{permissions_json, team_member_from_doc},
    queries::team_member_lookup,
    responses::{internal_error, is_duplicate_key, status_message, unavailable},
    session::actor_scope,
    types::TeamMemberPayload,
    validation::{
        build_permissions, build_update_summary, clamp_permissions_to_actor,
        ensure_assignable_role, ensure_manage_scope, is_valid_email, normalize_email,
        normalize_name, parse_team_member_id,
    },
};

pub async fn update_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<TeamMemberPayload>,
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

    let previous_permissions = user
        .get_document("permissions")
        .ok()
        .cloned()
        .unwrap_or_default();
    let previous_snapshot = serde_json::json!({
        "name": read_string(&user, "name"),
        "email": read_string(&user, "email"),
        "role": read_string(&user, "role"),
        "active": user.get_bool("active").unwrap_or(true),
        "permissions": permissions_json(Some(&previous_permissions)),
    });
    let mut changes: Vec<&'static str> = Vec::new();
    let mut update = Document::new();

    if let Some(name) = payload.name {
        let normalized_name = normalize_name(&name);
        if normalized_name.len() < 2 || normalized_name.len() > 80 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nama anggota tim harus 2-80 karakter",
            );
        }
        if normalized_name != read_string(&user, "name") {
            update.insert("name", normalized_name);
            changes.push("nama");
        }
    }

    if let Some(email) = payload.email {
        let normalized_email = normalize_email(&email);
        if !is_valid_email(&normalized_email) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Format email tidak valid",
            );
        }
        if users
            .find_one(doc! { "email": &normalized_email, "_id": { "$ne": member_id } })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Email sudah dipakai akun lain",
            );
        }
        if normalized_email != read_string(&user, "email") {
            update.insert("email", normalized_email);
            changes.push("email");
        }
    }

    let previous_role = read_string(&user, "role");
    let mut target_role = previous_role.clone();
    if let Some(role) = payload.role {
        if let Err(response) = ensure_assignable_role(&actor_scope.role, &role) {
            return response;
        }
        if role != previous_role {
            target_role = role.clone();
            update.insert("role", role);
            // Keep the security-change binding stamp in step with the role it describes.
            update.insert("roleUpdatedAt", DateTime::now());
            changes.push("role");
        }
    }

    if let Some(permissions_value) = payload.permissions.as_ref() {
        let mut permissions = build_permissions(Some(permissions_value), &target_role);
        if !actor_scope.is_owner {
            permissions = clamp_permissions_to_actor(permissions, &actor_scope.permissions);
        }
        update.insert("permissions", permissions);
        changes.push("permission");
    } else if target_role != previous_role {
        let mut permissions = build_permissions(None, &target_role);
        if !actor_scope.is_owner {
            permissions = clamp_permissions_to_actor(permissions, &actor_scope.permissions);
        }
        update.insert("permissions", permissions);
        changes.push("permission default role");
    }

    if let Some(password) = payload.password.filter(|value| !value.is_empty()) {
        if password.len() < 6 || password.len() > 100 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Password minimal 6 karakter",
            );
        }
        let hashed_password = match hash(password, DEFAULT_COST) {
            Ok(value) => value,
            Err(_) => return internal_error(),
        };
        update.insert("password", hashed_password);
        changes.push("password");
    }

    if changes.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tidak ada perubahan yang bisa disimpan",
        );
    }
    update.insert("updatedAt", DateTime::now());
    if let Err(error) = users
        .update_one(doc! { "_id": member_id }, doc! { "$set": update })
        .await
    {
        if is_duplicate_key(&error) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Email sudah dipakai akun lain",
            );
        }
        return internal_error();
    }
    let Some(member) = team_member_lookup(&db, member_id).await else {
        return internal_error();
    };
    write_team_audit_log(
        &db,
        &actor_scope,
        &member,
        "update",
        build_update_summary(&changes),
        Some(serde_json::json!({
            "before": previous_snapshot,
            "after": {
                "name": read_string(&member, "name"),
                "email": read_string(&member, "email"),
                "role": read_string(&member, "role"),
                "active": member.get_bool("active").unwrap_or(true),
                "permissions": permissions_json(member.get_document("permissions").ok()),
            }
        })),
    )
    .await;

    Json(serde_json::json!({
        "message": "Anggota tim berhasil diperbarui",
        "user": team_member_from_doc(member),
    }))
    .into_response()
}
