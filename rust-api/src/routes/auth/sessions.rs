use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, Document};
use serde_json::json;

use super::{internal_error, status_message, unavailable};
use crate::{security::require_proxy_context, state::AppState};

pub async fn revoke_sessions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(user_id) = context.user_id else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(user_id) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    match client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .update_one(
            doc! { "_id": object_id },
            doc! { "$inc": { "sessionVersion": 1_i64 } },
        )
        .await
    {
        Ok(result) if result.matched_count > 0 => Json(json!({
            "message": "Semua sesi aktif berhasil dicabut. Silakan login ulang."
        }))
        .into_response(),
        Ok(_) => status_message(axum::http::StatusCode::NOT_FOUND, "User not found"),
        Err(_) => internal_error(),
    }
}
