use std::sync::Arc;

use axum::{extract::{Path, State}, response::{IntoResponse, Response}, Json};
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState};
use super::responses::{provider_not_found, unavailable};

pub async fn logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(provider): Path<String>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    if !matches!(provider.as_str(), "digiflazz" | "tokovoucher") { return provider_not_found(); }
    let rows = match sqlx::query("SELECT id,event,reference_id,status,message,verified,created_at FROM webhook_event_logs WHERE provider=$1 ORDER BY created_at DESC LIMIT 100")
        .bind(&provider).fetch_all(&state.pg_pool).await { Ok(rows)=>rows,Err(_)=>return unavailable() };
    Json(rows.into_iter().map(|row| serde_json::json!({
        "id":row.get::<uuid::Uuid,_>("id").to_string(),"timestamp":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),
        "event":row.get::<String,_>("event"),"refId":row.get::<String,_>("reference_id"),
        "status":row.get::<String,_>("status"),"message":row.get::<String,_>("message"),
        "verified":row.get::<bool,_>("verified")
    })).collect::<Vec<_>>()).into_response()
}
