use std::{str::FromStr, sync::Arc};

use axum::{extract::{Path, Query, State}, response::{IntoResponse, Response}, Json};
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, Row};
use uuid::Uuid;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    bool_from_value, internal_error, is_valid_pulsa_code, non_negative_i64,
    status_message, text_from_value, LimitPayload, MappingItem, MappingListMeta,
    MappingListResponse, MappingListSummary, MappingProductItem, MappingQuery, SaveMappingPayload,
    SaveMappingResponse, SavedMappingItem, SellerConfig, SellerMappingBulkSyncResponse,
    SellerMappingSyncItem, SellerMappingSyncResult,
};

pub async fn mappings(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<MappingQuery>) -> Response {
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    let config=super::seller_config(&state.pg_pool).await;
    let rows=match sqlx::query("SELECT p.id,p.name,p.code,p.status,p.price_basic,trunc(p.cost_price)::bigint AS cost_price,p.vendor_name,p.updated_at,COALESCE(c.name,p.category,'') AS category,COALESCE(o.name,p.brand,'') AS brand,m.id AS mapping_id,m.buyer_sku_code,m.enabled,m.data AS mapping_data,m.updated_at AS mapping_updated_at FROM products p LEFT JOIN operators o ON o.id=p.operator_id LEFT JOIN categories c ON c.id=o.category_id LEFT JOIN seller_mappings m ON m.channel='digiflazz' AND m.product_id=p.id ORDER BY p.updated_at DESC,p.name ASC").fetch_all(&state.pg_pool).await{Ok(rows)=>rows,Err(_)=>return internal_error()};
    let search=query.search.unwrap_or_default().trim().to_lowercase();
    let mapped_filter=query.mapped.unwrap_or_else(||"all".into()).trim().to_lowercase();
    let mut products=rows.into_iter().filter_map(|row|{
        let name=row.try_get::<String,_>("name").ok()?;let code=row.try_get::<String,_>("code").ok()?;let brand=row.try_get::<String,_>("brand").ok()?;let category=row.try_get::<String,_>("category").ok()?;
        if !search.is_empty() && ![&name,&code,&brand,&category].iter().any(|v|v.to_lowercase().contains(&search)){return None;}
        let item=mapping_product_from_row(&row,&config);
        let is_mapped=item.mapping.as_ref().is_some_and(|m|!m.id.is_empty());
        if mapped_filter=="mapped"&&!is_mapped || mapped_filter=="unmapped"&&is_mapped{return None;}
        Some(item)
    }).collect::<Vec<_>>();
    let total=products.len() as i64;let page=query.page.unwrap_or(1).clamp(1,100_000);let limit=query.limit.unwrap_or(20).clamp(1,100);let total_pages=if total==0{1}else{(total+limit-1)/limit};
    let mapped_products=products.iter().filter(|p|p.mapping.as_ref().is_some_and(|m|!m.id.is_empty())).count() as i64;
    let active_mappings=products.iter().filter(|p|p.mapping.as_ref().is_some_and(|m|m.is_active)).count() as i64;
    let start=((page-1)*limit) as usize;let items=if start<products.len(){let end=(start+limit as usize).min(products.len());products.drain(start..end).collect()}else{Vec::new()};
    Json(MappingListResponse{items,meta:MappingListMeta{page,limit,total,total_pages},summary:MappingListSummary{total_products:total,mapped_products,active_mappings}}).into_response()
}

pub async fn save_mapping(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<SaveMappingPayload>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    let product_id=payload.product_id.as_ref().map(text_from_value).and_then(|v|Uuid::from_str(&v).ok());let Some(product_id)=product_id else{return status_message(axum::http::StatusCode::BAD_REQUEST,"Produk tidak valid")};
    let pulsa_code=payload.pulsa_code.as_ref().map(text_from_value).unwrap_or_default().to_lowercase();if pulsa_code.is_empty()||!is_valid_pulsa_code(&pulsa_code){return status_message(axum::http::StatusCode::BAD_REQUEST,"Pulsa code wajib huruf kecil, angka, titik, underscore, atau dash");}
    let product=match sqlx::query("SELECT id,name,code,trunc(cost_price)::bigint AS cost_price,status FROM products WHERE id=$1").bind(product_id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>row,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Produk tidak ditemukan"),Err(_)=>return internal_error()};
    let existing=match sqlx::query("SELECT id,buyer_sku_code,enabled,data,updated_at FROM seller_mappings WHERE channel='digiflazz' AND product_id=$1").bind(product_id).fetch_optional(&state.pg_pool).await{Ok(value)=>value,Err(_)=>return internal_error()};
    let config=super::seller_config(&state.pg_pool).await;let cost=product.get::<i64,_>("cost_price").max(0);
    let old_data=existing.as_ref().map(|r|r.get::<Value,_>("data")).unwrap_or_else(||json!({}));
    let margin_supplied=payload.seller_margin_flat.as_ref().is_some_and(|v|!text_from_value(v).is_empty());let price_supplied=payload.price.as_ref().is_some_and(|v|!text_from_value(v).is_empty());
    let margin=if margin_supplied{Some(non_negative_i64(payload.seller_margin_flat.as_ref(),0))}else if price_supplied{Some((non_negative_i64(payload.price.as_ref(),0)-cost).max(0))}else{old_data.get("sellerMarginFlat").and_then(Value::as_i64)};
    let price=seller_recommended_price(cost,config.seller_margin_flat,margin);let enabled=bool_from_value(payload.is_active.as_ref()).unwrap_or_else(||existing.as_ref().map(|r|r.get::<bool,_>("enabled")).unwrap_or(true));
    let data=json!({"sellerMarginFlat":margin,"lastSyncStatus":old_data.get("lastSyncStatus").and_then(Value::as_str).unwrap_or("never"),"lastSyncRc":old_data.get("lastSyncRc").and_then(Value::as_str).unwrap_or(""),"lastSyncMessage":old_data.get("lastSyncMessage").and_then(Value::as_str).unwrap_or(""),"lastSyncAt":old_data.get("lastSyncAt").cloned().unwrap_or(Value::Null),"price":price});
    let saved=sqlx::query("INSERT INTO seller_mappings(channel,product_id,buyer_sku_code,enabled,data) VALUES('digiflazz',$1,$2,$3,$4) ON CONFLICT(channel,product_id) DO UPDATE SET buyer_sku_code=EXCLUDED.buyer_sku_code,enabled=EXCLUDED.enabled,data=EXCLUDED.data,updated_at=now() RETURNING id,buyer_sku_code,enabled,data,updated_at").bind(product_id).bind(&pulsa_code).bind(enabled).bind(&data).fetch_one(&state.pg_pool).await;
    let saved=match saved{Ok(row)=>row,Err(e) if e.as_database_error().is_some_and(|d|d.code().as_deref()==Some("23505"))=>return status_message(axum::http::StatusCode::CONFLICT,"Pulsa code sudah dipakai produk lain"),Err(_)=>return internal_error()};
    let margin=saved.get::<Value,_>("data").get("sellerMarginFlat").and_then(Value::as_i64);let map_data=saved.get::<Value,_>("data");
    Json(SaveMappingResponse{success:true,message:"Mapping Digiflazz Seller berhasil disimpan",mapping:SavedMappingItem{id:saved.get::<Uuid,_>("id").to_string(),product_id:product_id.to_string(),product_name:product.get("name"),product_code:product.get("code"),cost_price:cost,recommended_price:price,seller_margin_flat:margin,effective_margin_flat:effective_margin(config.seller_margin_flat,margin),pulsa_code:saved.get("buyer_sku_code"),price,is_active:saved.get("enabled"),last_sync_status:string_value(&map_data,"lastSyncStatus"),last_sync_rc:string_value(&map_data,"lastSyncRc"),last_sync_message:string_value(&map_data,"lastSyncMessage"),last_sync_at:date_value(&map_data,"lastSyncAt")},sync_result:None}).into_response()
}

pub async fn delete_mapping(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}let Some(id)=Uuid::parse_str(&id).ok()else{return status_message(axum::http::StatusCode::BAD_REQUEST,"Mapping tidak valid")};
    match sqlx::query("DELETE FROM seller_mappings WHERE id=$1 AND channel='digiflazz'").bind(id).execute(&state.pg_pool).await{Ok(r) if r.rows_affected()>0=>Json(json!({"success":true,"message":"Mapping Digiflazz Seller berhasil dihapus"})).into_response(),Ok(_)=>status_message(axum::http::StatusCode::NOT_FOUND,"Mapping tidak ditemukan"),Err(_)=>internal_error()}
}

pub async fn sync_mapping_by_id(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Path(id):Path<String>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}let Some(id)=Uuid::parse_str(&id).ok()else{return status_message(axum::http::StatusCode::BAD_REQUEST,"Mapping tidak valid")};
    let row=match sqlx::query("SELECT m.id,m.product_id,m.buyer_sku_code,m.enabled,m.data,trunc(p.cost_price)::bigint AS cost_price FROM seller_mappings m JOIN products p ON p.id=m.product_id WHERE m.id=$1 AND m.channel='digiflazz'").bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>row,Ok(None)=>return status_message(axum::http::StatusCode::NOT_FOUND,"Mapping tidak ditemukan"),Err(_)=>return internal_error()};
    match sync_seller_product_mapping(&state.pg_pool,&row).await{Ok(result)=>Json(result).into_response(),Err(SyncMappingError::CredentialsRequired)=>status_message(axum::http::StatusCode::BAD_REQUEST,"Konfigurasi Digiflazz Seller belum lengkap"),Err(SyncMappingError::Database)=>internal_error()}
}

pub async fn sync_all_mappings(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<LimitPayload>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}let limit=non_negative_i64(payload.limit.as_ref(),50).clamp(1,60);
    let rows=match sqlx::query("SELECT m.id,m.product_id,m.buyer_sku_code,m.enabled,m.data,p.cost_price FROM seller_mappings m JOIN products p ON p.id=m.product_id WHERE m.channel='digiflazz' ORDER BY m.updated_at DESC LIMIT $1").bind(limit).fetch_all(&state.pg_pool).await{Ok(rows)=>rows,Err(_)=>return internal_error()};
    let mut results=Vec::new();for row in rows{let id=row.get::<Uuid,_>("id").to_string();let pulsa_code=row.get::<String,_>("buyer_sku_code");match sync_seller_product_mapping(&state.pg_pool,&row).await{Ok(r)=>results.push(SellerMappingSyncItem{id,pulsa_code,success:r.success,rc:r.rc,message:r.message}),Err(SyncMappingError::CredentialsRequired)=>return status_message(axum::http::StatusCode::BAD_REQUEST,"Konfigurasi Digiflazz Seller belum lengkap"),Err(SyncMappingError::Database)=>return internal_error()}}
    let success_count=results.iter().filter(|item|item.success).count();Json(SellerMappingBulkSyncResponse{success:true,total:results.len(),success_count,failed_count:results.len().saturating_sub(success_count),results}).into_response()
}

#[derive(Debug)]pub(super) enum SyncMappingError{CredentialsRequired,Database}
pub(super) async fn sync_seller_product_mapping(pool:&sqlx::PgPool,mapping:&PgRow)->Result<SellerMappingSyncResult,SyncMappingError>{
    let config=super::seller_config(pool).await;if config.username.is_empty()||config.api_key.is_empty(){return Err(SyncMappingError::CredentialsRequired)}
    let cost=mapping.get::<i64,_>("cost_price").max(0);let data=mapping.get::<Value,_>("data");let margin=data.get("sellerMarginFlat").and_then(Value::as_i64);let price=seller_recommended_price(cost,config.seller_margin_flat,margin);let code=mapping.get::<String,_>("buyer_sku_code");let enabled=mapping.get::<bool,_>("enabled");
    let sign=format!("{:x}",md5::compute(format!("{}{}{}update_product",config.username,code,config.api_key)));
    let result=match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|_|SyncMappingError::Database)?.post("https://api.digiflazz.com/v1/seller/api/prepaid/product/update").json(&json!({"username":config.username,"pulsa_code":code,"price":price,"status":if enabled{1}else{0},"sign":sign})).send().await{
        Ok(response)=>{let body=response.json::<Value>().await.unwrap_or_default();let item=body.get("data").unwrap_or(&Value::Null);let rc=item.get("rc").and_then(Value::as_str).unwrap_or("00").trim().to_string();let message=item.get("message").and_then(Value::as_str).unwrap_or("Success").trim().to_string();SellerMappingSyncResult{success:rc=="00",rc,message}},Err(error)=>SellerMappingSyncResult{success:false,rc:"07".into(),message:error.to_string()}};
    let status=if result.success{"success"}else{"failed"};let mut update=data;update["price"]=json!(price);update["lastSyncStatus"]=json!(status);update["lastSyncRc"]=json!(result.rc);update["lastSyncMessage"]=json!(result.message);update["lastSyncAt"]=json!(chrono::Utc::now().to_rfc3339());
    if sqlx::query("UPDATE seller_mappings SET data=$2,updated_at=now() WHERE id=$1 AND channel='digiflazz'").bind(mapping.get::<Uuid,_>("id")).bind(update).execute(pool).await.is_err(){return Err(SyncMappingError::Database)}Ok(result)
}

fn mapping_product_from_row(row:&PgRow,config:&SellerConfig)->MappingProductItem{
    let id=row.get::<Uuid,_>("id");let cost=row.get::<i64,_>("cost_price").max(0);
    let mapping=if let Ok(mapping_id)=row.try_get::<Uuid,_>("mapping_id"){let data=row.get::<Value,_>("mapping_data");let margin=data.get("sellerMarginFlat").and_then(Value::as_i64);Some(MappingItem{id:mapping_id.to_string(),pulsa_code:row.get("buyer_sku_code"),price:seller_recommended_price(cost,config.seller_margin_flat,margin),seller_margin_flat:margin,effective_margin_flat:effective_margin(config.seller_margin_flat,margin),is_active:row.get("enabled"),last_sync_status:string_value(&data,"lastSyncStatus"),last_sync_rc:string_value(&data,"lastSyncRc"),last_sync_message:string_value(&data,"lastSyncMessage"),last_sync_at:date_value(&data,"lastSyncAt"),updated_at:row.try_get::<chrono::DateTime<chrono::Utc>,_>("mapping_updated_at").map(|d|d.to_rfc3339()).unwrap_or_default()})}else{None};
    MappingProductItem{id:id.to_string(),name:row.get("name"),code:row.get("code"),brand:row.get("brand"),category:row.get("category"),status:row.get("status"),vendor:row.get("vendor_name"),price:row.get("price_basic"),cost_price:cost,recommended_price:seller_recommended_price(cost,config.seller_margin_flat,None),updated_at:row.try_get::<chrono::DateTime<chrono::Utc>,_>("updated_at").map(|d|d.to_rfc3339()).unwrap_or_default(),mapping}
}
pub(super) fn seller_recommended_price(cost:i64,default:i64,override_margin:Option<i64>)->i64{cost.saturating_add(effective_margin(default,override_margin))}
fn effective_margin(default:i64,custom:Option<i64>)->i64{custom.unwrap_or(default).max(0)}
fn string_value(value:&Value,key:&str)->String{value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()}
fn date_value(value:&Value,key:&str)->Option<String>{value.get(key).and_then(Value::as_str).filter(|s|!s.is_empty()).map(str::to_string)}
