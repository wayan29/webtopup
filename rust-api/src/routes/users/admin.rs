use std::{collections::HashMap, sync::Arc};

use axum::{extract::{Path, Query, State}, response::IntoResponse, Json};
use sqlx::Row;
use uuid::Uuid;

use crate::{security::require_permission, state::AppState};

use super::{responses::{internal_error, not_found, status_message, unavailable}, types::{UserItem, UserMutationResponse, UserStatusPayload, UserSummary, UsersResponse}, validation::{is_valid_email, normalize_email, parse_positive_i64, MAX_ADMIN_USERS_PAGE}};

const DEFAULT_PAGE_SIZE: i64 = 10;
const MAX_PAGE_SIZE: i64 = 100;

fn user_item(row: &sqlx::postgres::PgRow) -> UserItem {
    UserItem { id: row.get::<Uuid,_>("id").to_string(), name: row.get("name"), email: row.get("email"), level: row.get("level"), balance: row.get::<i64,_>("balance") as f64, points: row.get("points"), active: row.get("active"), member_code: row.get("member_code"), has_open_api_key: row.get("has_open_api_key"), created_at: row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(), updated_at: row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339() }
}

const ITEM_COLUMNS: &str = "u.id,u.name,u.email,u.level,u.balance,u.points,u.active,u.member_code,u.created_at,u.updated_at,EXISTS(SELECT 1 FROM open_api_credentials c WHERE c.user_id=u.id AND c.active) AS has_open_api_key";

pub async fn admin_list(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> axum::response::Response {
    if let Err(response) = require_permission(&headers,&state,"viewUsers").await { return response; }
    let page=parse_positive_i64(query.get("page"),1,MAX_ADMIN_USERS_PAGE);
    let limit=parse_positive_i64(query.get("limit"),DEFAULT_PAGE_SIZE,MAX_PAGE_SIZE);
    let search=query.get("search").map(|s|s.trim().to_owned()).filter(|s|!s.is_empty());
    let level=query.get("level").filter(|v|matches!(v.as_str(),"basic"|"gold"|"platinum")).cloned();
    let active=match query.get("status").map(String::as_str){Some("active")=>Some(true),Some("inactive")=>Some(false),_=>None};
    let sort_by=match query.get("sortBy").map(String::as_str){Some("updatedAt")=>"u.updated_at",Some("name")=>"u.name",Some("email")=>"u.email",Some("balance")=>"u.balance",_=>"u.created_at"};
    let direction=if query.get("sortOrder").map(String::as_str)==Some("asc"){"ASC"}else{"DESC"};
    let base=" FROM users u WHERE u.role='member' AND ($1::text IS NULL OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%') AND ($2::text IS NULL OR u.level=$2) AND ($3::boolean IS NULL OR u.active=$3)";
    let count_sql=format!("SELECT COUNT(*){base}");
    let total=match sqlx::query_scalar::<_,i64>(&count_sql).bind(&search).bind(&level).bind(active).fetch_one(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return internal_error()};
    let sql=format!("SELECT {ITEM_COLUMNS}{base} ORDER BY {sort_by} {direction},u.id LIMIT $4 OFFSET $5");
    let rows=match sqlx::query(&sql).bind(&search).bind(&level).bind(active).bind(limit).bind((page-1).saturating_mul(limit)).fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return internal_error()};
    let summary=match sqlx::query("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE active) AS active,COUNT(*) FILTER(WHERE NOT active) AS inactive,COALESCE(SUM(balance),0)::float8 AS balance FROM users WHERE role='member'").fetch_one(&state.pg_pool).await{Ok(row)=>UserSummary{id:Some(serde_json::Value::Null),total_members:row.get("total"),active_members:row.get("active"),inactive_members:row.get("inactive"),total_balance:row.get("balance")},Err(_)=>return internal_error()};
    Json(UsersResponse{users:rows.iter().map(user_item).collect(),current_page:page,total_pages:std::cmp::max(1,((total as f64)/(limit as f64)).ceil() as i64),total_users:total,page_size:limit,summary}).into_response()
}

pub async fn admin_detail(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->axum::response::Response{
    if let Err(response)=require_permission(&headers,&state,"viewUsers").await{return response;}
    let Ok(id)=Uuid::parse_str(&id) else{return status_message(axum::http::StatusCode::BAD_REQUEST,"ID user tidak valid")};
    match sqlx::query(&format!("SELECT {ITEM_COLUMNS} FROM users u WHERE u.id=$1 AND u.role='member'")).bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>Json(serde_json::json!({"user":user_item(&row)})).into_response(),Ok(None)=>not_found("User member tidak ditemukan"),Err(_)=>internal_error()}
}

pub async fn revoke_open_api_key(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->axum::response::Response{
    if let Err(response)=require_permission(&headers,&state,"manageUsers").await{return response;}
    let Ok(id)=Uuid::parse_str(&id) else{return status_message(axum::http::StatusCode::BAD_REQUEST,"ID user tidak valid")};
    let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return unavailable()};
    let exists=match sqlx::query_scalar::<_,Uuid>("SELECT id FROM users WHERE id=$1 AND role='member' FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(v)=>v.is_some(),Err(_)=>return unavailable()};
    if !exists{return not_found("User member tidak ditemukan")}
    if sqlx::query("UPDATE open_api_credentials SET active=FALSE,secret_nonce=NULL,secret_ciphertext=NULL WHERE user_id=$1").bind(id).execute(&mut *tx).await.is_err(){return internal_error()}
    if tx.commit().await.is_err(){return internal_error()}
    match sqlx::query(&format!("SELECT {ITEM_COLUMNS} FROM users u WHERE u.id=$1 AND u.role='member'")).bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>Json(UserMutationResponse{message:"Open API key member berhasil dicabut",user:user_item(&row)}).into_response(),_=>not_found("User member tidak ditemukan")}
}

pub async fn update_user(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>,Json(payload):Json<super::types::UpdateUserPayload>)->axum::response::Response{
    if let Err(response)=require_permission(&headers,&state,"manageUsers").await{return response;}
    let Ok(id)=Uuid::parse_str(&id) else{return status_message(axum::http::StatusCode::BAD_REQUEST,"ID user tidak valid")};
    let name=match payload.name{Some(v)=>{let v=v.trim().to_owned();if !(2..=80).contains(&v.len()){return status_message(axum::http::StatusCode::BAD_REQUEST,"Nama user harus 2-80 karakter")}Some(v)},None=>None};
    let email=match payload.email{Some(v)=>{let v=normalize_email(&v);if !is_valid_email(&v){return status_message(axum::http::StatusCode::BAD_REQUEST,"Format email tidak valid")}Some(v)},None=>None};
    let level=match payload.level{Some(v) if matches!(v.as_str(),"basic"|"gold"|"platinum")=>Some(v),Some(_)=>return status_message(axum::http::StatusCode::BAD_REQUEST,"Level user tidak valid"),None=>None};
    if name.is_none()&&email.is_none()&&level.is_none(){return status_message(axum::http::StatusCode::BAD_REQUEST,"Tidak ada perubahan yang bisa disimpan")}
    let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return unavailable()};
    let exists=match sqlx::query_scalar::<_,Uuid>("SELECT id FROM users WHERE id=$1 AND role='member' FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(v)=>v.is_some(),Err(_)=>return unavailable()};if !exists{return not_found("User member tidak ditemukan")}
    if let Some(email)=&email{let duplicate=match sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM users WHERE normalized_email=lower(btrim($1)) AND id<>$2)").bind(email).bind(id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal_error()};if duplicate{return status_message(axum::http::StatusCode::BAD_REQUEST,"Email sudah dipakai akun lain")}}
    let result=sqlx::query("UPDATE users SET name=COALESCE($2,name),email=COALESCE($3,email),level=COALESCE($4,level),updated_at=now() WHERE id=$1 AND role='member'").bind(id).bind(name).bind(email).bind(level).execute(&mut *tx).await;
    if result.is_err(){return internal_error()}if tx.commit().await.is_err(){return internal_error()}
    match sqlx::query(&format!("SELECT {ITEM_COLUMNS} FROM users u WHERE u.id=$1 AND u.role='member'")).bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>Json(UserMutationResponse{message:"User berhasil diperbarui",user:user_item(&row)}).into_response(),_=>not_found("User member tidak ditemukan")}
}

async fn set_user_active(state:Arc<AppState>,id:Uuid,active:bool)->axum::response::Response{
    let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return unavailable()};
    let exists=match sqlx::query_scalar::<_,Uuid>("SELECT id FROM users WHERE id=$1 AND role='member' FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(v)=>v.is_some(),Err(_)=>return unavailable()};if !exists{return not_found("User member tidak ditemukan")}
    if sqlx::query("UPDATE users SET active=$2,updated_at=now(),session_version=session_version+CASE WHEN active<>$2 THEN 1 ELSE 0 END,security_generation=security_generation+CASE WHEN active<>$2 THEN 1 ELSE 0 END WHERE id=$1").bind(id).bind(active).execute(&mut *tx).await.is_err(){return internal_error()}
    if !active&&sqlx::query("UPDATE open_api_credentials SET active=FALSE,secret_nonce=NULL,secret_ciphertext=NULL WHERE user_id=$1").bind(id).execute(&mut *tx).await.is_err(){return internal_error()}
    if !active&&sqlx::query("UPDATE auth_sessions SET state='revoked',owns_slot=FALSE WHERE user_id=$1 AND state IN ('active','locked')").bind(id).execute(&mut *tx).await.is_err(){return internal_error()}
    if tx.commit().await.is_err(){return internal_error()}
    match sqlx::query(&format!("SELECT {ITEM_COLUMNS} FROM users u WHERE u.id=$1 AND u.role='member'")).bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>Json(UserMutationResponse{message:if active{"User berhasil diaktifkan kembali"}else{"User berhasil dinonaktifkan"},user:user_item(&row)}).into_response(),_=>not_found("User member tidak ditemukan")}
}

pub async fn update_user_status(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>,Json(payload):Json<UserStatusPayload>)->axum::response::Response{
    if let Err(response)=require_permission(&headers,&state,"manageUsers").await{return response;}
    let Some(active)=payload.active else{return status_message(axum::http::StatusCode::BAD_REQUEST,"Status aktif wajib diisi")};
    let Ok(id)=Uuid::parse_str(&id) else{return status_message(axum::http::StatusCode::BAD_REQUEST,"ID user tidak valid")};set_user_active(state,id,active).await
}

pub async fn delete_user(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->axum::response::Response{
    if let Err(response)=require_permission(&headers,&state,"manageUsers").await{return response;}
    let Ok(id)=Uuid::parse_str(&id) else{return status_message(axum::http::StatusCode::BAD_REQUEST,"ID user tidak valid")};set_user_active(state,id,false).await
}
