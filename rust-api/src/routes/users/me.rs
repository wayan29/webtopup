use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, Json};
use crate::state::AppState;

use super::{
    mappers::{my_profile_from_sql, preferences_from_sql},
    responses::{internal_error, not_found, status_message},
    types::{
        ChangeMyPasswordPayload, LoginActivityItem, LoginActivityResponse, MyPreferencesResponse, MyProfileResponse,
        UpdateMyPreferencesPayload, UpdateMyPreferencesResponse, UpdateMyProfilePayload, UpdateMyProfileResponse,
    },
    validation::COMMON_PASSWORDS,
    validation::{
        is_valid_email, is_valid_phone, is_valid_ui_theme, normalize_email, normalize_phone,
    },
};

pub async fn me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    if user.role != "member" {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya member yang dapat mengakses data ini",
        );
    }
    if !user.active {
        return status_message(axum::http::StatusCode::FORBIDDEN, "Akun tidak aktif");
    }
    Json(MyProfileResponse {
        profile: my_profile_from_sql(&user),
    })
    .into_response()
}

pub async fn update_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateMyProfilePayload>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    if user.role != "member" {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya member yang dapat mengakses data ini",
        );
    }
    if !user.active {
        return status_message(axum::http::StatusCode::FORBIDDEN, "Akun tidak aktif");
    }

    let name = match payload.name {
        Some(value) => {
            let value = value.trim().to_string();
            if !(2..=80).contains(&value.len()) {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Nama harus 2-80 karakter",
                );
            }
            Some(value)
        }
        None => None,
    };
    let email = match payload.email {
        Some(value) => {
            let value = normalize_email(&value);
            if !is_valid_email(&value) {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Format email tidak valid",
                );
            }
            Some(value)
        }
        None => None,
    };
    let phone = match payload.phone {
        Some(value) => {
            let value = normalize_phone(&value);
            if !value.is_empty() && !is_valid_phone(&value) {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Nomor telepon harus 8-20 digit",
                );
            }
            Some(value)
        }
        None => None,
    };
    let address = match payload.address {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > 200 {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Alamat maksimal 200 karakter",
                );
            }
            Some(value)
        }
        None => None,
    };
    if name.is_none() && email.is_none() && phone.is_none() && address.is_none() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tidak ada perubahan yang bisa disimpan",
        );
    }

    let updated = sqlx::query_as::<_, crate::sql_auth::User>(
        "UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone), address=COALESCE($4,address), updated_at=now() WHERE id=$5 AND role='member' AND active=TRUE RETURNING *",
    )
    .bind(name)
    .bind(email)
    .bind(phone)
    .bind(address)
    .bind(user.id)
    .fetch_optional(&state.pg_pool)
    .await;
    let updated = match updated {
        Ok(Some(user)) => user,
        Ok(None) => return not_found("User member tidak ditemukan"),
        Err(error)
            if error
                .as_database_error()
                .and_then(|database_error| database_error.code())
                .as_deref()
                == Some("23505") =>
        {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Email sudah dipakai akun lain",
            );
        }
        Err(_) => return internal_error(),
    };
    Json(UpdateMyProfileResponse {
        message: "Profil berhasil diperbarui",
        profile: my_profile_from_sql(&updated),
    })
    .into_response()
}

pub async fn change_me_password(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChangeMyPasswordPayload>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) if user.role == "member" => user,
        Ok(_) => return status_message(axum::http::StatusCode::FORBIDDEN, "Hanya member yang dapat mengakses data ini"),
        Err(error) => return error.into_response(),
    };
    let current_password = payload.current_password.unwrap_or_default();
    let new_password = payload.new_password.unwrap_or_default();
    let confirm_password = payload.confirm_password.unwrap_or_default();
    if current_password.is_empty() || new_password.is_empty() || confirm_password.is_empty() {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Semua field password wajib diisi");
    }
    if !user.active { return status_message(axum::http::StatusCode::FORBIDDEN, "Akun tidak aktif"); }
    if user.password_hash.is_empty() { return status_message(axum::http::StatusCode::BAD_REQUEST, "Akun ini belum memiliki password lokal"); }
    if !crate::sql_auth::verify_password(current_password.clone(), user.password_hash.clone()).await { return status_message(axum::http::StatusCode::BAD_REQUEST, "Password saat ini tidak sesuai"); }
    if new_password.len() < 12 { return status_message(axum::http::StatusCode::BAD_REQUEST, "Password baru minimal 12 karakter"); }
    if COMMON_PASSWORDS.contains(&new_password.to_lowercase().as_str()) { return status_message(axum::http::StatusCode::BAD_REQUEST, "Password baru terlalu umum"); }
    if new_password != confirm_password { return status_message(axum::http::StatusCode::BAD_REQUEST, "Konfirmasi password baru tidak cocok"); }
    if new_password == current_password { return status_message(axum::http::StatusCode::BAD_REQUEST, "Password baru harus berbeda dari password saat ini"); }
    let hashed = match crate::sql_auth::hash_password(new_password).await {
        Ok(hash) => hash,
        Err(error) => return error.into_response(),
    };
    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("UPDATE users SET password_hash=$1,updated_at=now(),session_version=session_version+1,security_generation=security_generation+1 WHERE id=$2 AND role='member'")
        .bind(hashed).bind(user.id).execute(&mut *tx).await.is_err() { return internal_error(); }
    if sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=false WHERE user_id=$1 AND state IN ('active','locked')")
        .bind(user.id).execute(&mut *tx).await.is_err() { return internal_error(); }
    if tx.commit().await.is_err() { return internal_error(); }
    Json(serde_json::json!({ "message": "Password berhasil diubah" })).into_response()

}

pub async fn me_login_activity(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) if user.role == "member" => user,
        Ok(_) => return status_message(axum::http::StatusCode::FORBIDDEN, "Hanya member yang dapat mengakses data ini"),
        Err(error) => return error.into_response(),
    };
    let rows = match sqlx::query("SELECT id,created_at,payload FROM audit_events WHERE actor=$1 AND action='login_success' ORDER BY created_at DESC,id DESC LIMIT 10")
        .bind(user.id.to_string()).fetch_all(&state.pg_pool).await {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    use sqlx::Row;
    let items = rows.into_iter().map(|row| {
        use sqlx::Row;
        LoginActivityItem { id: row.get::<i64,_>("id").to_string(), ip: None, user_agent: None, created_at: row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339() }
    }).collect();
    Json(LoginActivityResponse { items }).into_response()
}

pub async fn me_preferences(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    Json(MyPreferencesResponse {
        preferences: preferences_from_sql(&user.preferences),
    })
    .into_response()
}

pub async fn update_me_preferences(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateMyPreferencesPayload>,
) -> axum::response::Response {
    let user = match crate::sql_auth::current(&headers, &state).await {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    let mut preferences = user.preferences.clone();
    let mut has_changes = false;
    if let Some(value) = payload.email_notifications {
        preferences["emailNotifications"] = serde_json::json!(value);
        has_changes = true;
    }
    if let Some(value) = payload.sms_notifications {
        preferences["smsNotifications"] = serde_json::json!(value);
        has_changes = true;
    }
    if let Some(value) = payload.show_balance {
        preferences["showBalance"] = serde_json::json!(value);
        has_changes = true;
    }
    if let Some(value) = payload.ui_theme {
        if !is_valid_ui_theme(&value) {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "Tema UI tidak valid");
        }
        preferences["uiTheme"] = serde_json::json!(value);
        has_changes = true;
    }
    if !has_changes {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Tidak ada preferensi yang bisa disimpan");
    }
    if sqlx::query("UPDATE users SET preferences=$1,updated_at=now() WHERE id=$2")
        .bind(&preferences)
        .bind(user.id)
        .execute(&state.pg_pool)
        .await
        .is_err()
    {
        return status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    }
    Json(UpdateMyPreferencesResponse {
        message: "Preferensi berhasil diperbarui",
        preferences: preferences_from_sql(&preferences),
    })
    .into_response()
}
