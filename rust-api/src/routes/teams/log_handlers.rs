use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    security::{require_permission, require_proxy_context},
    state::AppState,
};

use super::{
    responses::{status_message, unavailable},
    types::TeamAuditLogsResponse,
};

fn page(query: &HashMap<String, String>) -> (i64, i64, i64) {
    let page = query.get("page").and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0).unwrap_or(1);
    let limit = query.get("limit").and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0).unwrap_or(10).min(50);
    (page, limit, (page - 1).saturating_mul(limit))
}

fn parse_id(id: &str) -> Result<Uuid, axum::response::Response> {
    Uuid::parse_str(id).map_err(|_| status_message(axum::http::StatusCode::BAD_REQUEST, "ID anggota tim tidak valid"))
}

fn unavailable_response() -> axum::response::Response {
    unavailable()
}

async fn authorize_scope(headers: &axum::http::HeaderMap, state: &AppState) -> Result<(Uuid, bool, String), axum::response::Response> {
    let context = require_proxy_context(headers, state)?;
    let actor_id = context.user_id.as_deref().and_then(|id| Uuid::parse_str(id).ok()).ok_or_else(|| status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let row = sqlx::query("SELECT role FROM users WHERE id=$1 AND active=TRUE").bind(actor_id).fetch_optional(&state.pg_pool).await.map_err(|_| unavailable_response())?.ok_or_else(|| status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let role: String = row.get("role");
    if !matches!(role.as_str(), "owner" | "admin" | "cs") { return Err(status_message(axum::http::StatusCode::FORBIDDEN, "Forbidden")); }
    Ok((actor_id, role == "owner", role))
}

fn log_response(rows: Vec<sqlx::postgres::PgRow>, page: i64, limit: i64, total: i64) -> axum::response::Response {
    let logs = rows.into_iter().map(|row| json!({"_id":row.get::<Uuid,_>("id").to_string(),"user":row.get::<Uuid,_>("user_id").to_string(),"ip":row.get::<Option<String>,_>("ip"),"userAgent":row.get::<Option<String>,_>("user_agent"),"status":row.get::<String,_>("status"),"createdAt":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339()})).collect::<Vec<_>>();
    Json(json!({"logs":logs,"currentPage":page,"totalPages":std::cmp::max(1,((total as f64)/(limit as f64)).ceil() as i64),"totalLogs":total,"pageSize":limit})).into_response()
}

pub async fn audit_logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await { return response; }
    let (current, limit, offset) = page(&query);
    let total = match sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM audit_events WHERE action LIKE 'team:%' OR correlation LIKE 'team:%'").fetch_one(&state.pg_pool).await { Ok(v)=>v, Err(_)=>return unavailable() };
    let rows = match sqlx::query("SELECT id,actor,action,created_at,payload FROM audit_events WHERE action LIKE 'team:%' OR correlation LIKE 'team:%' ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2").bind(limit).bind(offset).fetch_all(&state.pg_pool).await { Ok(v)=>v, Err(_)=>return unavailable() };
    let logs = rows.into_iter().map(|r| {
        let payload: serde_json::Value = r.get("payload");
        let actor = r.get::<String,_>("actor");
        let actor_id = Uuid::parse_str(&actor).ok();
        let action: String = r.get("action");
        super::types::TeamAuditLogItem {
            id: r.get::<i64,_>("id").to_string(), actor: actor_id.map(|v| v.to_string()),
            actor_name: payload.get("actorName").and_then(|v|v.as_str()).unwrap_or("").to_owned(),
            actor_email: payload.get("actorEmail").and_then(|v|v.as_str()).unwrap_or("").to_owned(),
            target_user: payload.get("target").and_then(|v|v.as_str()).map(str::to_owned),
            target_name: payload.get("targetName").and_then(|v|v.as_str()).unwrap_or("").to_owned(),
            target_email: payload.get("targetEmail").and_then(|v|v.as_str()).unwrap_or("").to_owned(),
            target_role: payload.get("targetRole").and_then(|v|v.as_str()).unwrap_or("").to_owned(),
            summary: payload.get("summary").and_then(|v|v.as_str()).unwrap_or(&action).to_owned(),
            action, metadata: Some(payload),
            created_at: r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(), updated_at: String::new(),
        }
    }).collect();
    let total_pages = std::cmp::max(1, ((total as f64)/(limit as f64)).ceil() as i64);
    Json(TeamAuditLogsResponse { logs, current_page: current, total_pages, total_logs: total, page_size: limit }).into_response()
}

pub async fn login_logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(query): Query<HashMap<String, String>>) -> axum::response::Response {
    let actor = match crate::security::require_sql_permission(&headers,&state,"manageTeam").await { Ok(v)=>v,Err(r)=>return r };
    let owner = actor.role == "owner";
    let member_id = match parse_id(&id) { Ok(v)=>v, Err(r)=>return r };
    let member = match sqlx::query("SELECT role FROM users WHERE id=$1 AND role IN ('admin','cs')").bind(member_id).fetch_optional(&state.pg_pool).await { Ok(Some(v))=>v, _=>return status_message(axum::http::StatusCode::NOT_FOUND,"Anggota tim tidak ditemukan") };
    let role: String = member.get("role");
    if !owner && role != "cs" { return status_message(axum::http::StatusCode::FORBIDDEN,"Hanya owner yang dapat melihat log login admin"); }
    let (current,limit,offset)=page(&query);
    let total=match sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM audit_events WHERE actor=$1 AND action='login_success'").bind(member_id.to_string()).fetch_one(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
    let rows=match sqlx::query("SELECT id,actor,action,outcome,created_at,payload FROM audit_events WHERE actor=$1 AND action='login_success' ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3").bind(member_id.to_string()).bind(limit).bind(offset).fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
    let logs=rows.into_iter().map(|r| { let payload:serde_json::Value=r.get("payload"); serde_json::json!({"_id":r.get::<i64,_>("id").to_string(),"user":member_id.to_string(),"email":payload.get("email").and_then(|v|v.as_str()).unwrap_or(""),"role":role,"status":"success","createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339()}) }).collect::<Vec<_>>();
    Json(serde_json::json!({"logs":logs,"currentPage":current,"totalPages":std::cmp::max(1,((total as f64)/(limit as f64)).ceil() as i64),"totalLogs":total,"pageSize":limit,"scope":if owner {"owner"} else {"cs"}})).into_response()
}

pub async fn all_login_logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> axum::response::Response {
    let actor=match crate::security::require_sql_permission(&headers,&state,"manageTeam").await {Ok(v)=>v,Err(r)=>return r};
    let roles=if actor.role=="owner" {vec!["owner","admin","cs"]} else {vec!["cs"]};
    let (current,limit,offset)=page(&query);
    let total=match sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM audit_events a JOIN users u ON u.id::text=a.actor WHERE u.role=ANY($1) AND a.action='login_success'").bind(&roles).fetch_one(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
    let rows=match sqlx::query("SELECT a.id,a.actor,a.action,a.created_at,a.payload,u.email,u.role FROM audit_events a JOIN users u ON u.id::text=a.actor WHERE u.role=ANY($1) AND a.action='login_success' ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3").bind(&roles).bind(limit).bind(offset).fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};
    let logs=rows.into_iter().map(|r| serde_json::json!({"_id":r.get::<i64,_>("id").to_string(),"user":r.get::<String,_>("actor"),"email":r.get::<String,_>("email"),"role":r.get::<String,_>("role"),"status":"success","createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339()})).collect::<Vec<_>>();
    Json(serde_json::json!({"logs":logs,"currentPage":current,"totalPages":std::cmp::max(1,((total as f64)/(limit as f64)).ceil() as i64),"totalLogs":total,"pageSize":limit,"scope":if actor.role=="owner" {"owner"} else {"cs"}})).into_response()
}




