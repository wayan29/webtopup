use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::{security::require_permission, state::AppState};

use super::{
    mappers::user_item_from_doc,
    queries::{build_summary, ensure_member_exists, load_member_user_item},
    responses::{internal_error, not_found, status_message, unavailable},
    types::{UserMutationResponse, UserStatusPayload, UsersResponse},
    validation::{
        build_filter, build_sort, is_valid_email, normalize_email, parse_positive_i64,
        MAX_ADMIN_USERS_PAGE,
    },
};

const DEFAULT_PAGE_SIZE: i64 = 10;
const MAX_PAGE_SIZE: i64 = 100;

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "viewUsers").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let page = parse_positive_i64(query.get("page"), 1, MAX_ADMIN_USERS_PAGE);
    let limit = parse_positive_i64(query.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    let skip = u64::try_from((page - 1) * limit).unwrap_or(0);
    let filter = build_filter(&query);
    let sort = build_sort(&query);
    let db = client.database(&state.mongo_db);
    let users_collection = db.collection::<Document>("users");

    let cursor = match users_collection
        .find(filter.clone())
        .projection(super::queries::member_projection())
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor,
        Err(error) => {
            eprintln!("Failed to query admin user list: {error}");
            return internal_error();
        }
    };
    let users = match cursor.try_collect::<Vec<_>>().await {
        Ok(users) => users,
        Err(error) => {
            eprintln!("Failed to collect admin user list: {error}");
            return internal_error();
        }
    };

    let total_users = match users_collection.count_documents(filter).await {
        Ok(total) => total as i64,
        Err(error) => {
            eprintln!("Failed to count admin users: {error}");
            return internal_error();
        }
    };
    let summary = build_summary(&db).await;
    let total_pages = std::cmp::max(1, ((total_users as f64) / (limit as f64)).ceil() as i64);

    Json(UsersResponse {
        users: users.into_iter().map(user_item_from_doc).collect(),
        current_page: page,
        total_pages,
        total_users,
        page_size: limit,
        summary,
    })
    .into_response()
}

pub async fn admin_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "viewUsers").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let user = match client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id, "role": "member" })
        .projection(super::queries::member_projection())
        .await
    {
        Ok(Some(user)) => user,
        _ => return not_found("User member tidak ditemukan"),
    };

    Json(serde_json::json!({ "user": user_item_from_doc(user) })).into_response()
}

/// Admin force-revoke of a member's Open API credentials without deactivating the account.
pub async fn revoke_open_api_key(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageUsers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    if ensure_member_exists(&users, user_id).await.is_err() {
        return not_found("User member tidak ditemukan");
    }
    if users
        .update_one(
            doc! { "_id": user_id, "role": "member" },
            crate::routes::open_api::open_api_credentials_clear_update(),
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(user) = load_member_user_item(&users, user_id).await else {
        return not_found("User member tidak ditemukan");
    };
    Json(UserMutationResponse {
        message: "Open API key member berhasil dicabut",
        user,
    })
    .into_response()
}

pub async fn update_user(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<super::types::UpdateUserPayload>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageUsers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let db = client.database(&state.mongo_db);
    let users = db.collection::<Document>("users");
    if ensure_member_exists(&users, user_id).await.is_err() {
        return not_found("User member tidak ditemukan");
    }

    let mut set_doc = Document::new();
    if let Some(value) = payload.name {
        let name = value.trim().to_string();
        if name.len() < 2 || name.len() > 80 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nama user harus 2-80 karakter",
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
        let existing_user = users
            .find_one(doc! { "email": &email, "_id": { "$ne": user_id } })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten();
        if existing_user.is_some() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Email sudah dipakai akun lain",
            );
        }
        set_doc.insert("email", email);
    }
    if let Some(value) = payload.level {
        if !matches!(value.as_str(), "basic" | "gold" | "platinum") {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Level user tidak valid",
            );
        }
        set_doc.insert("level", value);
    }
    if set_doc.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tidak ada perubahan yang bisa disimpan",
        );
    }
    set_doc.insert("updatedAt", DateTime::now());
    if users
        .update_one(
            doc! { "_id": user_id, "role": "member" },
            doc! { "$set": set_doc },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(user) = load_member_user_item(&users, user_id).await else {
        return not_found("User member tidak ditemukan");
    };
    Json(UserMutationResponse {
        message: "User berhasil diperbarui",
        user,
    })
    .into_response()
}

pub async fn update_user_status(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UserStatusPayload>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageUsers").await {
        return response;
    }
    let Some(active) = payload.active else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status aktif wajib diisi",
        );
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    if ensure_member_exists(&users, user_id).await.is_err() {
        return not_found("User member tidak ditemukan");
    }
    // Deactivation must fully cut Open API access: both key and secret.
    // memberCode is retained as a stable identity for audit/history.
    let update = if active {
        doc! { "$set": { "active": true, "updatedAt": DateTime::now() } }
    } else {
        let mut clear = crate::routes::open_api::open_api_credentials_clear_update();
        clear.insert(
            "$set",
            doc! { "active": false, "updatedAt": DateTime::now() },
        );
        clear
    };
    if users
        .update_one(doc! { "_id": user_id, "role": "member" }, update)
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(user) = load_member_user_item(&users, user_id).await else {
        return not_found("User member tidak ditemukan");
    };
    Json(UserMutationResponse {
        message: if active {
            "User berhasil diaktifkan kembali"
        } else {
            "User berhasil dinonaktifkan"
        },
        user,
    })
    .into_response()
}

pub async fn delete_user(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageUsers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    if ensure_member_exists(&users, user_id).await.is_err() {
        return not_found("User member tidak ditemukan");
    }
    // Soft-delete path is the same Open API cutover as deactivate.
    let mut clear = crate::routes::open_api::open_api_credentials_clear_update();
    clear.insert(
        "$set",
        doc! { "active": false, "updatedAt": DateTime::now() },
    );
    if users
        .update_one(doc! { "_id": user_id, "role": "member" }, clear)
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(user) = load_member_user_item(&users, user_id).await else {
        return not_found("User member tidak ditemukan");
    };
    Json(UserMutationResponse {
        message: "User berhasil dinonaktifkan",
        user,
    })
    .into_response()
}
