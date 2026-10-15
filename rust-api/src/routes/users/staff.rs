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

use crate::state::AppState;

use super::{
    responses::{internal_error, not_found, status_message},
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

fn staff_profile_json(user: &crate::sql_auth::User) -> serde_json::Value {
    serde_json::json!({
        "id": user.id.to_string(), "name": user.name, "email": user.email,
        "avatarUrl": user.avatar_url, "role": user.role,
        "twoFactorEnabled": user.two_factor_enabled,
    })
}

pub async fn staff_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let staff = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) if STAFF_ROLES.contains(&user.role.as_str()) => user,
        Ok(_) => return status_message(axum::http::StatusCode::FORBIDDEN, "Forbidden: No access to admin panel"),
        Err(error) => return error.into_response(),
    };
    Json(serde_json::json!({ "profile": staff_profile_json(&staff) })).into_response()
}

pub async fn update_staff_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateStaffProfilePayload>,
) -> axum::response::Response {
    let staff = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) if STAFF_ROLES.contains(&user.role.as_str()) => user,
        Ok(_) => return status_message(axum::http::StatusCode::FORBIDDEN, "Forbidden: No access to admin panel"),
        Err(error) => return error.into_response(),
    };
    let (name,email) = match validate_staff_profile(&payload.name.unwrap_or_default(), &payload.email.unwrap_or_default()) {
        Ok(values) => values,
        Err(error) => return credential_error_response(error),
    };
    let updated = sqlx::query_as::<_,crate::sql_auth::User>("UPDATE users SET name=$1,email=$2,updated_at=now() WHERE id=$3 AND role IN ('owner','admin','cs') RETURNING *")
        .bind(name).bind(email).bind(staff.id).fetch_optional(&state.pg_pool).await;
    let updated = match updated {
        Ok(Some(user)) => user,
        Ok(None) => return not_found("Akun staff tidak ditemukan"),
        Err(error) if error.as_database_error().and_then(|db| db.code()).as_deref()==Some("23505") => return bad_request("Email sudah digunakan akun lain"),
        Err(_) => return internal_error(),
    };
    Json(serde_json::json!({"message":"Profil berhasil diperbarui","profile":staff_profile_json(&updated)})).into_response()
}


pub async fn change_staff_me_password(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChangeMyPasswordPayload>,
) -> axum::response::Response {
    let staff = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) if STAFF_ROLES.contains(&user.role.as_str()) => user,
        Ok(_) => return status_message(axum::http::StatusCode::FORBIDDEN, "Forbidden: No access to admin panel"),
        Err(error) => return error.into_response(),
    };
    let current_password = payload.current_password.unwrap_or_default();
    let new_password = payload.new_password.unwrap_or_default();
    let confirm_password = payload.confirm_password.unwrap_or_default();
    if let Err(error) = validate_staff_password(&current_password,&new_password,&confirm_password) { return credential_error_response(error); }
    if !staff.active { return status_message(axum::http::StatusCode::FORBIDDEN,"Akun tidak aktif"); }
    if staff.password_hash.is_empty() { return bad_request("Akun ini belum memiliki password lokal"); }
    if !crate::sql_auth::verify_password(current_password,staff.password_hash).await { return bad_request("Password saat ini tidak sesuai"); }
    let hashed = match crate::sql_auth::hash_password(new_password).await { Ok(value)=>value,Err(error)=>return error.into_response() };
    let mut tx=match state.pg_pool.begin().await {Ok(tx)=>tx,Err(_)=>return internal_error()};
    if sqlx::query("UPDATE users SET password_hash=$1,updated_at=now(),session_version=session_version+1,security_generation=security_generation+1 WHERE id=$2 AND role IN ('owner','admin','cs')")
        .bind(hashed).bind(staff.id).execute(&mut *tx).await.is_err() { return internal_error(); }
    if sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')")
        .bind(staff.id).execute(&mut *tx).await.is_err() { return internal_error(); }
    if tx.commit().await.is_err() { return internal_error(); }
    Json(serde_json::json!({"message":"Password berhasil diubah. Semua sesi telah dicabut."})).into_response()
}
