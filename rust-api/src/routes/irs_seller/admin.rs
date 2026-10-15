use std::sync::Arc;
use axum::{extract::{Path, State}, http::HeaderMap, response::{IntoResponse, Response}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;
use crate::{security::require_proxy_context, state::AppState};
use super::{internal_error, status_message};
use super::types::{IrsAdminOrdersResponse, IrsLogItem};

pub async fn mappings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let rows = match sqlx::query("SELECT m.id::text AS id,m.product_id::text AS product_id,m.buyer_sku_code,m.enabled,m.data,m.updated_at FROM seller_mappings m WHERE m.channel='irs' ORDER BY m.updated_at DESC LIMIT 200").fetch_all(&state.pg_pool).await { Ok(rows)=>rows,Err(_)=>return internal_error() };
    Json(IrsMappingsResponse { items: rows.into_iter().map(|row| IrsMappingItem { id:row.get("id"),product_id:row.get("product_id"),pulsa_code:row.get("buyer_sku_code"),price:row.get::<Value,_>("data").get("price").and_then(Value::as_i64).unwrap_or_default(),seller_margin_flat:row.get::<Value,_>("data").get("sellerMarginFlat").and_then(Value::as_i64),is_active:row.get("enabled"),last_sync_status:row.get::<Value,_>("data").get("lastSyncStatus").and_then(Value::as_str).unwrap_or_default().to_string(),last_sync_rc:row.get::<Value,_>("data").get("lastSyncRc").and_then(Value::as_str).unwrap_or_default().to_string(),last_sync_message:row.get::<Value,_>("data").get("lastSyncMessage").and_then(Value::as_str).unwrap_or_default().to_string(),last_sync_at:row.get::<Value,_>("data").get("lastSyncAt").and_then(Value::as_str).map(str::to_owned),updated_at:row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339() }).collect() }).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct SaveIrsMappingPayload { product_id:Option<Value>, pulsa_code:Option<String>, price:Option<Value>, seller_margin_flat:Option<Value>, is_active:Option<bool> }

pub async fn save_mapping(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<SaveIrsMappingPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let product_id = payload.product_id.as_ref().and_then(|v|v.as_str().or_else(||v.get("_id").and_then(Value::as_str))).and_then(|v|Uuid::parse_str(v).ok());
    let Some(product_id)=product_id else{return status_message(axum::http::StatusCode::BAD_REQUEST,"Produk tidak valid")};
    let code=payload.pulsa_code.unwrap_or_default().trim().to_lowercase();
    if code.is_empty() || code.len()>100 || !code.chars().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||matches!(c,'.'|'_'|'-')) {return status_message(axum::http::StatusCode::BAD_REQUEST,"Pulsa code tidak valid")}
    let price=payload.price.as_ref().and_then(|v|v.as_i64().or_else(||v.as_str()?.parse::<i64>().ok())).unwrap_or(0);
    let margin=payload.seller_margin_flat.as_ref().and_then(|v|v.as_i64().or_else(||v.as_str()?.parse::<i64>().ok()));
    if price<0 || margin.is_some_and(|v|v<0) {return status_message(axum::http::StatusCode::BAD_REQUEST,"Harga mapping tidak valid")}
    let exists=match sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM products WHERE id=$1)").bind(product_id).fetch_one(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return internal_error()};
    if !exists{return status_message(axum::http::StatusCode::NOT_FOUND,"Produk tidak ditemukan")}
    let data=json!({"price":price,"sellerMarginFlat":margin});
    let saved=sqlx::query("INSERT INTO seller_mappings(channel,product_id,buyer_sku_code,enabled,data) VALUES('irs',$1,$2,$3,$4) ON CONFLICT(channel,product_id) DO UPDATE SET buyer_sku_code=EXCLUDED.buyer_sku_code,enabled=EXCLUDED.enabled,data=EXCLUDED.data,updated_at=now() RETURNING id::text AS id,updated_at")
        .bind(product_id).bind(&code).bind(payload.is_active.unwrap_or(true)).bind(data).fetch_one(&state.pg_pool).await;
    match saved {Ok(row)=>(axum::http::StatusCode::OK,Json(json!({"success":true,"message":"Mapping IRS Seller berhasil disimpan","mapping":{"id":row.get::<String,_>("id"),"productId":product_id.to_string(),"pulsaCode":code,"price":price,"sellerMarginFlat":margin,"isActive":payload.is_active.unwrap_or(true),"updatedAt":row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339()}}))).into_response(),Err(error) if error.as_database_error().is_some_and(|d|d.code().as_deref()==Some("23505"))=>status_message(axum::http::StatusCode::CONFLICT,"Pulsa code sudah dipakai produk lain"),Err(_)=>internal_error()}
}

pub async fn delete_mapping(headers: HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let Some(id)=Uuid::parse_str(&id).ok() else{return status_message(axum::http::StatusCode::NOT_FOUND,"Mapping tidak ditemukan")};
    match sqlx::query("DELETE FROM seller_mappings WHERE id=$1 AND channel='irs'").bind(id).execute(&state.pg_pool).await {Ok(result) if result.rows_affected()==1=>Json(json!({"success":true,"message":"Mapping IRS Seller berhasil dihapus"})).into_response(),Ok(_)=>status_message(axum::http::StatusCode::NOT_FOUND,"Mapping tidak ditemukan"),Err(_)=>internal_error()}
}

pub async fn admin_orders(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let rows = match sqlx::query("SELECT id::text AS id,reference_id,status,amount,customer_no,buyer_sku_code,snapshot,response,created_at,updated_at FROM seller_orders WHERE channel='irs' ORDER BY created_at DESC,id DESC LIMIT 100").fetch_all(&state.pg_pool).await { Ok(rows)=>rows,Err(_)=>return internal_error() };
    Json(IrsAdminOrdersResponse { items: rows.iter().map(irs_order_item).collect() }).into_response()
}
pub async fn logs(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let rows=match sqlx::query("SELECT id::text AS id,created_at,event,reference_id,status,message,verified,request_ip FROM seller_event_logs WHERE channel='irs' ORDER BY created_at DESC,id DESC LIMIT 100").fetch_all(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return internal_error()};
    Json(rows.iter().map(irs_log_item).collect::<Vec<IrsLogItem>>()).into_response()
}
#[derive(Serialize)] struct IrsMappingsResponse{items:Vec<IrsMappingItem>}
#[derive(Serialize)] struct IrsMappingItem{id:String,#[serde(rename="productId")]product_id:String,#[serde(rename="pulsaCode")]pulsa_code:String,price:i64,#[serde(rename="sellerMarginFlat")]seller_margin_flat:Option<i64>,#[serde(rename="isActive")]is_active:bool,#[serde(rename="lastSyncStatus")]last_sync_status:String,#[serde(rename="lastSyncRc")]last_sync_rc:String,#[serde(rename="lastSyncMessage")]last_sync_message:String,#[serde(rename="lastSyncAt")]last_sync_at:Option<String>,#[serde(rename="updatedAt")]updated_at:String}
fn irs_order_item(row:&sqlx::postgres::PgRow)->super::types::IrsAdminOrderItem{super::types::irs_admin_order_item_sql(row)}
fn irs_log_item(row:&sqlx::postgres::PgRow)->IrsLogItem{super::types::irs_log_item_sql(row)}
