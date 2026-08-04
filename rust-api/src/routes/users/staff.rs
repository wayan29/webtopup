//! Staff self-service profile and credentials.
//!
//! The `/v2/users/me/*` handlers are gated by `require_member_user`, and they return member
//! shaped data (balance, level, points). Rather than loosen that guard, staff get their own
//! narrow surface here behind `require_team_user`.
//!
//! Role is deliberately not accepted from the caller: privilege changes belong to team
//! management, never to self-service.

use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, Json};
use bcrypt::{hash, verify, DEFAULT_COST};
use mongodb::bson::{doc, DateTime, Document};

use crate::{security::require_team_user, state::AppState, utils::bson::read_string};

use super::{
    responses::{internal_error, not_found, status_message, unavailable},
    types::{ChangeMyPasswordPayload, UpdateStaffProfilePayload},
    validation::{validate_staff_password, validate_staff_profile, StaffCredentialError},
};

/// Roles allowed to use this surface. Kept in sync with `require_team_user`.
const STAFF_ROLES: [&str; 3] = ["owner", "admin", "cs"];

fn bad_request(message: &'static str) -> axum::response::Response {
    status_message(axum::http::StatusCode::BAD_REQUEST, message)
}

fn credential_error_response(error: StaffCredentialError) -> axum::response::Response {
    bad_request(match error {
        StaffCredentialError::NameRequired => "Nama wajib diisi",
        StaffCredentialError::EmailRequired => "Email wajib diisi",
        StaffCredentialError::EmailInvalid => "Format email tidak valid",
        StaffCredentialError::PasswordFieldsRequired => "Semua field password wajib diisi",
        StaffCredentialError::PasswordTooShort => "Password baru minimal 12 karakter",
        StaffCredentialError::PasswordTooCommon => "Password baru terlalu umum digunakan",
        StaffCredentialError::PasswordMismatch => "Konfirmasi password baru tidak cocok",
        StaffCredentialError::PasswordUnchanged => {
            "Password baru harus berbeda dari password saat ini"
        }
    })
}

fn staff_profile_json(doc: &Document) -> serde_json::Value {
    serde_json::json!({
        "id": doc.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default(),
        "name": read_string(doc, "name"),
        "email": read_string(doc, "email"),
        "avatarUrl": read_string(doc, "avatarUrl"),
        "role": read_string(doc, "role"),
        "twoFactorEnabled": doc.get_bool("twoFactorEnabled").unwrap_or(false),
    })
}

pub async fn staff_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let staff = match require_team_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    match users
        .find_one(doc! { "_id": staff.id, "role": { "$in": STAFF_ROLES.to_vec() } })
        .projection(doc! { "_id": 1, "name": 1, "email": 1, "role": 1, "twoFactorEnabled": 1, "avatarUrl": 1 })
        .await
    {
        Ok(Some(doc)) => Json(serde_json::json!({ "profile": staff_profile_json(&doc) })).into_response(),
        Ok(None) => not_found("Akun staff tidak ditemukan"),
        Err(_) => internal_error(),
    }
}

pub async fn update_staff_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateStaffProfilePayload>,
) -> axum::response::Response {
    let staff = match require_team_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let (name, email) = match validate_staff_profile(
        &payload.name.unwrap_or_default(),
        &payload.email.unwrap_or_default(),
    ) {
        Ok(values) => values,
        Err(error) => return credential_error_response(error),
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");

    // Email is a login identifier, so a collision would lock somebody out of their account.
    match users
        .find_one(doc! { "email": &email, "_id": { "$ne": staff.id } })
        .projection(doc! { "_id": 1 })
        .await
    {
        Ok(Some(_)) => return bad_request("Email sudah digunakan akun lain"),
        Ok(None) => {}
        Err(_) => return internal_error(),
    }

    if users
        .update_one(
            doc! { "_id": staff.id, "role": { "$in": STAFF_ROLES.to_vec() } },
            doc! { "$set": { "name": &name, "email": &email, "updatedAt": DateTime::now() } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }

    match users
        .find_one(doc! { "_id": staff.id })
        .projection(doc! { "_id": 1, "name": 1, "email": 1, "role": 1, "twoFactorEnabled": 1, "avatarUrl": 1 })
        .await
    {
        Ok(Some(doc)) => Json(serde_json::json!({
            "message": "Profil berhasil diperbarui",
            "profile": staff_profile_json(&doc),
        }))
        .into_response(),
        Ok(None) => not_found("Akun staff tidak ditemukan"),
        Err(_) => internal_error(),
    }
}

pub async fn change_staff_me_password(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChangeMyPasswordPayload>,
) -> axum::response::Response {
    let staff = match require_team_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let current_password = payload.current_password.clone().unwrap_or_default();
    let new_password = payload.new_password.clone().unwrap_or_default();
    let confirm_password = payload.confirm_password.clone().unwrap_or_default();
    if let Err(error) = validate_staff_password(&current_password, &new_password, &confirm_password)
    {
        return credential_error_response(error);
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let user = match users
        .find_one(doc! { "_id": staff.id, "role": { "$in": STAFF_ROLES.to_vec() } })
        .projection(doc! { "password": 1, "active": 1 })
        .await
    {
        Ok(Some(user)) => user,
        Ok(None) => return not_found("Akun staff tidak ditemukan"),
        Err(_) => return internal_error(),
    };
    if user.get_bool("active") == Ok(false) {
        return status_message(axum::http::StatusCode::FORBIDDEN, "Akun tidak aktif");
    }
    let password_hash = read_string(&user, "password");
    if password_hash.is_empty() {
        return bad_request("Akun ini belum memiliki password lokal");
    }
    if !verify(&current_password, &password_hash).unwrap_or(false) {
        return bad_request("Password saat ini tidak sesuai");
    }
    let hashed = match hash(&new_password, DEFAULT_COST) {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    // Bumping sessionVersion revokes every other session, which is the point: a password
    // change should evict whoever might already be holding the old one.
    if users
        .update_one(
            doc! { "_id": staff.id },
            doc! {
                "$set": { "password": hashed, "updatedAt": DateTime::now() },
                "$inc": { "sessionVersion": 1 },
            },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(serde_json::json!({
        "message": "Password berhasil diubah. Semua sesi telah dicabut."
    }))
    .into_response()
}
