use axum::{http::HeaderMap, response::Response};
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::require_proxy_context, state::AppState};

use super::responses::{not_found, status_message, unavailable};

pub(super) async fn current_member_user(
    headers: HeaderMap,
    state: &AppState,
) -> Result<Document, Response> {
    let context = require_proxy_context(&headers, state)?;
    if context.user_id.is_none() {
        return Err(status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Unauthorized",
        ));
    }
    if context.user_role.as_deref() != Some("member") {
        return Err(status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya member yang dapat mengakses data ini",
        ));
    }
    let Some(client) = state.mongo_client.as_ref() else {
        return Err(unavailable());
    };
    let user_id = match ObjectId::parse_str(context.user_id.as_deref().unwrap_or_default()) {
        Ok(user_id) => user_id,
        Err(_) => {
            return Err(status_message(
                axum::http::StatusCode::NOT_FOUND,
                "User member tidak ditemukan",
            ));
        }
    };
    let user = client
        .database(&state.mongo_db)
        .collection::<Document>("users")
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
    let Some(user) = user else {
        return Err(not_found("User member tidak ditemukan"));
    };
    if user.get_bool("active") == Ok(false) {
        return Err(status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Akun tidak aktif",
        ));
    }
    Ok(user)
}

pub(super) async fn current_authenticated_user(
    headers: HeaderMap,
    state: &AppState,
) -> Result<Document, Response> {
    let context = require_proxy_context(&headers, state)?;
    if context.user_id.is_none() {
        return Err(status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Unauthorized",
        ));
    }
    let Some(client) = state.mongo_client.as_ref() else {
        return Err(unavailable());
    };
    let user_id = match ObjectId::parse_str(context.user_id.as_deref().unwrap_or_default()) {
        Ok(user_id) => user_id,
        Err(_) => return Err(not_found("User tidak ditemukan")),
    };
    let user = client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "active": 1, "preferences": 1 })
        .await
        .ok()
        .flatten();
    let Some(user) = user else {
        return Err(not_found("User tidak ditemukan"));
    };
    if user.get_bool("active") == Ok(false) {
        return Err(status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Akun tidak aktif",
        ));
    }
    Ok(user)
}

pub(super) fn current_member_id(
    headers: HeaderMap,
    state: &AppState,
) -> Result<ObjectId, Response> {
    let context = require_proxy_context(&headers, state)?;
    let Some(user_id) = context.user_id.as_deref() else {
        return Err(status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Unauthorized",
        ));
    };
    if context.user_role.as_deref() != Some("member") {
        return Err(status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Balance history hanya tersedia untuk member",
        ));
    }
    ObjectId::parse_str(user_id).map_err(|_| not_found("User member tidak ditemukan"))
}
