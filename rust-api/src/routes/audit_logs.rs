mod export;
mod filters;
pub mod mappers;
mod sanitize;
mod types;

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;

use crate::{
    security::{require_proxy_context, require_sql_permission, require_sql_user, ErrorResponse},
    state::AppState,
};

use export::csv_response;
use filters::{build_audit_filter, parse_positive_i64};
use mappers::{audit_event_value, audit_log_item_from_doc};
use types::{AuditLogsQuery, AuditLogsResponse, PaginationResponse};

const AUDIT_EXPORT_LIMIT: i64 = 5000;

pub async fn audit_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuditLogsQuery>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewTeam").await { return response; }
    let page = match parse_positive_i64(query.page.as_deref(), 1, 10_000) { Ok(value) => value, Err(response) => return response };
    let limit = match parse_positive_i64(query.limit.as_deref(), 25, 100) { Ok(value) => value, Err(response) => return response };
    let filter = match build_audit_filter(&query) { Ok(value) => value, Err(response) => return response };
    let skip = (page - 1) * limit;
    let rows = match filter.fetch(&state.pg_pool, limit, skip).await { Ok(value) => value, Err(error) => { eprintln!("Failed to query admin audit logs: {error}"); return internal_error(); } };
    let total = match filter.count(&state.pg_pool).await { Ok(value) => value, Err(error) => { eprintln!("Failed to count admin audit logs: {error}"); return internal_error(); } };
    let items = rows.iter().map(|row| audit_log_item_from_doc(&audit_event_value(row))).collect();
    let resources = match sqlx::query_scalar::<_, String>("SELECT DISTINCT COALESCE(payload->>'resource', '') FROM audit_events WHERE COALESCE(payload->>'resource','') <> '' ORDER BY 1").fetch_all(&state.pg_pool).await { Ok(values) => values, Err(error) => { eprintln!("Failed to query audit resources: {error}"); return internal_error(); } };
    let total_pages = if total == 0 { 0 } else { (total as u64).div_ceil(limit as u64) };
    Json(AuditLogsResponse { items, resources, pagination: PaginationResponse { page, limit, total: total as u64, total_pages, total_pages_camel: total_pages } }).into_response()
}

pub async fn export_audit_logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<AuditLogsQuery>) -> Response {
    let user = match require_sql_permission(&headers, &state, "manageTeam").await { Ok(user) => user, Err(response) => return response };
    if let Err(error) = crate::sql_auth::verify_step_up(&headers, &state, &user, "exports.sensitive", chrono::Utc::now()) {
        return error.into_response();
    }
    let filter = match build_audit_filter(&query) { Ok(value) => value, Err(response) => return response };
    let rows = match filter.fetch(&state.pg_pool, AUDIT_EXPORT_LIMIT + 1, 0).await { Ok(value) => value, Err(error) => { eprintln!("Failed to query admin audit logs export: {error}"); return internal_error(); } };
    let mut items = rows.iter().map(audit_event_value).collect::<Vec<_>>();
    let truncated = items.len() as i64 > AUDIT_EXPORT_LIMIT;
    if truncated { items.truncate(AUDIT_EXPORT_LIMIT as usize); }
    csv_response(&items, truncated)
}

fn internal_error() -> Response {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { message: "Internal Server Error" })).into_response()
}

pub async fn sql_record_audit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(actor) = payload.get("actor").and_then(serde_json::Value::as_str) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Audit actor is required");
    };
    let Some(action) = payload.get("action").and_then(serde_json::Value::as_str) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Audit action is required");
    };
    let Some(outcome) = payload.get("outcome").and_then(serde_json::Value::as_str) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Audit outcome is required");
    };
    if !matches!(outcome, "success" | "failed" | "unauthorized") {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Audit outcome is invalid");
    }
    let Some(correlation) = payload.get("correlation").and_then(serde_json::Value::as_str) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Audit correlation is required");
    };
    let details = [
        "actorName", "actorEmail", "actorRole", "resource", "method", "path",
        "statusCode", "ip", "userAgent", "summary", "metadata",
    ].into_iter().filter_map(|key| payload.get(key).cloned().map(|value| (key.to_owned(), value)))
        .collect::<serde_json::Map<_, _>>();
    let details = crate::wallet_store::redact_audit_value(serde_json::Value::Object(details));
    let id: i64 = match sqlx::query_scalar(
        "INSERT INTO audit_events(actor,action,outcome,correlation,payload) VALUES($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(actor).bind(action).bind(outcome).bind(correlation).bind(details)
    .fetch_one(&state.pg_pool).await {
        Ok(id) => id,
        Err(_) => return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL audit store is unavailable"),
    };
    Json(serde_json::json!({"id": id, "outcome": outcome})).into_response()
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

