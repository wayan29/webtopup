use std::sync::Arc;

use axum::{extract::{Path, State}, response::{IntoResponse, Response}, Json};
use serde_json::Value;
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState};

use super::{internal_error, status_message, types::{VendorItem, VendorPayload}};

pub async fn admin_all(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let rows = match sqlx::query("SELECT id,name,slug,api_base_url,config,low_balance_threshold,status,created_at,updated_at FROM vendors ORDER BY created_at DESC,id")
        .fetch_all(&state.pg_pool).await { Ok(rows) => rows, Err(_) => return internal_error() };
    Json(rows.into_iter().map(vendor_item_from_row).collect::<Vec<_>>()).into_response()
}

pub async fn admin_detail(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let Ok(id) = id.parse::<uuid::Uuid>() else { return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found") };
    match sqlx::query("SELECT id,name,slug,api_base_url,config,low_balance_threshold,status,created_at,updated_at FROM vendors WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => Json(vendor_item_from_row(row)).into_response(),
        Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => internal_error(),
    }
}

pub async fn create_vendor(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<VendorPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let name = payload.name.unwrap_or_default();
    let slug = slugify(&name);
    let config = payload.config.unwrap_or_else(|| serde_json::json!({}));
    let threshold = payload.low_balance_threshold.as_ref().and_then(json_i64).unwrap_or(0).max(0);
    let row = sqlx::query("INSERT INTO vendors(name,slug,api_base_url,config,low_balance_threshold,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,slug,api_base_url,config,low_balance_threshold,status,created_at,updated_at")
        .bind(&name).bind(slug).bind(payload.api_base_url.unwrap_or_default()).bind(config).bind(threshold).bind(payload.status.unwrap_or(true)).fetch_one(&state.pg_pool).await;
    match row {
        Ok(row) => (axum::http::StatusCode::CREATED, Json(serde_json::json!({"message":"Vendor created successfully","vendor":vendor_item_from_row(row)}))).into_response(),
        Err(error) if error.to_string().contains("unique") => status_message(axum::http::StatusCode::BAD_REQUEST,"Vendor already exists"),
        Err(_) => internal_error(),
    }
}

pub async fn update_vendor(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<VendorPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let Ok(id) = id.parse::<uuid::Uuid>() else { return internal_error() };
    let existing = match sqlx::query("SELECT name,api_base_url,config,low_balance_threshold,status FROM vendors WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await { Ok(Some(r))=>r, Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Vendor not found"), Err(_)=>return internal_error() };
    let name = payload.name.unwrap_or_else(|| existing.get("name"));
    let result = sqlx::query("UPDATE vendors SET name=$2,slug=$3,api_base_url=$4,config=$5,low_balance_threshold=$6,status=$7,updated_at=now() WHERE id=$1")
        .bind(id).bind(&name).bind(slugify(&name)).bind(payload.api_base_url.unwrap_or_else(|| existing.get("api_base_url"))).bind(payload.config.unwrap_or_else(|| existing.get("config"))).bind(payload.low_balance_threshold.as_ref().and_then(json_i64).unwrap_or_else(|| existing.get("low_balance_threshold")).max(0)).bind(payload.status.unwrap_or_else(|| existing.get("status"))).execute(&state.pg_pool).await;
    match result { Ok(_) => match sqlx::query("SELECT id,name,slug,api_base_url,config,low_balance_threshold,status,created_at,updated_at FROM vendors WHERE id=$1").bind(id).fetch_one(&state.pg_pool).await { Ok(row)=>Json(serde_json::json!({"message":"Vendor updated successfully","vendor":vendor_item_from_row(row)})).into_response(),Err(_)=>internal_error() }, Err(error) if error.to_string().contains("unique")=>status_message(axum::http::StatusCode::BAD_REQUEST,"Vendor already exists"),Err(_)=>internal_error() }
}

pub async fn delete_vendor(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let Ok(id) = id.parse::<uuid::Uuid>() else { return internal_error() };
    let row = match sqlx::query("SELECT name FROM vendors WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await { Ok(Some(row))=>row,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Vendor not found"),Err(_)=>return internal_error() };
    let name: String = row.get("name");
    let count = match sqlx::query_scalar::<_,i64>("SELECT count(*) FROM products WHERE vendor_name=$1").bind(&name).fetch_one(&state.pg_pool).await { Ok(count)=>count,Err(_)=>return internal_error() };
    if count > 0 { return (axum::http::StatusCode::BAD_REQUEST,Json(serde_json::json!({"message":format!("Cannot delete vendor. {count} products are using this vendor.")}))).into_response(); }
    match sqlx::query("DELETE FROM vendors WHERE id=$1").bind(id).execute(&state.pg_pool).await { Ok(_)=>Json(serde_json::json!({"message":"Vendor deleted successfully"})).into_response(),Err(_)=>internal_error() }
}

fn json_i64(value: &Value) -> Option<i64> { value.as_i64().or_else(|| value.as_str()?.parse().ok()) }
fn slugify(name: &str) -> String { name.trim().to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join("-") }
fn vendor_item_from_row(row: sqlx::postgres::PgRow) -> VendorItem {
    VendorItem { id:row.get::<uuid::Uuid,_>("id").to_string(), name:row.get("name"), api_base_url:row.get("api_base_url"), config:row.get("config"), low_balance_threshold:row.get("low_balance_threshold"), status:row.get("status"), created_at:row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(), updated_at:row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339(), version:0, slug:Some(row.get("slug")) }
}
