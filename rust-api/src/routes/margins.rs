mod responses;
mod store;
mod types;
mod validation;

use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{SecondsFormat, Utc};

use crate::{security::require_sql_permission, state::AppState};

use responses::{format_margin_response, internal_error};
use store::{load_margin_setting, save_margin_patch};
use types::{MarginPayload, MarginUpdateResponse};
use validation::{normalize_margin_input, normalize_note};

pub async fn get_margins(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let setting = load_margin_setting(&state.pg_pool).await;
    Json(format_margin_response(setting.as_ref())).into_response()
}

pub async fn update_margins(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MarginPayload>,
) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "manageProducts").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let mut patch = serde_json::Map::new();
    if let Some(value) = payload.basic {
        match normalize_margin_input(value, "Margin Basic") {
            Ok(value) => patch.insert("basic".into(), serde_json::json!(value)),
            Err(response) => return response,
        };
    }
    if let Some(value) = payload.gold {
        match normalize_margin_input(value, "Margin Gold") {
            Ok(value) => patch.insert("gold".into(), serde_json::json!(value)),
            Err(response) => return response,
        };
    }
    if let Some(value) = payload.platinum {
        match normalize_margin_input(value, "Margin Platinum") {
            Ok(value) => patch.insert("platinum".into(), serde_json::json!(value)),
            Err(response) => return response,
        };
    }
    if let Some(value) = payload.note {
        match normalize_note(value) {
            Ok(value) => patch.insert("note".into(), serde_json::json!(value)),
            Err(response) => return response,
        };
    }
    let now = Utc::now();
    patch.insert(
        "updatedAt".into(),
        serde_json::json!(now.to_rfc3339_opts(SecondsFormat::Millis, true)),
    );
    patch.insert(
        "updatedBy".into(),
        serde_json::json!({
            "id": proxy_user.id,
            "email": proxy_user.email,
            "role": proxy_user.role,
        }),
    );
    if save_margin_patch(&state.pg_pool, serde_json::Value::Object(patch))
        .await
        .is_err()
    {
        return internal_error();
    }
    let saved = load_margin_setting(&state.pg_pool).await;
    let response = format_margin_response(saved.as_ref());
    Json(MarginUpdateResponse {
        message: "Margin updated successfully",
        success: response.success,
        data: response.data,
        meta: response.meta,
        limits: response.limits,
    })
    .into_response()
}
