use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, Json};
use bcrypt::{hash, verify, DEFAULT_COST};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, DateTime, Document};

use crate::{security::require_member_user, state::AppState, utils::bson::read_string};

use super::{
    mappers::{
        login_activity_from_doc, my_profile_from_doc, preferences_doc_from_doc,
        preferences_from_doc,
    },
    responses::{internal_error, not_found, status_message, unavailable},
    session::{current_authenticated_user, current_member_user},
    types::{
        ChangeMyPasswordPayload, LoginActivityResponse, MyPreferencesResponse, MyProfileResponse,
        UpdateMyPreferencesPayload, UpdateMyPreferencesResponse, UpdateMyProfilePayload,
        UpdateMyProfileResponse,
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
    let user = match current_member_user(headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    Json(MyProfileResponse {
        profile: my_profile_from_doc(&user),
    })
    .into_response()
}

pub async fn update_me_profile(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateMyProfilePayload>,
) -> axum::response::Response {
    let user = match current_member_user(headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = user.get_object_id("_id") else {
        return not_found("User member tidak ditemukan");
    };
    let db = client.database(&state.mongo_db);
    let users = db.collection::<Document>("users");
    let mut set_doc = Document::new();
    let mut unset_doc = Document::new();

    if let Some(value) = payload.name {
        let name = value.trim().to_string();
        if name.len() < 2 || name.len() > 80 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nama harus 2-80 karakter",
            );
        }
        set_doc.insert("name", name);
    }

    if let Some(value) = payload.email {
        let email = normalize_email(&value);
        if !is_valid_email(&email) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Format email tidak valid",
            );
        }
        let existing = users
            .find_one(doc! { "email": &email, "_id": { "$ne": user_id } })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten();
        if existing.is_some() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Email sudah dipakai akun lain",
            );
        }
        set_doc.insert("email", email);
    }

    if let Some(value) = payload.phone {
        let phone = normalize_phone(&value);
        if !phone.is_empty() && !is_valid_phone(&phone) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nomor telepon harus 8-20 digit",
            );
        }
        if phone.is_empty() {
            unset_doc.insert("phone", "");
        } else {
            set_doc.insert("phone", phone);
        }
    }

    if let Some(value) = payload.address {
        let address = value.trim().to_string();
        if address.len() > 200 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Alamat maksimal 200 karakter",
            );
        }
        if address.is_empty() {
            unset_doc.insert("address", "");
        } else {
            set_doc.insert("address", address);
        }
    }

    if set_doc.is_empty() && unset_doc.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tidak ada perubahan yang bisa disimpan",
        );
    }

    set_doc.insert("updatedAt", DateTime::now());
    let mut update = doc! { "$set": set_doc };
    if !unset_doc.is_empty() {
        update.insert("$unset", unset_doc);
    }
    if users
        .update_one(doc! { "_id": user_id }, update)
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    let updated_user = users
        .find_one(doc! { "_id": user_id, "role": "member" })
        .projection(doc! {
            "name": 1,
            "email": 1,
            "phone": 1,
            "address": 1,
            "role": 1,
            "level": 1,
            "balance": 1,
            "points": 1,
            "active": 1,
            "createdAt": 1,
            "updatedAt": 1,
            "preferences": 1,
        })
        .await
        .ok()
        .flatten();
    let Some(updated_user) = updated_user else {
        return not_found("User member tidak ditemukan");
    };

    Json(UpdateMyProfileResponse {
        message: "Profil berhasil diperbarui",
        profile: my_profile_from_doc(&updated_user),
    })
    .into_response()
}

pub async fn change_me_password(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChangeMyPasswordPayload>,
) -> axum::response::Response {
    let proxy_user = match require_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let user_id = proxy_user.id;
    let current_password = payload.current_password.unwrap_or_default();
    let new_password = payload.new_password.unwrap_or_default();
    let confirm_password = payload.confirm_password.unwrap_or_default();
    if current_password.is_empty() || new_password.is_empty() || confirm_password.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Semua field password wajib diisi",
        );
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let object_id = user_id;
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let user = match users
        .find_one(doc! { "_id": object_id, "role": "member" })
        .projection(doc! { "password": 1, "active": 1 })
        .await
    {
        Ok(Some(user)) => user,
        _ => return not_found("User member tidak ditemukan"),
    };
    if user.get_bool("active") == Ok(false) {
        return status_message(axum::http::StatusCode::FORBIDDEN, "Akun tidak aktif");
    }
    let password_hash = read_string(&user, "password");
    if password_hash.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Akun ini belum memiliki password lokal",
        );
    }
    if !verify(&current_password, &password_hash).unwrap_or(false) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Password saat ini tidak sesuai",
        );
    }
    if new_password.len() < 12 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Password baru minimal 12 karakter",
        );
    }
    if COMMON_PASSWORDS.contains(&new_password.to_lowercase().as_str()) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Password baru terlalu umum digunakan",
        );
    }
    if new_password != confirm_password {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Konfirmasi password baru tidak cocok",
        );
    }
    if new_password == current_password {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Password baru harus berbeda dari password saat ini",
        );
    }
    let hashed = match hash(new_password, DEFAULT_COST) {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    if users
        .update_one(
            doc! { "_id": object_id },
            doc! { "$set": { "password": hashed, "updatedAt": DateTime::now() }, "$inc": { "sessionVersion": 1 } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(serde_json::json!({ "message": "Password berhasil diubah" })).into_response()
}

pub async fn me_login_activity(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user = match current_member_user(headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = user.get_object_id("_id") else {
        return not_found("User member tidak ditemukan");
    };
    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("loginlogs")
        .find(doc! { "user": user_id, "status": "success" })
        .projection(doc! { "_id": 1, "ip": 1, "userAgent": 1, "createdAt": 1 })
        .sort(doc! { "createdAt": -1 })
        .limit(10)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Json(LoginActivityResponse {
        items: docs.into_iter().map(login_activity_from_doc).collect(),
    })
    .into_response()
}

pub async fn me_preferences(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user = match current_authenticated_user(headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    Json(MyPreferencesResponse {
        preferences: preferences_from_doc(user.get_document("preferences").ok()),
    })
    .into_response()
}

pub async fn update_me_preferences(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateMyPreferencesPayload>,
) -> axum::response::Response {
    let user = match current_authenticated_user(headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = user.get_object_id("_id") else {
        return not_found("User tidak ditemukan");
    };
    let mut next_preferences = preferences_doc_from_doc(user.get_document("preferences").ok());
    let mut has_changes = false;

    if let Some(value) = payload.email_notifications {
        next_preferences.insert("emailNotifications", value);
        has_changes = true;
    }

    if let Some(value) = payload.sms_notifications {
        next_preferences.insert("smsNotifications", value);
        has_changes = true;
    }

    if let Some(value) = payload.show_balance {
        next_preferences.insert("showBalance", value);
        has_changes = true;
    }

    if let Some(value) = payload.ui_theme {
        if !is_valid_ui_theme(&value) {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "Tema UI tidak valid");
        }
        next_preferences.insert("uiTheme", value);
        has_changes = true;
    }

    if !has_changes {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tidak ada preferensi yang bisa disimpan",
        );
    }

    let update_result = client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .update_one(
            doc! { "_id": user_id },
            doc! { "$set": { "preferences": next_preferences.clone() } },
        )
        .await;

    if update_result.is_err() {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    Json(UpdateMyPreferencesResponse {
        message: "Preferensi berhasil diperbarui",
        preferences: preferences_from_doc(Some(&next_preferences)),
    })
    .into_response()
}
