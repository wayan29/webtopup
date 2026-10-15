use std::{collections::HashMap, sync::Arc};

use axum::{extract::{Path, Query, State}, http::StatusCode, response::{IntoResponse, Response}, Json};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_sql_permission, require_sql_user},
    services::idempotency::{self, ROUTE_BALANCE_ADJUST},
    state::AppState,
};
use super::{
    responses::{internal_error, not_found, status_message, unavailable},
    types::{AdjustmentActor, AdjustBalancePayload, BalanceAdjustmentItem, BalanceAdjustmentsResponse, BalanceHistoryItem, BalanceHistoryResponse},
    validation::{normalize_adjustment_amount, parse_positive_i64},
};

pub async fn me_balance_history(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let user = match require_sql_user(&headers, &state).await { Ok(user) => user, Err(response) => return response };
    let rows = match sqlx::query("SELECT id::text id, 'adjustment'::text kind, amount, reason description, id::text reference, created_at, balance_before, balance_after FROM user_balance_adjustments WHERE user_id=$1 UNION ALL SELECT id::text, kind, amount, source, source, created_at, NULL::bigint, balance_after FROM ledger_entries WHERE user_id=$1 AND kind <> 'adjustment' ORDER BY created_at DESC")
        .bind(user.id).fetch_all(&state.pg_pool).await { Ok(rows)=>rows, Err(_)=>return unavailable() };
    let items = rows.into_iter().map(|row| {
        let kind:String=row.get("kind"); let amount:i64=row.get("amount");
        BalanceHistoryItem { id:row.get("id"), source:if kind=="adjustment"{"balance_adjustment".into()}else{"ledger".into()}, item_type:kind, amount:amount as f64, description:row.get("description"), reference:row.get("reference"), created_at:date(row.get("created_at")), balance_before:row.try_get::<Option<i64>,_>("balance_before").ok().flatten().map(|v|v as f64), balance_after:row.try_get::<Option<i64>,_>("balance_after").ok().flatten().map(|v|v as f64), meta:None }
    }).collect();
    Json(BalanceHistoryResponse { items }).into_response()
}

pub async fn balance_adjustments(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(query): Query<HashMap<String,String>>) -> Response {
    if let Err(response)=require_sql_permission(&headers,&state,"viewUsers").await{return response;}
    let Ok(user_id)=Uuid::parse_str(id.trim()) else{return not_found("User member tidak ditemukan")};
    let limit=parse_positive_i64(query.get("limit"),10,50);
    let rows=match sqlx::query("SELECT a.id,a.user_id,a.actor_id,a.adjustment_type,a.amount,a.reason,a.balance_before,a.balance_after,a.created_at,u.name actor_name,u.email actor_email,u.role actor_role FROM user_balance_adjustments a JOIN users target ON target.id=a.user_id AND target.role='member' JOIN users u ON u.id=a.actor_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT $2")
        .bind(user_id).bind(limit).fetch_all(&state.pg_pool).await {Ok(rows)=>rows,Err(_)=>return unavailable()};
    Json(BalanceAdjustmentsResponse{items:rows.into_iter().map(|r|BalanceAdjustmentItem{id:r.get::<Uuid,_>("id").to_string(),user:Some(r.get::<Uuid,_>("user_id").to_string()),adjusted_by:Some(AdjustmentActor{id:r.get::<Uuid,_>("actor_id").to_string(),name:r.get("actor_name"),email:r.get("actor_email"),role:r.get("actor_role")}),adjustment_type:r.get("adjustment_type"),amount:r.get::<i64,_>("amount") as f64,balance_before:r.get::<i64,_>("balance_before") as f64,balance_after:r.get::<i64,_>("balance_after") as f64,reason:r.get("reason"),created_at:date(r.get("created_at")),updated_at:date(r.get("created_at"))}).collect()}).into_response()
}

pub async fn adjust_balance(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<AdjustBalancePayload>) -> Response {
    let proxy=match require_sql_permission(&headers,&state,"manageUsers").await{Ok(user)=>user,Err(response)=>return response};
    let actor=match require_sql_user(&headers,&state).await{Ok(user)=>user,Err(response)=>return response};
    if let Err(response)=require_trusted_step_up_group(&headers,"finance.adjust_balance"){return response;}
    let key=match idempotency::require_idempotency_key(&headers){Ok(key)=>key,Err(error)=>return error.into_response()};
    let Ok(user_id)=Uuid::parse_str(id.trim()) else{return status_message(StatusCode::BAD_REQUEST,"ID user tidak valid")};
    let amount=match normalize_adjustment_amount(payload.amount){Ok(value)=>value as i64,Err(response)=>return response};
    let adjustment_type=match payload.adjustment_type.as_deref().map(str::trim){Some("add")=>"add",Some("subtract")=>"subtract",_=>return status_message(StatusCode::BAD_REQUEST,"Tipe penyesuaian saldo tidak valid")};
    let reason=payload.reason.unwrap_or_default().trim().to_owned();
    if !(5..=300).contains(&reason.len()){return status_message(StatusCode::BAD_REQUEST,"Alasan penyesuaian saldo wajib 5-300 karakter");}
    let digest=idempotency::balance_adjust_digest(state.session_token_hash_secret.as_bytes(),&user_id.to_string(),adjustment_type,amount as f64,&reason);
    let mut tx=match state.pg_pool.begin().await{Ok(tx)=>tx,Err(_)=>return unavailable()};
    if let Some(key)=key.as_deref(){
        let existing=match sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation=$2 AND key=$3 FOR UPDATE").bind(actor.id.to_string()).bind(ROUTE_BALANCE_ADJUST).bind(key).fetch_optional(&mut *tx).await{Ok(value)=>value,Err(_)=>return internal_error()};
        if let Some(row)=existing{let old_digest:String=row.get("digest");if old_digest!=digest{return status_message(StatusCode::CONFLICT,"Idempotency key already used with a different request")};if let Some(body)=row.try_get::<Option<Value>,_>("response").ok().flatten(){let status=row.try_get::<Option<i32>,_>("response_status").ok().flatten().unwrap_or(200);return (StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK),Json(body)).into_response()}return status_message(StatusCode::CONFLICT,"Request with this idempotency key is in progress")}
        let inserted=match sqlx::query("INSERT INTO financial_requests(actor,operation,key,digest) VALUES($1,$2,$3,$4) ON CONFLICT(actor,operation,key) DO NOTHING").bind(proxy.id.to_string()).bind(ROUTE_BALANCE_ADJUST).bind(key).bind(&digest).execute(&mut *tx).await{Ok(result)=>result.rows_affected()==1,Err(_)=>return unavailable()};
        if !inserted {
            let row=match sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation=$2 AND key=$3 FOR UPDATE").bind(proxy.id.to_string()).bind(ROUTE_BALANCE_ADJUST).bind(key).fetch_optional(&mut *tx).await{Ok(Some(row))=>row,Ok(None)=>return unavailable(),Err(_)=>return internal_error()};
            if row.get::<String,_>("digest")!=digest{return status_message(StatusCode::CONFLICT,"Idempotency key already used with a different request")};
            if let Some(body)=row.try_get::<Option<Value>,_>("response").ok().flatten(){return (StatusCode::from_u16(row.try_get::<Option<i32>,_>("response_status").ok().flatten().unwrap_or(200) as u16).unwrap_or(StatusCode::OK),Json(body)).into_response()}
            return status_message(StatusCode::CONFLICT,"Request with this idempotency key is in progress");
        }
    }
    let target=match sqlx::query("SELECT id,name,email,role,active,level,balance,points,created_at,updated_at,EXISTS(SELECT 1 FROM open_api_credentials c WHERE c.user_id=users.id AND c.active) AS has_open_api_key FROM users WHERE id=$1 FOR UPDATE").bind(user_id).fetch_optional(&mut *tx).await{Ok(Some(row))=>row,Ok(None)=>return not_found("User member tidak ditemukan"),Err(_)=>return internal_error()};
    let role:String=target.get("role");if role!="member"{return not_found("User member tidak ditemukan")};
    let before:i64=target.get("balance");if adjustment_type=="subtract"&&before<amount{return status_message(StatusCode::BAD_REQUEST,"Saldo user tidak mencukupi untuk pengurangan ini")};
    let delta=if adjustment_type=="add"{amount}else{-amount};let after=match before.checked_add(delta){Some(value) if value>=0=>value,_=>return status_message(StatusCode::BAD_REQUEST,"Saldo user tidak bisa disesuaikan")};
    let updated=match sqlx::query("UPDATE users SET balance=$2,updated_at=now() WHERE id=$1 RETURNING updated_at").bind(user_id).bind(after).fetch_one(&mut *tx).await{Ok(row)=>row,Err(_)=>return internal_error()};let updated_at:DateTime<Utc>=updated.get("updated_at");
    let source=key.as_ref().map(|k|format!("balance-adjust:{}:{}",proxy.id,k)).unwrap_or_else(||format!("balance-adjust:{}",Uuid::new_v4()));
    if sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'adjustment',$3,$4,$5)").bind(user_id).bind(source).bind(if delta>0{1i16}else{-1i16}).bind(amount).bind(after).execute(&mut *tx).await.is_err(){return internal_error()};
    let adjustment_id=match sqlx::query_scalar::<_,Uuid>("INSERT INTO user_balance_adjustments(user_id,actor_id,adjustment_type,amount,reason,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id").bind(user_id).bind(proxy.id).bind(adjustment_type).bind(amount).bind(&reason).bind(before).bind(after).fetch_one(&mut *tx).await{Ok(id)=>id,Err(_)=>return internal_error()};
    if sqlx::query("INSERT INTO financial_audits(actor_id,action,subject_id,amount,operation_key) VALUES($1,$2,$3,$4,$5)").bind(proxy.id).bind(format!("balance_{adjustment_type}")).bind(user_id).bind(amount).bind(format!("balance-adjust:{}",adjustment_id)).execute(&mut *tx).await.is_err(){return internal_error()};
    let body=json!({"message":if adjustment_type=="add"{"Saldo user berhasil ditambahkan"}else{"Saldo user berhasil dikurangi"},"user":{"_id":user_id,"name":target.get::<String,_>("name"),"email":target.get::<String,_>("email"),"level":target.get::<String,_>("level"),"balance":after,"points":target.get::<i64,_>("points"),"active":target.get::<bool,_>("active"),"hasOpenApiKey":target.get::<bool,_>("has_open_api_key"),"createdAt":date(target.get("created_at")),"updatedAt":date(updated_at)},"audit":{"amount":amount,"type":adjustment_type,"reason":reason,"balanceBefore":before,"balanceAfter":after}});
    if let Some(key)=key.as_deref(){if sqlx::query("UPDATE financial_requests SET response=$4,response_status=200 WHERE actor=$1 AND operation=$2 AND key=$3").bind(proxy.id.to_string()).bind(ROUTE_BALANCE_ADJUST).bind(key).bind(&body).execute(&mut *tx).await.is_err(){return internal_error()}}
    match tx.commit().await{Ok(())=>(StatusCode::OK,Json(body)).into_response(),Err(_)=>{if let Some(key)=key.as_deref(){match sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation=$2 AND key=$3").bind(proxy.id.to_string()).bind(ROUTE_BALANCE_ADJUST).bind(key).fetch_optional(&state.pg_pool).await{Ok(Some(row)) if row.get::<String,_>("digest")==digest=>if let Some(body)=row.try_get::<Option<Value>,_>("response").ok().flatten(){return (StatusCode::from_u16(row.try_get::<Option<i32>,_>("response_status").ok().flatten().unwrap_or(200) as u16).unwrap_or(StatusCode::OK),Json(body)).into_response()},_=>{}}}unavailable()}}
}

fn date(value:DateTime<Utc>)->String{value.to_rfc3339()}
