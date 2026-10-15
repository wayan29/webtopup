use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;

use crate::{security::ErrorResponse, state::AppState};

mod mappers;
mod points;
mod points_helpers;
mod types;
mod validation;
pub use points::{
    point_transactions, points_adjust, points_history, points_settings, points_settings_update,
    points_stats,
};
pub use types::RewardPayload;
use types::*;
use validation::*;

pub async fn rewards_admin_all(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = crate::security::require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    match sqlx::query("SELECT * FROM rewards ORDER BY created_at DESC, id DESC").fetch_all(&state.pg_pool).await {
        Ok(rows) => Json(rows.iter().map(reward_from_sql_row).collect::<Vec<_>>()).into_response(),
        Err(_) => unavailable(),
    }
}

pub async fn rewards_public(State(state): State<Arc<AppState>>) -> Response {
    match sqlx::query("SELECT * FROM rewards WHERE status ORDER BY points_required, id").fetch_all(&state.pg_pool).await {
        Ok(rows) => Json(rows.iter().map(reward_from_sql_row).collect::<Vec<_>>()).into_response(),
        Err(_) => unavailable(),
    }
}

pub async fn reward_public_detail(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(id) = reward_id(&id) else { return reward_not_found(); };
    match sqlx::query("SELECT * FROM rewards WHERE id=$1 AND status").bind(id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => Json(reward_from_sql_row(&row)).into_response(),
        Ok(None) => reward_not_found(),
        Err(_) => unavailable(),
    }
}

pub async fn reward_create(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<RewardPayload>) -> Response {
    if let Err(response) = crate::security::require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let Some(name) = payload.name.and_then(reward_text) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Nama hadiah wajib diisi"); };
    let name = name.trim();
    let description = payload.description.and_then(reward_text).unwrap_or_default();
    let category = payload.category.and_then(reward_text).unwrap_or_default();
    let image = payload.image_url.and_then(reward_text).unwrap_or_default();
    let Some(points) = payload.points_required.and_then(number_value) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Poin hadiah minimal 1"); };
    let Some(stock) = payload.stock.and_then(number_value) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Stok hadiah tidak boleh negatif"); };
    let status = matches!(payload.status, Some(serde_json::Value::Bool(true)));
    if name.is_empty() || description.trim().is_empty() || category.trim().is_empty() || points < 1 || stock < 0 { return status_message(axum::http::StatusCode::BAD_REQUEST, "Data hadiah tidak valid"); }
    if !image.starts_with("/uploads/") && !image.starts_with("http://") && !image.starts_with("https://") { return status_message(axum::http::StatusCode::BAD_REQUEST, "URL gambar harus diawali http:// atau https://"); }
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    let id: i64 = match sqlx::query_scalar("INSERT INTO rewards(name,description,points_required,stock,image_url,category,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id").bind(name).bind(description.trim()).bind(points).bind(stock).bind(image.as_str()).bind(category.trim()).bind(status).fetch_one(&mut *tx).await { Ok(id) => id, Err(_) => return internal_error() };
    if !image.is_empty() && image.starts_with("/uploads/") && crate::services::managed_asset_registry::acquire_reference(&mut tx, &image, &format!("rewards:{id}:image")).await.is_err() { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Managed asset registry unavailable"); }
    if tx.commit().await.is_err() { return internal_error(); }
    match sqlx::query("SELECT * FROM rewards WHERE id=$1").bind(id).fetch_one(&state.pg_pool).await {
        Ok(row) => (axum::http::StatusCode::CREATED, Json(RewardResponse { message: "Reward created successfully", reward: reward_from_sql_row(&row) })).into_response(),
        Err(_) => internal_error(),
    }
}

pub async fn reward_update(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<RewardPayload>) -> Response {
    if let Err(response) = crate::security::require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let Some(id) = reward_id(&id) else { return reward_not_found(); };
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    let old = match sqlx::query("SELECT * FROM rewards WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await { Ok(Some(row)) => row, Ok(None) => return reward_not_found(), Err(_) => return internal_error() };
    let name = payload.name.and_then(reward_text).unwrap_or_else(|| old.get("name"));
    let description = payload.description.and_then(reward_text).unwrap_or_else(|| old.get("description"));
    let category = payload.category.and_then(reward_text).unwrap_or_else(|| old.get("category"));
    let image = payload.image_url.and_then(reward_text).unwrap_or_else(|| old.get::<Option<String>,_>("image_url").unwrap_or_default());
    let points = payload.points_required.and_then(number_value).unwrap_or_else(|| old.get("points_required"));
    let stock = payload.stock.and_then(number_value).unwrap_or_else(|| i64::from(old.get::<i32,_>("stock")));
    let status = match payload.status { Some(serde_json::Value::Bool(value)) => value, None => old.get("status"), _ => false };
    if name.trim().is_empty() || description.trim().is_empty() || category.trim().is_empty() || points < 1 || stock < 0 || stock > i64::from(i32::MAX) { return status_message(axum::http::StatusCode::BAD_REQUEST, "Data hadiah tidak valid"); }
    if !image.is_empty() && !image.starts_with("/uploads/") && !image.starts_with("http://") && !image.starts_with("https://") { return status_message(axum::http::StatusCode::BAD_REQUEST, "URL gambar harus diawali http:// atau https://"); }
    let previous: Option<String> = old.get("image_url");
    let resource = format!("rewards:{id}:image");
    if previous.as_deref() != Some(image.as_str()) {
        if let Some(previous) = previous.as_deref().filter(|path| path.starts_with("/uploads/")) { if crate::services::managed_asset_registry::release_reference(&mut tx, previous, &resource).await.is_err() { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Managed asset registry unavailable"); } }
        if image.starts_with("/uploads/") && crate::services::managed_asset_registry::acquire_reference(&mut tx, &image, &resource).await.is_err() { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Managed asset registry unavailable"); }
    }
    if sqlx::query("UPDATE rewards SET name=$2,description=$3,points_required=$4,stock=$5,image_url=$6,category=$7,status=$8,updated_at=now() WHERE id=$1").bind(id).bind(name.trim()).bind(description.trim()).bind(points).bind(stock as i32).bind(if image.is_empty(){None}else{Some(image)}).bind(category.trim()).bind(status).execute(&mut *tx).await.is_err() { return internal_error(); }
    if tx.commit().await.is_err() { return internal_error(); }
    match sqlx::query("SELECT * FROM rewards WHERE id=$1").bind(id).fetch_one(&state.pg_pool).await { Ok(row) => Json(RewardResponse { message: "Reward updated successfully", reward: reward_from_sql_row(&row) }).into_response(), Err(_) => internal_error() }
}

pub async fn reward_delete(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(response) = crate::security::require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let Some(id) = reward_id(&id) else { return reward_not_found(); };
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    let row = match sqlx::query("SELECT image_url FROM rewards WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await { Ok(Some(row)) => row, Ok(None) => return reward_not_found(), Err(_) => return internal_error() };
    let history: bool = match sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM point_ledger WHERE reward_id=$1 AND transaction_type='redeem')").bind(id).fetch_one(&mut *tx).await { Ok(value) => value, Err(_) => return internal_error() };
    if history {
        if sqlx::query("UPDATE rewards SET status=false,stock=0,updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await.is_err() { return internal_error(); }
        if tx.commit().await.is_err() { return internal_error(); }
        return Json(RewardDeleteResponse { message: "Reward has redemption history and was archived instead of deleted", archived: Some(true) }).into_response();
    }
    if let Some(image) = row.get::<Option<String>,_>("image_url").filter(|path| path.starts_with("/uploads/")) { if crate::services::managed_asset_registry::release_reference(&mut tx, &image, &format!("rewards:{id}:image")).await.is_err() { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Managed asset registry unavailable"); } }
    if sqlx::query("DELETE FROM rewards WHERE id=$1").bind(id).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return internal_error(); }
    Json(RewardDeleteResponse { message: "Reward deleted successfully", archived: None }).into_response()
}

fn reward_id(value: &str) -> Option<i64> { value.trim().parse::<i64>().ok().filter(|id| *id > 0) }
fn reward_from_sql_row(row: &sqlx::postgres::PgRow) -> RewardItem {
    use sqlx::Row;
    let created: chrono::DateTime<chrono::Utc> = row.get("created_at");
    let updated: chrono::DateTime<chrono::Utc> = row.get("updated_at");
    RewardItem { id: row.get::<i64,_>("id").to_string(), name: row.get("name"), description: row.get("description"), points_required: row.get("points_required"), stock: i64::from(row.get::<i32,_>("stock")), image_url: row.get("image_url"), category: row.get("category"), status: row.get("status"), created_at: created.to_rfc3339(), updated_at: updated.to_rfc3339() }
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn reward_not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            message: "Reward not found",
        }),
    )
        .into_response()
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "SQL database is unavailable",
        }),
    )
        .into_response()
}
pub async fn sql_create_reward(Json(payload): Json<serde_json::Value>) -> Response {
    let Some(name) = payload.get("name").and_then(serde_json::Value::as_str) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward name is required"); };
    let Some(points) = payload.get("pointsRequired").and_then(serde_json::Value::as_i64) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward points are required"); };
    let Some(stock) = payload.get("stock").and_then(serde_json::Value::as_i64) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward stock is required"); };
    let Ok(stock) = i32::try_from(stock) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward stock is invalid"); };
    let Ok(store) = sql_reward_store().await else { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"); };
    match store.create_reward(name, points, stock).await {
        Ok(id) => Json(serde_json::json!({"id": id})).into_response(),
        Err(_) => status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"),
    }
}

pub async fn sql_claim_reward(Json(payload): Json<serde_json::Value>) -> Response {
    let Some(user_ref) = payload.get("userRef").and_then(serde_json::Value::as_str) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward user is required"); };
    let Some(reward_id) = payload.get("rewardId").and_then(serde_json::Value::as_i64) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward id is required"); };
    let Some(claim_key) = payload.get("claimKey").and_then(serde_json::Value::as_str) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward claim key is required"); };
    let Ok(store) = sql_reward_store().await else { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"); };
    match store.claim_reward(user_ref, reward_id, claim_key).await {
        Ok("claimed" | "replay") => Json(serde_json::json!({"status":"claimed"})).into_response(),
        Ok("exhausted") => status_message(axum::http::StatusCode::CONFLICT, "Reward quota exhausted"),
        Ok("insufficient") => status_message(axum::http::StatusCode::CONFLICT, "Reward points are insufficient"),
        Ok(_) => status_message(axum::http::StatusCode::NOT_FOUND, "Reward not found"),
        Err(_) => status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"),
    }
}

pub async fn sql_refund_reward(Json(payload): Json<serde_json::Value>) -> Response {
    let Some(user_ref) = payload.get("userRef").and_then(serde_json::Value::as_str) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward user is required"); };
    let Some(claim_key) = payload.get("claimKey").and_then(serde_json::Value::as_str) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward claim key is required"); };
    let Ok(store) = sql_reward_store().await else { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"); };
    match store.refund_reward_claim(user_ref, claim_key).await {
        Ok("refunded") => Json(serde_json::json!({"status":"refunded"})).into_response(),
        Ok("replay") => Json(serde_json::json!({"status":"replay"})).into_response(),
        Ok(_) => status_message(axum::http::StatusCode::NOT_FOUND, "Reward claim not found"),
        Err(_) => status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"),
    }
}

pub async fn sql_delete_reward(Json(payload): Json<serde_json::Value>) -> Response {
    let Some(reward_id) = payload.get("rewardId").and_then(serde_json::Value::as_i64) else { return status_message(axum::http::StatusCode::BAD_REQUEST, "Reward id is required"); };
    let Ok(store) = sql_reward_store().await else { return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"); };
    match store.delete_reward(reward_id).await {
        Ok(true) => Json(serde_json::json!({"status":"deleted"})).into_response(),
        Ok(false) => status_message(axum::http::StatusCode::CONFLICT, "Reward history prevents deletion"),
        Err(_) => status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "SQL reward store is unavailable"),
    }
}

async fn sql_reward_store() -> Result<crate::wallet_store::WalletStore, ()> {
    let Ok(url) = std::env::var("DATABASE_URL") else { return Err(()); };
    crate::wallet_store::WalletStore::connect(&url).await.map_err(|_| ())
}

fn reward_text(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => Some(value.trim().to_owned()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        serde_json::Value::Null | serde_json::Value::Array(_) | serde_json::Value::Object(_) => None,
    }
}
