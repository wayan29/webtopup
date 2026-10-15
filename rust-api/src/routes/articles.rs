use std::sync::Arc;

use axum::{extract::{Path, State}, response::{IntoResponse, Response}, Json};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{security::require_sql_permission, services::{managed_asset_registry::{acquire_reference, release_reference}, managed_assets::{effectively_changed_managed_field, ensure_managed_field_for_update, ManagedFieldFolderPolicy}}, state::AppState};

mod responses;
mod validation;
mod types;
use self::responses::{internal_error, status_message, unavailable};
use self::validation::{build_article_payload, sanitize_article_html};
use self::types::ArticlePayload;

fn article_uuid(value: &str) -> Option<Uuid> { let id=Uuid::parse_str(value).ok()?; (id.to_string()==value).then_some(id) }
async fn asset(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid, old: &str, next: &str) -> Result<(), Response> {
    ensure_managed_field_for_update(&crate::routes::uploads::upload_root(), next, ManagedFieldFolderPolicy::Covers, effectively_changed_managed_field(Some(old), next))?;
    let resource=format!("articles:{id}:image");
    if old.starts_with("/uploads/") && old!=next { release_reference(tx,old,&resource).await.map_err(|_| unavailable())?; }
    if next.starts_with("/uploads/") && old!=next { acquire_reference(tx,next,&resource).await.map_err(|_| unavailable())?; }
    Ok(())
}
fn row_json(row: &sqlx::postgres::PgRow) -> Value { json!({"_id":row.get::<Uuid,_>("id").to_string(),"title":row.get::<String,_>("title"),"slug":row.get::<String,_>("slug"),"excerpt":row.get::<String,_>("excerpt"),"content":row.get::<String,_>("content"),"category":row.get::<String,_>("category"),"status":row.get::<String,_>("status"),"image":row.get::<String,_>("image"),"createdAt":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),"updatedAt":row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339()}) }
fn public_row(row: &sqlx::postgres::PgRow) -> Value { let mut v=row_json(row); v["content"]=json!(sanitize_article_html(v["content"].as_str().unwrap_or(""))); v }

pub async fn public_list(State(state):State<Arc<AppState>>) -> Response { match sqlx::query("SELECT * FROM content_articles WHERE status='published' ORDER BY created_at DESC").fetch_all(&state.pg_pool).await { Ok(rows)=>Json(rows.iter().map(public_row).collect::<Vec<_>>()).into_response(), Err(_)=>unavailable() } }
pub async fn public_detail(State(state):State<Arc<AppState>>,Path(slug):Path<String>) -> Response { match sqlx::query("SELECT * FROM content_articles WHERE slug=$1 AND status='published'").bind(slug).fetch_optional(&state.pg_pool).await { Ok(Some(row))=>Json(public_row(&row)).into_response(),Ok(None)=>status_message(axum::http::StatusCode::NOT_FOUND,"Article not found"),Err(_)=>unavailable() } }

pub async fn create(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<ArticlePayload>)->Response {
 let actor=match require_sql_permission(&headers,&state,"manageSettings").await{Ok(v)=>v,Err(r)=>return r};
 let payload=match build_article_payload(payload,None){Ok(v)=>v,Err(r)=>return r}; let id=Uuid::new_v4(); let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
 if let Err(r)=asset(&mut tx,id,"",&payload.image).await{return r;}
 let row=match sqlx::query("INSERT INTO content_articles(id,title,slug,excerpt,content,category,status,image,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *").bind(id).bind(&payload.title).bind(&payload.slug).bind(&payload.excerpt).bind(&payload.content).bind(&payload.category).bind(&payload.status).bind(&payload.image).bind(actor.id).fetch_one(&mut *tx).await {Ok(v)=>v,Err(e)=>{if e.as_database_error().is_some_and(|x|x.is_unique_violation()){return status_message(axum::http::StatusCode::CONFLICT,"Slug artikel sudah digunakan");}return internal_error();}};
 if tx.commit().await.is_err(){return internal_error();}(axum::http::StatusCode::CREATED,Json(row_json(&row))).into_response()
}

pub async fn update(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>,Json(payload):Json<ArticlePayload>)->Response {
 let actor=match require_sql_permission(&headers,&state,"manageSettings").await{Ok(v)=>v,Err(r)=>return r};let Some(id)=article_uuid(id.trim())else{return internal_error()}; let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
 let old=match sqlx::query("SELECT * FROM content_articles WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Article not found"),Err(_)=>return internal_error()};let old_image:String=old.get("image");let old_json=row_json(&old);
 let payload=match build_article_payload(payload,Some(&old_json)){Ok(v)=>v,Err(r)=>return r}; if let Err(r)=asset(&mut tx,id,&old_image,&payload.image).await{return r;}
 let row=match sqlx::query("UPDATE content_articles SET title=$2,slug=$3,excerpt=$4,content=$5,category=$6,status=$7,image=$8,updated_at=now() WHERE id=$1 RETURNING *").bind(id).bind(payload.title).bind(payload.slug).bind(payload.excerpt).bind(payload.content).bind(payload.category).bind(payload.status).bind(payload.image).fetch_one(&mut *tx).await{Ok(v)=>v,Err(e)=>{if e.as_database_error().is_some_and(|x|x.is_unique_violation()){return status_message(axum::http::StatusCode::CONFLICT,"Slug artikel sudah digunakan");}return internal_error();}};let _=(actor,old_json);if tx.commit().await.is_err(){return internal_error();}Json(row_json(&row)).into_response()
}

pub async fn delete(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response {
 if let Err(r)=require_sql_permission(&headers,&state,"manageSettings").await{return r;}let Some(id)=article_uuid(id.trim())else{return internal_error()};let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};let image=match sqlx::query_scalar::<_,String>("SELECT image FROM content_articles WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Article not found"),Err(_)=>return internal_error()};if image.starts_with("/uploads/")&&release_reference(&mut tx,&image,&format!("articles:{id}:image")).await.is_err(){return unavailable();}if sqlx::query("DELETE FROM content_articles WHERE id=$1").bind(id).execute(&mut *tx).await.is_err()||tx.commit().await.is_err(){return internal_error()}Json(json!({"message":"Article deleted"})).into_response()
}

