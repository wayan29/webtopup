use std::sync::Arc;

use axum::{extract::{Path, State}, response::{IntoResponse, Response}, Json};
use chrono::Utc;
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState, utils::dates::timestamp_now};

use super::{builders::{build_notifications, category_counts, notification_stats}, responses::status_message, types::{MarkAllReadResponse, NotificationListResponse, NotificationStatePayload, NotificationStateResponse, NotificationSummaryResponse}};

pub async fn admin_summary(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let context = match require_proxy_context(&headers, &state) { Ok(v)=>v, Err(r)=>return r };
    let notifications = match build_notifications(&state.pg_pool).await { Ok(v)=>v, Err(_)=>return unavailable() };
    let visible = apply_user_state(&state.pg_pool, context.user_id.as_deref(), notifications).await;
    let categories = category_counts(&visible);
    let stats = notification_stats(&visible);
    Json(NotificationSummaryResponse { ok:true, service:"webtopup-api-v2", api_prefix:"/v2", generated_at:timestamp_now(), source:"postgresql-snapshot", user:context.into_response(), total:stats.total, unread:stats.unread, critical:stats.critical, warning:stats.warning, info:stats.info, categories, top:visible.into_iter().take(5).collect() }).into_response()
}

pub async fn admin_list(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let context = match require_proxy_context(&headers, &state) { Ok(v)=>v, Err(r)=>return r };
    let notifications = match build_notifications(&state.pg_pool).await { Ok(v)=>v, Err(_)=>return unavailable() };
    let visible = apply_user_state(&state.pg_pool, context.user_id.as_deref(), notifications).await;
    let stats = notification_stats(&visible);
    Json(NotificationListResponse { generated_at:timestamp_now(), total:stats.total, unread:stats.unread, critical:stats.critical, warning:stats.warning, info:stats.info, notifications:visible }).into_response()
}

pub async fn mark_read(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<NotificationStatePayload>) -> Response { update_notification_state(headers,state,id,payload,false).await }
pub async fn dismiss(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<NotificationStatePayload>) -> Response { update_notification_state(headers,state,id,payload,true).await }

pub async fn mark_all_read(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let context = match require_proxy_context(&headers,&state) { Ok(v)=>v,Err(r)=>return r };
    let Some(actor)=context.user_id.as_deref().and_then(|v|uuid::Uuid::parse_str(v).ok()) else { return status_message(axum::http::StatusCode::UNAUTHORIZED,"Unauthorized") };
    let notifications=match build_notifications(&state.pg_pool).await { Ok(v)=>v,Err(_)=>return unavailable() };
    let actor_text=actor.to_string();
    let visible=apply_user_state(&state.pg_pool,Some(&actor_text),notifications).await;
    let mut tx=match state.pg_pool.begin().await {Ok(tx)=>tx,Err(_)=>return unavailable()};
    let mut updated=0;
    for item in visible {
        if sqlx::query("INSERT INTO notification_user_states(actor_id,notification_id,fingerprint,read_at) VALUES($1,$2,$3,now()) ON CONFLICT(actor_id,notification_id,fingerprint) DO UPDATE SET read_at=COALESCE(notification_user_states.read_at,now())")
            .bind(actor).bind(item.id).bind(item.fingerprint).execute(&mut *tx).await.is_err() { return unavailable() }
        updated+=1;
    }
    if tx.commit().await.is_err() { return unavailable() }
    Json(MarkAllReadResponse{success:true,updated}).into_response()
}

async fn update_notification_state(headers:axum::http::HeaderMap,state:Arc<AppState>,id:String,payload:NotificationStatePayload,dismiss:bool)->Response {
    let context=match require_proxy_context(&headers,&state){Ok(v)=>v,Err(r)=>return r};
    let Some(actor)=context.user_id.as_deref().and_then(|v|uuid::Uuid::parse_str(v).ok()) else {return status_message(axum::http::StatusCode::UNAUTHORIZED,"Unauthorized")};
    let id=id.trim().to_string(); let fingerprint=payload.fingerprint.unwrap_or_default().trim().to_string();
    if id.is_empty()||fingerprint.is_empty(){return status_message(axum::http::StatusCode::BAD_REQUEST,"Notifikasi tidak valid")}
    let notifications=match build_notifications(&state.pg_pool).await {Ok(v)=>v,Err(_)=>return unavailable()};
    if !notifications.iter().any(|n|n.id==id&&n.fingerprint==fingerprint){return status_message(axum::http::StatusCode::BAD_REQUEST,"Notifikasi sudah berubah atau tidak aktif. Segarkan halaman lalu coba lagi.")}
    let result=if dismiss {sqlx::query("INSERT INTO notification_user_states(actor_id,notification_id,fingerprint,read_at,dismissed_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(actor_id,notification_id,fingerprint) DO UPDATE SET read_at=COALESCE(notification_user_states.read_at,now()),dismissed_at=COALESCE(notification_user_states.dismissed_at,now())").bind(actor).bind(id).bind(fingerprint).execute(&state.pg_pool).await}
    else {sqlx::query("INSERT INTO notification_user_states(actor_id,notification_id,fingerprint,read_at) VALUES($1,$2,$3,now()) ON CONFLICT(actor_id,notification_id,fingerprint) DO UPDATE SET read_at=COALESCE(notification_user_states.read_at,now())").bind(actor).bind(id).bind(fingerprint).execute(&state.pg_pool).await};
    match result {Ok(_)=>Json(NotificationStateResponse{success:true}).into_response(),Err(_)=>unavailable()}
}

async fn apply_user_state(pool:&sqlx::PgPool,user_id:Option<&str>,notifications:Vec<super::types::AdminNotificationItem>)->Vec<super::types::AdminNotificationItem>{
    let Some(actor)=user_id.and_then(|v|uuid::Uuid::parse_str(v).ok()) else{return notifications};
    let ids=notifications.iter().map(|n|n.id).collect::<Vec<_>>();
    if ids.is_empty(){return notifications}
    let states=sqlx::query("SELECT notification_id,fingerprint,read_at,dismissed_at FROM notification_user_states WHERE actor_id=$1 AND notification_id=ANY($2)")
        .bind(actor).bind(&ids).fetch_all(pool).await.unwrap_or_default();
    let mut map=std::collections::HashMap::new();
    for row in states { let id:String=row.get("notification_id");let fp:String=row.get("fingerprint");let read:Option<chrono::DateTime<Utc>>=row.get("read_at");let dismissed:Option<chrono::DateTime<Utc>>=row.get("dismissed_at");map.insert((id,fp),(read,dismissed)); }
    notifications.into_iter().filter_map(|mut item| {if let Some((read,dismissed))=map.get(&(item.id.to_string(),item.fingerprint.clone())) {if dismissed.is_some(){return None} item.read_at=read.map(|v|v.to_rfc3339());item.dismissed_at=dismissed.map(|v|v.to_rfc3339());item.unread=read.is_none();}Some(item)}).collect()
}

fn unavailable()->Response{status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE,"SQL notification store is unavailable")}
