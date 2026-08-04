use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use bcrypt::{hash, DEFAULT_COST};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group, security::require_permission,
    security::require_proxy_context, state::AppState,
};

use super::{
    audit::write_team_audit_log,
    mappers::{permissions_json, team_member_from_doc},
    queries::team_member_lookup,
    responses::{internal_error, is_duplicate_key, status_message, unavailable},
    session::actor_scope,
    types::TeamMemberPayload,
    validation::{
        build_permissions, clamp_permissions_to_actor, ensure_assignable_role, is_valid_email,
        normalize_email, normalize_name,
    },
};

pub async fn create_member(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
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
    let name = normalize_name(payload.name.as_deref().unwrap_or_default());
    if name.len() < 2 || name.len() > 80 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama anggota tim harus 2-80 karakter",
        );
    }
    let email = normalize_email(payload.email.as_deref().unwrap_or_default());
    if !is_valid_email(&email) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Format email tidak valid",
        );
    }
    let password = payload.password.unwrap_or_default();
    if password.len() < 6 || password.len() > 100 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Password minimal 6 karakter",
        );
    }
    let role = payload.role.unwrap_or_default();
    if role != "admin" && role != "cs" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Role anggota tim harus admin atau cs",
        );
    }
    if let Err(response) = ensure_assignable_role(&actor_scope.role, &role) {
        return response;
    }

    let users = db.collection::<Document>("users");
    if users
        .find_one(doc! { "email": &email })
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
    let mut permissions = build_permissions(payload.permissions.as_ref(), &role);
    if !actor_scope.is_owner {
        permissions = clamp_permissions_to_actor(permissions, &actor_scope.permissions);
    }
    let hashed_password = match hash(password, DEFAULT_COST) {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let now = DateTime::now();
    let mut user_doc = doc! {
        "name": &name, "email": &email, "password": hashed_password, "role": &role,
        "level": "basic", "balance": 0, "points": 0, "createdBy": actor_scope.id,
        "permissions": permissions.clone(), "active": true, "twoFactorEnabled": false,
        "sessionVersion": 0, "preferences": Document::new(), "createdAt": now, "updatedAt": now, "__v": 0,
        // Authoritative stamps for the deterministic security-change binding. Omitting them
        // makes the binding fall back to updatedAt, which the preparing update rewrites, so
        // the comparison fails against its own mutation and 2FA enrollment dead-ends with
        // AUTH_SECURITY_CHANGE_RECOVERY_UNAVAILABLE. A new staff member could never enroll.
        "roleUpdatedAt": now, "policyUpdatedAt": now,
    };
    let inserted_id = match users.insert_one(user_doc.clone()).await {
        Ok(result) => result.inserted_id.as_object_id().map(|id| id.to_hex()),
        Err(error) => {
            if is_duplicate_key(&error) {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Email sudah dipakai akun lain",
                );
            }
            return internal_error();
        }
    };
    let Some(user_id) = inserted_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    else {
        return internal_error();
    };
    user_doc.insert("_id", user_id);
    user_doc.remove("password");
    write_team_audit_log(
        &db,
        &actor_scope,
        &user_doc,
        "create",
        format!("Membuat akun tim baru dengan role {role}"),
        Some(serde_json::json!({ "permissions": permissions_json(Some(&permissions)) })),
    )
    .await;
    let member = team_member_lookup(&db, user_id).await.unwrap_or(user_doc);

    (axum::http::StatusCode::CREATED, Json(serde_json::json!({ "message": "Anggota tim berhasil dibuat", "user": team_member_from_doc(member) }))).into_response()
}
