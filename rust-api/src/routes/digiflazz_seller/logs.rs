use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState};

use super::SellerLogItem;

pub async fn logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let rows = match sqlx::query("SELECT id::text AS id, created_at, event, reference_id, status, message, verified FROM seller_event_logs WHERE channel = 'digiflazz' ORDER BY created_at DESC LIMIT 100")
        .fetch_all(&state.pg_pool)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return super::internal_error(),
    };
    Json(rows.into_iter().map(|row| SellerLogItem {
        id: row.try_get("id").unwrap_or_default(),
        timestamp: row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").map(|value| value.to_rfc3339()).unwrap_or_default(),
        event: row.try_get::<String, _>("event").unwrap_or_else(|_| "digiflazz_seller".to_string()),
        ref_id: row.try_get("reference_id").unwrap_or_default(),
        status: row.try_get("status").unwrap_or_default(),
        message: row.try_get("message").unwrap_or_default(),
        delivered: row.try_get("verified").unwrap_or(false),
    }).collect::<Vec<_>>()).into_response()
}

