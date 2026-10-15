use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;
use serde_json::Value;

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    services::seller_secrecy,
};

const SELLER_ORDER_EXPORT_LIMIT: i64 = 5000;

mod callbacks;
mod center;
mod logs;
mod mappings;
mod prepaid;
mod scheduler;
mod settings;
mod types;
mod utils;

use callbacks::*;
pub use center::center_summary;
pub use logs::logs;
pub use mappings::{delete_mapping, mappings, save_mapping, sync_all_mappings, sync_mapping_by_id};
pub use prepaid::prepaid;
pub use scheduler::scheduler_config;
use settings::seller_config;
pub use settings::{save_settings, settings};
use types::*;
use utils::*;

const RETRY_HEALTH_KEY: &str = "digiflazz_retry_health";

pub async fn retry_callback(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let order = match sqlx::query("SELECT to_jsonb(o) || jsonb_build_object('callback_attempt_count', c.attempt_count, 'callback_delivered_at', c.delivered_at, 'callback_next_retry_at', c.next_retry_at, 'callback_last_attempt_at', c.last_attempt_at, 'callback_last_status_code', c.last_status_code, 'callback_last_message', c.last_error) AS data FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.id::text=$1 OR o.reference_id=$1 ORDER BY o.created_at DESC LIMIT 1")
        .bind(&id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => row.try_get::<Value,_>("data").unwrap_or_default(),
        Ok(None) => return status_message(StatusCode::NOT_FOUND, "Order tidak ditemukan"),
        Err(_) => return internal_error(),
    };
    Json(send_seller_callback(&state, &order).await).into_response()
}

pub async fn retry_pending_callbacks(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<LimitPayload>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let limit = parse_limit_value(payload.limit.as_ref(), 25, 50);
    let rows = match sqlx::query("SELECT to_jsonb(o) || jsonb_build_object('callback_attempt_count',c.attempt_count,'callback_delivered_at',c.delivered_at,'callback_next_retry_at',c.next_retry_at,'callback_last_attempt_at',c.last_attempt_at,'callback_last_status_code',c.last_status_code,'callback_last_message',c.last_error) AS data FROM seller_orders o JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz' AND o.status<>'pending' AND c.delivered_at IS NULL ORDER BY o.updated_at LIMIT $1")
        .bind(limit).fetch_all(&state.pg_pool).await { Ok(rows)=>rows, Err(_)=>return internal_error() };
    let orders=rows.into_iter().filter_map(|r| r.try_get::<Value,_>("data").ok()).collect();
    Json(callback_retry_response(&state, orders).await).into_response()
}

pub async fn process_due_callback_retries(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<LimitPayload>) -> Response {
    if let Err(response)=require_proxy_context(&headers,&state){return response;} process_due_callback_retries_inner(&state,payload,"admin").await
}
pub async fn process_due_callback_retries_scheduler(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<LimitPayload>) -> Response {
    let configured=std::env::var("DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN").unwrap_or_default();
    let provided=headers.get("x-scheduler-token").and_then(|v|v.to_str().ok()).unwrap_or("");
    if configured.trim().len()<16 || provided.trim()!=configured.trim(){return (StatusCode::UNAUTHORIZED,Json(ErrorResponse{message:"Unauthorized scheduler token"})).into_response();}
    process_due_callback_retries_inner(&state,payload,"scheduler").await
}
async fn process_due_callback_retries_inner(state:&AppState,payload:LimitPayload,source:&str)->Response {
    let limit=parse_limit_value(payload.limit.as_ref(),20,50);
    let rows=match sqlx::query("SELECT to_jsonb(o) || jsonb_build_object('callback_attempt_count',c.attempt_count,'callback_delivered_at',c.delivered_at,'callback_next_retry_at',c.next_retry_at,'callback_last_attempt_at',c.last_attempt_at,'callback_last_status_code',c.last_status_code,'callback_last_message',c.last_error) AS data FROM seller_orders o JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz' AND c.delivered_at IS NULL AND c.next_retry_at<=now() ORDER BY c.next_retry_at,o.updated_at LIMIT $1").bind(limit).fetch_all(&state.pg_pool).await {Ok(r)=>r,Err(_)=>return internal_error()};
    let orders=rows.into_iter().filter_map(|r|r.try_get::<Value,_>("data").ok()).collect();
    let result=callback_retry_response(state,orders).await;
    let remaining=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM seller_callbacks WHERE channel='digiflazz' AND delivered_at IS NULL AND next_retry_at<=now()").fetch_one(&state.pg_pool).await.unwrap_or(0);
    let last_error=if result.failed_count>0{format!("{} callback gagal diproses",result.failed_count)}else{String::new()};
    let health=save_retry_queue_health(state,source,result.processed as i64,result.success_count as i64,result.failed_count as i64,remaining,&last_error).await;
    Json(SellerCallbackDueRetryResponse{processed:result.processed,success_count:result.success_count,failed_count:result.failed_count,remaining_due:remaining,health,results:result.results}).into_response()
}

pub async fn process_sql_seller_callbacks(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Json(payload):Json<LimitPayload>)->Response{process_due_callback_retries_scheduler(headers,State(state),Json(payload)).await}
pub async fn claim_seller_callback(State(state):State<Arc<AppState>>,axum::extract::Path((channel,ref_id)):axum::extract::Path<(String,String)>)->Response{sql_seller_claim(&state,&channel,&ref_id,false).await}
pub async fn fail_seller_callback(State(state):State<Arc<AppState>>,axum::extract::Path((channel,ref_id)):axum::extract::Path<(String,String)>)->Response{sql_seller_claim(&state,&channel,&ref_id,true).await}
async fn sql_seller_claim(state:&AppState,channel:&str,ref_id:&str,fail:bool)->Response{
    let sql=if fail{"UPDATE seller_callbacks SET delivered_at=now(),last_error='failed',lease_token=NULL,lease_until=NULL WHERE channel=$1 AND ref_id=$2 AND delivered_at IS NULL RETURNING ref_id"}else{"UPDATE seller_callbacks SET lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' WHERE channel=$1 AND ref_id=$2 AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until<now()) RETURNING ref_id"};
    match sqlx::query(sql).bind(channel).bind(ref_id).fetch_optional(&state.pg_pool).await{Ok(Some(_))=>Json(serde_json::json!({"status":if fail{"failed"}else{"claimed"}})).into_response(),Ok(None)=>status_conflict(),Err(_)=>internal_error()}
}
fn status_conflict()->Response{(StatusCode::CONFLICT,Json(serde_json::json!({"message":"Seller ref already claimed"}))).into_response()}

async fn callback_retry_response(state:&AppState,orders:Vec<Value>)->SellerCallbackRetryResponse{
    let mut results=Vec::with_capacity(orders.len());
    for order in orders {let id=order.get("id").and_then(Value::as_str).unwrap_or_default().to_string();let ref_id=order.get("reference_id").and_then(Value::as_str).unwrap_or_default().to_string();let action=send_seller_callback(state,&order).await;
    let next=sqlx::query_scalar::<_,Option<chrono::DateTime<chrono::Utc>>>("SELECT next_retry_at FROM seller_callbacks WHERE channel='digiflazz' AND ref_id=$1").bind(&ref_id).fetch_optional(&state.pg_pool).await.ok().flatten().flatten().map(|d|d.to_rfc3339());
    results.push(SellerCallbackRetryItem{order_id:id,ref_id,success:action.success,message:action.message,next_retry_at:next});}
    let success_count=results.iter().filter(|r|r.success).count();SellerCallbackRetryResponse{processed:results.len(),success_count,failed_count:results.len()-success_count,results}
}
async fn save_retry_queue_health(state:&AppState,source:&str,processed:i64,success_count:i64,failed_count:i64,remaining_due:i64,last_error:&str)->RetryQueueHealth{
    let status=if failed_count>0{"partial"}else{"success"};let now=chrono::Utc::now();
    let data=serde_json::json!({"status":status,"source":source,"lastRunAt":now.to_rfc3339(),"processed":processed,"successCount":success_count,"failedCount":failed_count,"remainingDue":remaining_due,"lastError":last_error});
    let _=sqlx::query("INSERT INTO seller_settings(channel,data) VALUES($1,$2) ON CONFLICT(channel) DO UPDATE SET data=seller_settings.data || EXCLUDED.data").bind("digiflazz_retry_health").bind(&data).execute(&state.pg_pool).await;
    RetryQueueHealth{status:status.into(),source:source.into(),last_run_at:Some(now.to_rfc3339()),processed,success_count,failed_count,remaining_due,last_error:last_error.into()}
}
fn parse_limit_value(value:Option<&Value>,fallback:i64,max:i64)->i64{value.and_then(|v|v.as_i64().or_else(||v.as_str()?.parse().ok())).filter(|v|*v>0).map(|v|v.min(max)).unwrap_or(fallback)}

pub async fn orders(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    let rows=match sqlx::query("SELECT to_jsonb(o)||jsonb_build_object('callback_attempt_count',c.attempt_count,'callback_delivered_at',c.delivered_at,'callback_next_retry_at',c.next_retry_at,'callback_last_attempt_at',c.last_attempt_at,'callback_last_status_code',c.last_status_code,'callback_last_message',c.last_error) AS data FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz' ORDER BY o.created_at DESC LIMIT 50").fetch_all(&state.pg_pool).await{Ok(r)=>r,Err(_)=>return internal_error()};
    let items=rows.into_iter().filter_map(|r|r.try_get::<Value,_>("data").ok()).map(seller_order_from_value).collect::<Vec<_>>();Json(items).into_response()
}
pub async fn admin_orders(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Query(query):Query<HashMap<String,String>>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}
    let (where_sql,binds)=match build_admin_orders_filter(&query){Ok(v)=>v,Err(r)=>return r};
    let page=parse_positive_i64(query.get("page"),1,100_000);let limit=parse_positive_i64(query.get("limit"),20,100);let offset=(page-1)*limit;
    let sql=format!("SELECT to_jsonb(o)||jsonb_build_object('callback_attempt_count',c.attempt_count,'callback_delivered_at',c.delivered_at,'callback_next_retry_at',c.next_retry_at,'callback_last_attempt_at',c.last_attempt_at,'callback_last_status_code',c.last_status_code,'callback_last_message',c.last_error,'product_data',jsonb_build_object('id',p.id,'name',p.name,'code',p.code,'brand',p.brand,'category',cat.name,'active',true,'vendor_name',o.snapshot->>'vendorName','vendor_sku',o.snapshot->>'vendorSku')) AS data FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id LEFT JOIN products p ON p.id=o.product_id LEFT JOIN operators op ON op.id=p.operator_id LEFT JOIN categories cat ON cat.id=op.category_id WHERE o.channel='digiflazz' AND {where_sql} ORDER BY o.created_at DESC LIMIT ${} OFFSET ${}",binds.len()+1,binds.len()+2);
    let mut q=sqlx::query(&sql);for b in &binds{q=q.bind(b);}let rows=match q.bind(limit).bind(offset).fetch_all(&state.pg_pool).await{Ok(r)=>r,Err(_)=>return internal_error()};
    let count_sql=format!("SELECT count(*)::bigint total,count(*) FILTER(WHERE o.status='pending')::bigint pending,count(*) FILTER(WHERE o.status='success')::bigint success,count(*) FILTER(WHERE o.status='failed')::bigint failed,count(*) FILTER(WHERE c.delivered_at IS NULL)::bigint callback_pending,count(*) FILTER(WHERE c.delivered_at IS NULL AND c.next_retry_at<=now())::bigint callback_due_retry,coalesce(sum(o.amount),0)::bigint amount_total FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id LEFT JOIN products p ON p.id=o.product_id LEFT JOIN operators op ON op.id=p.operator_id LEFT JOIN categories cat ON cat.id=op.category_id WHERE o.channel='digiflazz' AND {where_sql}");
    let mut q=sqlx::query(&count_sql);for b in &binds{q=q.bind(b);}let summary=match q.fetch_one(&state.pg_pool).await{Ok(r)=>SellerAdminOrdersSummary{total:r.try_get("total").unwrap_or(0),pending:r.try_get("pending").unwrap_or(0),success:r.try_get("success").unwrap_or(0),failed:r.try_get("failed").unwrap_or(0),callback_pending:r.try_get("callback_pending").unwrap_or(0),callback_due_retry:r.try_get("callback_due_retry").unwrap_or(0),amount_total:r.try_get("amount_total").unwrap_or(0)},Err(_)=>return internal_error()};
    let total_pages=if summary.total>0{(summary.total+limit-1)/limit}else{1};Json(SellerAdminOrdersResponse{items:rows.into_iter().filter_map(|r|r.try_get::<Value,_>("data").ok()).map(seller_admin_order_from_value).collect(),meta:SellerAdminOrdersMeta{page,limit,total:summary.total,total_pages},summary}).into_response()
}
pub async fn admin_orders_export(headers:axum::http::HeaderMap,State(state):State<Arc<AppState>>,Query(query):Query<HashMap<String,String>>)->Response{
    if let Err(response)=require_proxy_context(&headers,&state){return response;}let(where_sql,binds)=match build_admin_orders_filter(&query){Ok(v)=>v,Err(r)=>return r};
    let sql=format!("SELECT to_jsonb(o)||jsonb_build_object('callback_attempt_count',c.attempt_count,'callback_delivered_at',c.delivered_at,'callback_next_retry_at',c.next_retry_at,'callback_last_attempt_at',c.last_attempt_at,'callback_last_status_code',c.last_status_code,'callback_last_message',c.last_error,'product_data',jsonb_build_object('id',p.id,'name',p.name,'code',p.code,'brand',p.brand,'category',cat.name,'active',true,'vendor_name',o.snapshot->>'vendorName','vendor_sku',o.snapshot->>'vendorSku')) AS data FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id LEFT JOIN products p ON p.id=o.product_id LEFT JOIN operators op ON op.id=p.operator_id LEFT JOIN categories cat ON cat.id=op.category_id WHERE o.channel='digiflazz' AND {where_sql} ORDER BY o.created_at DESC LIMIT {SELLER_ORDER_EXPORT_LIMIT}");let mut q=sqlx::query(&sql);for b in &binds{q=q.bind(b);}let rows=match q.fetch_all(&state.pg_pool).await{Ok(r)=>r,Err(_)=>return internal_error()};let items=rows.into_iter().filter_map(|r|r.try_get::<Value,_>("data").ok()).map(seller_admin_order_from_value).collect::<Vec<_>>();let csv=build_seller_orders_csv(&items);let mut h=HeaderMap::new();h.insert(header::CONTENT_TYPE,HeaderValue::from_static("text/csv; charset=utf-8"));let filename=format!("digiflazz-seller-orders-{}.csv",chrono::Utc::now().format("%Y%m%d"));if let Ok(v)=HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")){h.insert(header::CONTENT_DISPOSITION,v);}(StatusCode::OK,h,format!("\u{FEFF}{csv}")).into_response()
}
fn build_admin_orders_filter(query:&HashMap<String,String>)->Result<(String,Vec<String>),Response>{
    let mut clauses=Vec::new();let mut binds=Vec::new();let status=query.get("status").map(|s|s.trim()).unwrap_or("");if !status.is_empty(){if !matches!(status,"pending"|"success"|"failed"){return Err(status_message(StatusCode::BAD_REQUEST,"Status transaksi seller tidak valid"));}binds.push(status.to_owned());clauses.push(format!("o.status=${}",binds.len()));}
    let callback=query.get("callback").map(|s|s.trim()).unwrap_or("");if !callback.is_empty()&&!matches!(callback,"pending"|"due"|"delivered"){return Err(status_message(StatusCode::BAD_REQUEST,"Filter callback seller tidak valid"));}match callback{"pending"=>clauses.push("c.delivered_at IS NULL".into()),"due"=>clauses.push("c.delivered_at IS NULL AND c.next_retry_at<=now()".into()),"delivered"=>clauses.push("c.delivered_at IS NOT NULL".into()),_=>()}
    if let Some(s)=query.get("startDate").filter(|s|!s.trim().is_empty()){let d=chrono::NaiveDate::parse_from_str(s.trim(),"%Y-%m-%d").map_err(|_|status_message(StatusCode::BAD_REQUEST,"Format tanggal transaksi seller tidak valid"))?;binds.push(d.and_hms_opt(0,0,0).unwrap().and_utc().to_rfc3339());clauses.push(format!("o.created_at>=${}::timestamptz",binds.len()));}if let Some(s)=query.get("endDate").filter(|s|!s.trim().is_empty()){let d=chrono::NaiveDate::parse_from_str(s.trim(),"%Y-%m-%d").map_err(|_|status_message(StatusCode::BAD_REQUEST,"Format tanggal transaksi seller tidak valid"))?;binds.push((d+chrono::Duration::days(1)).and_hms_opt(0,0,0).unwrap().and_utc().to_rfc3339());clauses.push(format!("o.created_at<${}::timestamptz",binds.len()));}
    if let Some(keyword)=query.get("search").map(|s|s.trim()).filter(|s|!s.is_empty()){binds.push(format!("%{}%",keyword.replace('%',"\\%").replace('_',"\\_")));let p=binds.len();clauses.push(format!("(o.reference_id ILIKE ${p} OR o.snapshot->>'trId' ILIKE ${p} OR o.buyer_sku_code ILIKE ${p} OR o.customer_no ILIKE ${p} OR o.vendor_reference ILIKE ${p} OR o.snapshot::text ILIKE ${p} OR p.name ILIKE ${p} OR p.code ILIKE ${p} OR p.id::text ILIKE ${p} OR cat.name ILIKE ${p})"));}
    Ok((if clauses.is_empty(){"true".into()}else{clauses.join(" AND ")},binds))
}
fn parse_positive_i64(value:Option<&String>,fallback:i64,max:i64)->i64{value.and_then(|v|v.parse::<f64>().ok()).filter(|v|v.is_finite()&&*v>0.0).map(|v|(v.floor() as i64).min(max)).unwrap_or(fallback)}
fn seller_admin_order_from_value(v:Value)->SellerAdminOrderItem{let get=|k:&str|v.get(k);let text=|k:&str|get(k).and_then(Value::as_str).unwrap_or("").to_string();let prod=get("product_data").filter(|p|p.get("id").is_some_and(|x|!x.is_null())).map(|p|SellerAdminOrderProduct{id:p["id"].as_str().unwrap_or("").into(),name:p["name"].as_str().unwrap_or("").into(),code:p["code"].as_str().unwrap_or("").into(),brand:p["brand"].as_str().unwrap_or("").into(),category:p["category"].as_str().unwrap_or("").into(),vendor_name:p["vendor_name"].as_str().unwrap_or("").into(),vendor_sku:p["vendor_sku"].as_str().unwrap_or("").into(),active:true});SellerAdminOrderItem{id:text("id"),ref_id:text("reference_id"),tr_id:v["snapshot"]["trId"].as_str().unwrap_or("").into(),pulsa_code:text("buyer_sku_code"),target:text("customer_no"),price:v["amount"].as_i64().unwrap_or(0),status:text("status"),rc:v["response"]["data"]["rc"].as_str().unwrap_or("").into(),message:v["response"]["data"]["message"].as_str().unwrap_or("").into(),sn:v["response"]["data"]["sn"].as_str().unwrap_or("").into(),vendor_name:v["snapshot"]["vendorName"].as_str().unwrap_or("").into(),vendor_sku:v["snapshot"]["vendorSku"].as_str().unwrap_or("").into(),vendor_trx_id:text("vendor_reference"),callback_required:!text("callback_url").is_empty(),callback_attempt_count:v["callback_attempt_count"].as_i64().unwrap_or(0),callback_delivered_at:json_date(get("callback_delivered_at")),callback_last_attempt_at:json_date(get("callback_last_attempt_at")),callback_next_retry_at:json_date(get("callback_next_retry_at")),callback_last_status_code:get("callback_last_status_code").and_then(Value::as_i64),callback_last_message:text("callback_last_message"),request_ip:v["snapshot"]["requestIp"].as_str().unwrap_or("").into(),created_at:text("created_at"),updated_at:text("updated_at"),product:prod}}
fn seller_order_from_value(v:Value)->SellerOrderItem{let a=seller_admin_order_from_value(v);SellerOrderItem{id:a.id,ref_id:a.ref_id,tr_id:a.tr_id,pulsa_code:a.pulsa_code,target:a.target,price:a.price,status:a.status,rc:a.rc,message:a.message,sn:a.sn,vendor_trx_id:a.vendor_trx_id,callback_required:a.callback_required,callback_attempt_count:a.callback_attempt_count,callback_delivered_at:a.callback_delivered_at,callback_last_attempt_at:a.callback_last_attempt_at,callback_next_retry_at:a.callback_next_retry_at,callback_last_status_code:a.callback_last_status_code,callback_last_message:a.callback_last_message,request_ip:a.request_ip,created_at:a.created_at,updated_at:a.updated_at,product:a.product.map(|p|SellerOrderProduct{id:p.id,name:p.name,code:p.code,brand:p.brand,category:p.category,vendor_name:p.vendor_name,vendor_sku:p.vendor_sku})}}
fn json_date(v:Option<&Value>)->Option<String>{v.filter(|v|!v.is_null()).and_then(Value::as_str).map(str::to_owned)}

fn build_seller_orders_csv(items: &[SellerAdminOrderItem]) -> String {
    let mut rows = vec![vec![
        "Order ID".to_string(),
        "Ref ID".to_string(),
        "TR ID".to_string(),
        "Pulsa Code".to_string(),
        "Produk".to_string(),
        "Kode Produk".to_string(),
        "Kategori".to_string(),
        "Brand".to_string(),
        "Vendor Supplier".to_string(),
        "Vendor SKU".to_string(),
        "Vendor Trx ID".to_string(),
        "Target".to_string(),
        "Harga Seller".to_string(),
        "Status".to_string(),
        "RC".to_string(),
        "Message".to_string(),
        "SN".to_string(),
        "Callback Required".to_string(),
        "Callback Attempts".to_string(),
        "Callback Delivered At".to_string(),
        "Callback Last Attempt At".to_string(),
        "Callback Next Retry At".to_string(),
        "Callback Status Code".to_string(),
        "Callback Message".to_string(),
        "Request IP".to_string(),
        "Created At".to_string(),
        "Updated At".to_string(),
    ]];

    for item in items {
        let product = item.product.as_ref();
        rows.push(vec![
            item.id.clone(),
            item.ref_id.clone(),
            item.tr_id.clone(),
            item.pulsa_code.clone(),
            product.map(|value| value.name.clone()).unwrap_or_default(),
            product.map(|value| value.code.clone()).unwrap_or_default(),
            product
                .map(|value| value.category.clone())
                .unwrap_or_default(),
            product.map(|value| value.brand.clone()).unwrap_or_default(),
            if item.vendor_name.is_empty() {
                product
                    .map(|value| value.vendor_name.clone())
                    .unwrap_or_default()
            } else {
                item.vendor_name.clone()
            },
            if item.vendor_sku.is_empty() {
                product
                    .map(|value| value.vendor_sku.clone())
                    .unwrap_or_default()
            } else {
                item.vendor_sku.clone()
            },
            item.vendor_trx_id.clone(),
            item.target.clone(),
            item.price.to_string(),
            item.status.clone(),
            item.rc.clone(),
            item.message.clone(),
            item.sn.clone(),
            if item.callback_required { "yes" } else { "no" }.to_string(),
            item.callback_attempt_count.to_string(),
            item.callback_delivered_at.clone().unwrap_or_default(),
            item.callback_last_attempt_at.clone().unwrap_or_default(),
            item.callback_next_retry_at.clone().unwrap_or_default(),
            item.callback_last_status_code
                .map(|value| value.to_string())
                .unwrap_or_default(),
            item.callback_last_message.clone(),
            item.request_ip.clone(),
            item.created_at.clone(),
            item.updated_at.clone(),
        ]);
    }

    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|value| csv_escape(&value))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv_escape(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}


fn save_settings_error(code: &'static str) -> Response {
    let message = match code {
        "DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED" => {
            "Username dan API Key Digiflazz Seller wajib diisi"
        }
        "DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID" => {
            "Public Base URL wajib format http:// atau https:// yang valid"
        }
        "DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID" => {
            "Report / callback URL Digiflazz wajib format http:// atau https:// yang valid"
        }
        "DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID" => {
            "Whitelist IP hanya boleh berisi alamat IP valid, pisahkan dengan koma atau baris baru"
        }
        _ => "Gagal menyimpan konfigurasi Digiflazz Seller",
    };
    status_message(axum::http::StatusCode::BAD_REQUEST, message)
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "Service Unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admin_order_item_fixture() -> SellerAdminOrderItem {
        SellerAdminOrderItem {
            id: "507f1f77bcf86cd799439011".to_string(),
            ref_id: "seller-ref-fixture".to_string(),
            tr_id: "DSFIXTURE123456".to_string(),
            pulsa_code: "tsel10".to_string(),
            target: "081200000000".to_string(),
            price: 12_000,
            status: "success".to_string(),
            rc: "00".to_string(),
            message: "Success".to_string(),
            sn: "SN0001".to_string(),
            vendor_name: "TokoVoucher".to_string(),
            vendor_sku: "TSEL10".to_string(),
            vendor_trx_id: "VENDORTRX1".to_string(),
            callback_required: false,
            callback_attempt_count: 0,
            callback_delivered_at: None,
            callback_last_attempt_at: None,
            callback_next_retry_at: None,
            callback_last_status_code: None,
            callback_last_message: String::new(),
            request_ip: "127.0.0.1".to_string(),
            created_at: "2026-08-20T00:00:00.000Z".to_string(),
            updated_at: "2026-08-20T00:00:00.000Z".to_string(),
            product: None,
        }
    }

    fn mapping_summary_fixture() -> MappingSummary {
        MappingSummary { total: 2, active: 1 }
    }

    fn order_summary_fixture() -> OrderSummary {
        OrderSummary {
            total: 3,
            pending: 1,
            callback_pending: 1,
            callback_due_retry: 0,
            callback_high_attempt: 0,
        }
    }

    fn retry_queue_health_fixture() -> RetryQueueHealth {
        RetryQueueHealth {
            status: "idle".to_string(),
            source: "local".to_string(),
            last_run_at: None,
            processed: 0,
            success_count: 0,
            failed_count: 0,
            remaining_due: 0,
            last_error: String::new(),
        }
    }

    fn settings_response_fixture() -> SellerSettingsResponse {
        SellerSettingsResponse {
            configured: true,
            ready: true,
            username: "seller-fixture".to_string(),
            api_key_configured: true,
            public_base_url: "https://seller.example".to_string(),
            digiflazz_callback_url: "https://callback.example".to_string(),
            server_ip: "127.0.0.1".to_string(),
            reported_balance: 1_000_000,
            seller_margin_flat: 250,
            allowed_ips: vec!["127.0.0.1".to_string()],
            callback_enabled: true,
            prepaid_endpoint_path: "/api/v2/digiflazz-seller/prepaid".to_string(),
            prepaid_endpoint_url: "https://seller.example/api/v2/digiflazz-seller/prepaid".to_string(),
            mapping_summary: mapping_summary_fixture(),
            order_summary: order_summary_fixture(),
            retry_queue_health: retry_queue_health_fixture(),
        }
    }

    fn save_settings_response_fixture() -> SaveSettingsResponse {
        SaveSettingsResponse {
            success: true,
            message: "saved",
            configured: true,
            username: "seller-fixture".to_string(),
            api_key_configured: true,
            public_base_url: "https://seller.example".to_string(),
            digiflazz_callback_url: "https://callback.example".to_string(),
            server_ip: "127.0.0.1".to_string(),
            reported_balance: 1_000_000,
            seller_margin_flat: 250,
            allowed_ips: vec!["127.0.0.1".to_string()],
            callback_enabled: true,
            prepaid_endpoint_url: "https://seller.example/api/v2/digiflazz-seller/prepaid".to_string(),
        }
    }

    #[test]
    fn admin_order_item_json_never_exposes_raw_request() {
        let json = serde_json::to_value(admin_order_item_fixture()).unwrap();
        assert!(
            json.get("rawRequest").is_none(),
            "admin seller order DTO must not expose rawRequest"
        );
        assert!(!json.to_string().contains("fixture-signature"));
    }

    #[test]
    fn production_prepaid_source_never_inserts_raw_request() {
        let source = include_str!("digiflazz_seller/prepaid.rs");
        let tests = source.find("\n#[cfg(test)]").unwrap_or(source.len());
        let production = &source[..tests];
        assert!(
            !production.contains("\"rawRequest\":"),
            "production seller order writes must not persist rawRequest"
        );
    }

    #[test]
    fn settings_responses_expose_configured_boolean_without_key_fragments() {
        let read_json = serde_json::to_value(settings_response_fixture()).unwrap();
        assert_eq!(read_json["apiKeyConfigured"], serde_json::Value::Bool(true));
        assert!(read_json.get("apiKeyMasked").is_none());
        assert!(!read_json.to_string().contains("1234"));

        let save_json = serde_json::to_value(save_settings_response_fixture()).unwrap();
        assert_eq!(save_json["apiKeyConfigured"], serde_json::Value::Bool(true));
        assert!(save_json.get("apiKeyMasked").is_none());
        assert!(!save_json.to_string().contains("1234"));
    }

    #[test]
    fn admin_unavailable_never_mentions_mongo_uri() {
        let source = include_str!("digiflazz_seller.rs");
        let tests = source.find("\n#[cfg(test)]").unwrap_or(source.len());
        let production = &source[..tests];
        assert!(
            !production.contains("MONGO_URI is not configured"),
            "Digiflazz admin unavailable() must not leak Mongo configuration"
        );
    }

    #[test]
    fn public_prepaid_does_not_use_admin_unavailable_helper() {
        let source = include_str!("digiflazz_seller/prepaid.rs");
        let tests = source.find("\n#[cfg(test)]").unwrap_or(source.len());
        let production = &source[..tests];
        assert!(
            !production.contains("MONGO_URI is not configured"),
            "public Digiflazz prepaid must not leak Mongo configuration"
        );
        assert!(
            !production.contains("return unavailable();"),
            "public Digiflazz prepaid must stay on the channel envelope when storage is missing"
        );
    }

    fn production_source(path: &str) -> String {
        let source = std::fs::read_to_string(path).unwrap();
        source
            .split("\n#[cfg(test)]")
            .next()
            .unwrap()
            .to_string()
    }

    #[test]
    fn admin_reads_fail_closed_on_query_errors() {
        let root = production_source("src/routes/digiflazz_seller.rs");
        let logs = production_source("src/routes/digiflazz_seller/logs.rs");
        let mappings = production_source("src/routes/digiflazz_seller/mappings.rs");
        let settings = production_source("src/routes/digiflazz_seller/settings.rs");
        for (label, source) in [
            ("orders", root.as_str()),
            ("logs", logs.as_str()),
            ("mappings", mappings.as_str()),
        ] {
            assert!(
                !source.contains("Err(_) => Vec::new()"),
                "{label} must not fail open to an empty list"
            );
        }
        assert!(
            !settings.contains("Err(_) => OrderSummary::default()"),
            "seller_order_summary must not fail open to zeros"
        );
        assert!(
            settings.contains("Err(_) => return internal_error()")
                || settings.contains("Err(_) => return unavailable()"),
            "settings helpers must fail closed on Mongo errors"
        );
    }
}
