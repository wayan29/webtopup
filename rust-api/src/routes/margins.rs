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
use mongodb::bson::{DateTime, Document};

use crate::{security::require_permission, state::AppState};

use responses::{date_time_to_string, format_margin_response, internal_error, unavailable};
use store::{load_margin_setting, save_margin_patch};
use types::{MarginPayload, MarginUpdateResponse};
use validation::{normalize_margin_input, normalize_note};

pub async fn get_margins(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let settings = client
        .database(&state.mongo_db)
        .collection::<Document>("settings");
    let setting = load_margin_setting(&settings).await;
    Json(format_margin_response(setting.as_ref())).into_response()
}

pub async fn update_margins(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MarginPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "manageProducts").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let settings = db.collection::<Document>("settings");
    let mut value_updates = Document::new();
    if let Some(value) = payload.basic {
        match normalize_margin_input(value, "Margin Basic") {
            Ok(value) => {
                value_updates.insert("value.basic", value);
            }
            Err(response) => return response,
        }
    }
    if let Some(value) = payload.gold {
        match normalize_margin_input(value, "Margin Gold") {
            Ok(value) => {
                value_updates.insert("value.gold", value);
            }
            Err(response) => return response,
        }
    }
    if let Some(value) = payload.platinum {
        match normalize_margin_input(value, "Margin Platinum") {
            Ok(value) => {
                value_updates.insert("value.platinum", value);
            }
            Err(response) => return response,
        }
    }
    if let Some(value) = payload.note {
        match normalize_note(value) {
            Ok(value) => {
                value_updates.insert("value.note", value);
            }
            Err(response) => return response,
        }
    }
    let now = DateTime::now();
    let now_text = date_time_to_string(now);
    let mut updated_by = Document::new();
    updated_by.insert("id", proxy_user.id.to_hex());
    updated_by.insert("email", proxy_user.email);
    updated_by.insert("role", proxy_user.role);
    value_updates.insert("value.updatedAt", &now_text);
    value_updates.insert("value.updatedBy", updated_by);
    if save_margin_patch(&settings, value_updates, now)
        .await
        .is_err()
    {
        return internal_error();
    }
    let saved = load_margin_setting(&settings).await;
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
