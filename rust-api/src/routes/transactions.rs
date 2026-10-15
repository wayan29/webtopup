use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use sqlx::Row;

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, require_sql_permission, require_sql_user, ErrorResponse},
    services::{bot_protection::{cloudflare_turnstile_verifier, enforce_turnstile, kill_switch_enabled}, idempotency},
    state::AppState,
};

mod csv;
mod list;
pub(crate) mod provider;
pub(crate) mod types;

use csv::build_transaction_csv;
use list::sql_transaction_items;
use types::*;

const DEFAULT_THRESHOLD_MINUTES: i64 = 15;
const MAX_THRESHOLD_MINUTES: i64 = 24 * 60;
const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;
const MANUAL_MAX_LIMIT: i64 = 100;
const TRANSACTION_EXPORT_LIMIT: i64 = 5000;
const REPORT_OFFSET: &str = "+07:00";
const ALLOWED_TRANSACTION_STATUSES: [&str; 4] = ["pending", "processing", "success", "failed"];

pub async fn stuck_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<StuckTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let threshold_minutes = parse_positive_i64(
        query.threshold_minutes.as_deref(),
        DEFAULT_THRESHOLD_MINUTES,
        MAX_THRESHOLD_MINUTES,
    );
    let limit = parse_positive_i64(query.limit.as_deref(), DEFAULT_LIMIT, MAX_LIMIT);
    let cutoff = chrono::Utc::now()
        - chrono::Duration::minutes(threshold_minutes);
    let rows = match sqlx::query(
        "SELECT t.id,t.target,t.status,t.amount,t.reference_id,t.source,t.snapshot,t.created_at,t.updated_at,\
         u.id AS user_id,COALESCE(u.name,'') AS user_name,COALESCE(u.email,'') AS user_email,\
         p.id AS product_id,COALESCE(p.name,'') AS product_name,COALESCE(p.code,'') AS product_code,\
         COALESCE(p.category,'') AS product_category,COALESCE(p.brand,'') AS product_brand,COALESCE(p.vendor_name,'') AS product_vendor \
         FROM financial_transactions t LEFT JOIN users u ON u.id=t.user_id \
         LEFT JOIN products p ON p.id=t.product_id \
         WHERE t.kind='member' AND t.status IN ('pending','processing') AND t.updated_at <= $1 \
         ORDER BY t.updated_at ASC LIMIT $2",
    )
    .bind(cutoff)
    .bind(limit)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    let total = match sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM financial_transactions WHERE kind='member' AND status IN ('pending','processing') AND updated_at <= $1",
    )
    .bind(cutoff)
    .fetch_one(&state.pg_pool)
    .await
    {
        Ok(total) => total,
        Err(_) => return internal_error(),
    };
    let items = rows.into_iter().map(|row| {
        let updated_at = row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at");
        let created_at = row.get::<chrono::DateTime<chrono::Utc>, _>("created_at");
        let snapshot = row.get::<serde_json::Value, _>("snapshot");
        let user_id = row.try_get::<Option<uuid::Uuid>, _>("user_id").ok().flatten();
        let product_id = row.try_get::<Option<uuid::Uuid>, _>("product_id").ok().flatten();
        StuckTransactionItem {
            id: row.get::<uuid::Uuid, _>("id").to_string(), target: row.get("target"),
            status: row.get("status"), amount: row.get("amount"), reference_id: row.get("reference_id"),
            vendor_trx_id: snapshot.get("vendorTrxId").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
            customer_ref_id: snapshot.get("customerRefId").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
            source: row.get("source"), created_at: created_at.to_rfc3339(), updated_at: updated_at.to_rfc3339(),
            age_minutes: (chrono::Utc::now() - updated_at).num_minutes(),
            user: user_id.map(|id| StuckTransactionUser { id: id.to_string(), name: row.get("user_name"), email: row.get("user_email") }),
            product: product_id.map(|id| StuckTransactionProduct { id: id.to_string(), name: row.get("product_name"), code: row.get("product_code"), category: row.get("product_category"), brand: row.get("product_brand"), vendor: row.get("product_vendor") }),
        }
    }).collect::<Vec<_>>();
    Json(StuckTransactionsResponse {
        threshold_minutes,
        total: total.max(0) as u64,
        items,
    })
    .into_response()
}
pub async fn create_transaction(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTransactionPayload>,
) -> Response {
    let context = match crate::security::require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(user_id) = context.user_id.as_deref().and_then(|value| uuid::Uuid::parse_str(value).ok()) else {
        return status_message(StatusCode::UNAUTHORIZED, "Unauthorized: Invalid token");
    };
    let target = normalize_payload_text(payload.target.as_deref());
    if target.is_empty() { return status_message(StatusCode::BAD_REQUEST, "Target wajib diisi"); }
    let server_id = normalize_payload_text(payload.server_id.as_deref());
    let maintenance=match sqlx::query_scalar::<_,bool>("SELECT COALESCE((value #>> '{}')::boolean,false) FROM site_settings WHERE key='maintenanceMode'").fetch_optional(&state.pg_pool).await {Ok(value)=>value,Err(_)=>return internal_error()};
    if maintenance==Some(true) {
        let message=sqlx::query_scalar::<_,String>("SELECT COALESCE(value #>> '{}','Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.') FROM site_settings WHERE key='maintenanceMessage'").fetch_optional(&state.pg_pool).await.ok().flatten().unwrap_or_else(||"Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.".to_owned());
        return (StatusCode::SERVICE_UNAVAILABLE,Json(serde_json::json!({"message":message}))).into_response();
    }
    let settings = match sqlx::query("SELECT key,value FROM site_settings WHERE key IN ('botProtectionEnabled','turnstileSiteKey')").fetch_all(&state.pg_pool).await { Ok(rows)=>rows,Err(_)=>return internal_error() };
    let stored_enabled=settings.iter().find(|row|row.get::<String,_>("key")=="botProtectionEnabled").and_then(|row|row.get::<serde_json::Value,_>("value").as_bool()).unwrap_or(false);
    let site_key=settings.iter().find(|row|row.get::<String,_>("key")=="turnstileSiteKey").and_then(|row|row.get::<serde_json::Value,_>("value").as_str().map(str::to_owned)).unwrap_or_default();
    let secret = std::env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
    let kill_switch = kill_switch_enabled(std::env::var("TURNSTILE_DISABLED").ok().as_deref());
    let remote_ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).map(str::trim).filter(|v| !v.is_empty()).unwrap_or("unknown");
    if let Err(response) = enforce_turnstile(stored_enabled, &site_key, &secret, kill_switch, payload.turnstile_token.as_deref(), Some(remote_ip), cloudflare_turnstile_verifier()).await { return response; }

    let product_id_filter=match payload.product_id.as_deref().map(str::trim).filter(|value|!value.is_empty()) {Some(value)=>match uuid::Uuid::parse_str(value){Ok(id)=>Some(id),Err(_)=>return status_message(StatusCode::NOT_FOUND,"Product not found")},None=>None};
    let product_code_filter=payload.product_code.as_deref().map(str::trim).filter(|value|!value.is_empty());
    if product_id_filter.is_none()&&product_code_filter.is_none(){return status_message(StatusCode::NOT_FOUND,"Product not found")}
    let product = match sqlx::query("SELECT p.id,p.code,p.name,p.price_basic,p.price_gold,p.price_platinum,p.category_id,p.operator_id,p.product_type_id,p.category,p.brand,p.vendor_name,p.vendor_sku,p.validation,c.status category_status,c.is_active category_active,o.status operator_status,t.status type_status FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id LEFT JOIN product_types t ON t.id=p.product_type_id WHERE p.status=true AND (($1::uuid IS NOT NULL AND p.id=$1) OR ($1::uuid IS NULL AND p.code=$2))")
        .bind(product_id_filter).bind(product_code_filter).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => row, Ok(None) => return status_message(StatusCode::NOT_FOUND,"Product not found"), Err(_) => return internal_error()
    };
    if product.try_get::<Option<bool>,_>("category_status").ok().flatten()==Some(false) || product.try_get::<Option<bool>,_>("category_active").ok().flatten()==Some(false) || product.try_get::<Option<bool>,_>("operator_status").ok().flatten()==Some(false) || product.try_get::<Option<bool>,_>("type_status").ok().flatten()==Some(false) {
        return (StatusCode::BAD_REQUEST,Json(serde_json::json!({"message":"Produk tidak tersedia untuk dibeli: Kategori/operator/jenis produk nonaktif"}))).into_response();
    }
    let product_id = product.get::<uuid::Uuid,_>("id"); let code=product.get::<String,_>("code");
    let product_name=product.get::<String,_>("name"); let vendor_name=product.get::<String,_>("vendor_name"); let vendor_sku=product.get::<String,_>("vendor_sku");
    let level = match sqlx::query_scalar::<_,String>("SELECT level FROM users WHERE id=$1 AND role='member' AND active=true").bind(user_id).fetch_optional(&state.pg_pool).await { Ok(Some(level))=>level,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"User not found"),Err(_)=>return internal_error() };
    let base_price = match level.as_str(){"gold"=>product.get("price_gold"),"platinum"=>product.get("price_platinum"),_=>product.get("price_basic")};
    if base_price<=0 { return status_message(StatusCode::BAD_REQUEST,"Product not found or unavailable"); }
    let category_id=product.try_get("category_id").ok(); let operator_id=product.try_get("operator_id").ok();
    let product_ctx=crate::routes::vouchers::DiscountProductContext{product_id:Some(product_id),category_id,operator_id};
    let mut tx=match state.pg_pool.begin().await {Ok(tx)=>tx,Err(_)=>return internal_error()};
    let balance=match sqlx::query_scalar::<_,i64>("SELECT balance FROM users WHERE id=$1 AND role='member' AND active=true FOR UPDATE").bind(user_id).fetch_optional(&mut *tx).await {Ok(Some(v))=>v,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"User not found"),Err(_)=>return internal_error()};
    let idem_key=headers.get("idempotency-key").and_then(|v|v.to_str().ok()).map(str::trim).filter(|v|!v.is_empty()).map(str::to_owned);
    let request_digest=format!("{:x}",md5::compute(format!("{}\0{}\0{}\0{}\0{}\0{}",payload.product_id.as_deref().unwrap_or(""),payload.product_code.as_deref().unwrap_or(""),target,server_id,payload.voucher_code.as_deref().unwrap_or(""),payload.use_flash_sale.unwrap_or(false))));
    if let Some(key)=idem_key.as_deref() {
        let existing=match sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation='member-checkout' AND key=$2 FOR UPDATE").bind(user_id.to_string()).bind(key).fetch_optional(&mut *tx).await {Ok(value)=>value,Err(_)=>return internal_error()};
        if let Some(row)=existing { if row.get::<String,_>("digest")!=request_digest {return status_message(StatusCode::CONFLICT,"Idempotency key reused with different request");} if let Some(body)=row.get::<Option<serde_json::Value>,_>("response") { return (StatusCode::from_u16(row.get::<Option<i32>,_>("response_status").unwrap_or(201) as u16).unwrap_or(StatusCode::CREATED),Json(body)).into_response(); } return status_message(StatusCode::CONFLICT,"Transaction is being processed"); }
        if sqlx::query("INSERT INTO financial_requests(actor,operation,key,digest) VALUES($1,'member-checkout',$2,$3)").bind(user_id.to_string()).bind(key).bind(&request_digest).execute(&mut *tx).await.is_err(){return internal_error();}
    }
    let transaction_id = uuid::Uuid::new_v4();
    let mut price=base_price;
    let flash_sale=if payload.use_flash_sale.unwrap_or(false) { match crate::services::flash_sales::reserve_flash_sale_stock(&mut *tx,crate::services::flash_sales::FlashProductKey::Code(&code),base_price).await {Ok(Some(reservation))=>{price=reservation.price;Some(reservation)},Ok(None)=>None,Err(_)=>return internal_error()} } else {None};
    let voucher=if let Some(code)=payload.voucher_code.as_deref().map(str::trim).filter(|v|!v.is_empty()) { match crate::routes::vouchers::consume_discount_voucher_sql(&mut *tx,&code.to_uppercase(),price,Some(user_id),&product_ctx).await {Ok(applied)=>{price=applied.final_price;Some(applied)},Err(response)=>return response} } else {None};
    if balance<price { return status_message(StatusCode::BAD_REQUEST,"Insufficient balance"); }
    let now_wib=chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(7*3600).expect("valid WIB offset"));
    let date_wib=now_wib.date_naive();
    let settings=match sqlx::query("SELECT key,value FROM site_settings WHERE key IN ('refIdPrefix','refIdDateFormat','refIdSeparator','refIdSequenceDigits')").fetch_all(&mut *tx).await {Ok(rows)=>rows,Err(_)=>return internal_error()};
    let setting=|key:&str|settings.iter().find(|row|row.get::<String,_>("key")==key).map(|row|row.get::<serde_json::Value,_>("value"));
    let prefix=setting("refIdPrefix").and_then(|v|v.as_str().map(str::to_owned)).filter(|v|!v.trim().is_empty()).unwrap_or_else(||"REF".to_owned());
    let date_format=setting("refIdDateFormat").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_else(||"DDMMYYYY".to_owned());
    let separator=setting("refIdSeparator").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default();
    let digits=setting("refIdSequenceDigits").and_then(|v|v.as_i64()).unwrap_or(4).clamp(1,10) as usize;
    let sequence=match sqlx::query_scalar::<_,i64>("INSERT INTO reference_counters(scope,date_wib,sequence) VALUES('member-transaction',$1,1) ON CONFLICT(scope,date_wib) DO UPDATE SET sequence=reference_counters.sequence+1 RETURNING sequence").bind(date_wib).fetch_one(&mut *tx).await {Ok(value)=>value,Err(_)=>return internal_error()};
    if sequence>=10_i64.pow(digits as u32){return ref_id_sequence_exhausted();}
    let date_part=match date_format.as_str(){"YYYYMMDD"=>now_wib.format("%Y%m%d").to_string(),"MMDDYYYY"=>now_wib.format("%m%d%Y").to_string(),"DDMMYY"=>now_wib.format("%d%m%y").to_string(),"YYMMDD"=>now_wib.format("%y%m%d").to_string(),_=>now_wib.format("%d%m%Y").to_string()};
    let sequence_part=format!("{:0width$}",sequence,width=digits);
    let reference_id=[prefix.as_str(),date_part.as_str(),sequence_part.as_str()].into_iter().filter(|part|!part.is_empty()).collect::<Vec<_>>().join(&separator);
    let product_snapshot=serde_json::json!({"code":code,"name":product_name,"vendorName":vendor_name,"vendorSku":vendor_sku,"category":product.get::<String,_>("category"),"brand":product.get::<String,_>("brand"),"validation":product.get::<serde_json::Value,_>("validation")});
    let discount_amount=voucher.as_ref().map(|v|v.discount_amount);
    let base_amount=voucher.as_ref().map(|_|base_price);
    let voucher_code=voucher.as_ref().map(|v|v.code.clone());
    let snapshot=serde_json::json!({"product":product_snapshot,"target":target,"serverId":server_id,"source":"web","discountVoucherCode":voucher_code,"discountAmount":discount_amount,"baseAmount":base_amount,"flashSale":flash_sale.as_ref().map(|r|r.flash_sale_id.to_string())});
    let next_balance=balance-price;
    let inserted=sqlx::query("INSERT INTO financial_transactions(id,reference_id,user_id,product_id,kind,amount,status,snapshot,target,server_id,source,discount_voucher_code,discount_amount,base_amount,provider_reference) VALUES($1,$2,$3,$4,'member',$5,'pending',$6,$7,$8,'web',$9,$10,$11,$2)")
        .bind(transaction_id).bind(&reference_id).bind(user_id).bind(product_id).bind(price).bind(&snapshot).bind(&target).bind(&server_id).bind(&voucher_code).bind(discount_amount).bind(base_amount).execute(&mut *tx).await;
    if inserted.is_err() { return internal_error(); }
    if sqlx::query("INSERT INTO financial_status_events(transaction_id,status,payload) VALUES($1,'pending',$2)").bind(transaction_id).bind(serde_json::json!({"source":"member_checkout","referenceId":reference_id})).execute(&mut *tx).await.is_err(){return internal_error()}
    if sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'debit',-1,$3,$4)").bind(user_id).bind(format!("transaction:{transaction_id}")).bind(price).bind(next_balance).execute(&mut *tx).await.is_err() || sqlx::query("UPDATE users SET balance=$2,updated_at=now() WHERE id=$1").bind(user_id).bind(next_balance).execute(&mut *tx).await.is_err() { return internal_error(); }
    let provider_job=serde_json::json!({"referenceId":reference_id,"productCode":code,"sku":vendor_sku,"target":target,"serverId":server_id,"amount":price,"source":"web"});
    if sqlx::query("INSERT INTO financial_provider_jobs(reference_id,snapshot) VALUES($1,$2)").bind(&reference_id).bind(&provider_job).execute(&mut *tx).await.is_err() || sqlx::query("INSERT INTO provider_outbox(ref_id,payload,state) VALUES($1,$2,'pending')").bind(&reference_id).bind(&provider_job).execute(&mut *tx).await.is_err() { return internal_error(); }
    if let Some(voucher)=voucher.as_ref() { if sqlx::query("INSERT INTO financial_checkout_effects(transaction_id,user_id,effect_type,effect_key,amount,metadata) VALUES($1,$2,'voucher',$3,$4,$5)").bind(transaction_id).bind(user_id).bind(format!("{transaction_id}:{}",voucher.voucher_id)).bind(voucher.discount_amount).bind(serde_json::json!({"code":voucher.code})).execute(&mut *tx).await.is_err(){return internal_error()} }
    if let Some(flash)=flash_sale.as_ref() { if sqlx::query("INSERT INTO financial_checkout_effects(transaction_id,user_id,effect_type,effect_key,amount,metadata) VALUES($1,$2,'flash_sale',$3,$4,$5)").bind(transaction_id).bind(user_id).bind(format!("{transaction_id}:{}",flash.flash_sale_id)).bind(flash.price).bind(serde_json::json!({"productId":flash.product_id})).execute(&mut *tx).await.is_err(){return internal_error()} }
    let created_at=match sqlx::query_scalar::<_,chrono::DateTime<chrono::Utc>>("SELECT created_at FROM financial_transactions WHERE id=$1").bind(transaction_id).fetch_one(&mut *tx).await {Ok(value)=>value,Err(_)=>return internal_error()};
    let mut transaction=serde_json::json!({"_id":transaction_id.to_string(),"user":user_id.to_string(),"product":product_id.to_string(),"target":target,"amount":price,"status":"pending","referenceId":reference_id,"refunded":false,"source":"web","createdAt":created_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),"updatedAt":created_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()});
    if !server_id.is_empty(){transaction["serverId"]=serde_json::json!(server_id)}
    if let Some(voucher)=voucher.as_ref(){transaction["discountVoucherCode"]=serde_json::json!(voucher.code);transaction["discountAmount"]=serde_json::json!(voucher.discount_amount);transaction["baseAmount"]=serde_json::json!(base_price)}
    let body=serde_json::to_value(CreateTransactionResponse{message:"Transaction created",transaction,remaining_balance:next_balance}).unwrap_or(serde_json::Value::Null);
    if body.is_null(){return internal_error()}
    if let Some(key)=idem_key.as_deref(){if sqlx::query("UPDATE financial_requests SET response=$4,response_status=201 WHERE actor=$1 AND operation='member-checkout' AND key=$2 AND digest=$3").bind(user_id.to_string()).bind(key).bind(&request_digest).bind(&body).execute(&mut *tx).await.is_err(){return internal_error()}}
    if tx.commit().await.is_err(){return internal_error()}
    (StatusCode::CREATED,Json(body)).into_response()
}

pub async fn manual_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "processManualTransaction").await {
        return response;
    }

    let page=parse_positive_i64(query.page.as_deref(),1,100_000);
    let limit=parse_positive_i64(query.limit.as_deref(),20,MANUAL_MAX_LIMIT);
    let (items,summary,total)=match list::sql_transaction_items(&state.pg_pool,&query,page,limit,true).await{Ok(value)=>value,Err(response)=>return response};
    let total_pages=if total>0{((total as f64)/(limit as f64)).ceil() as i64}else{1};
    Json(ManualTransactionsResponse{items,meta:ManualTransactionsMeta{page,limit,total,total_pages},summary}).into_response()
}

pub async fn admin_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let page=parse_positive_i64(query.page.as_deref(),1,100_000);
    let limit=parse_positive_i64(query.limit.as_deref(),20,MANUAL_MAX_LIMIT);
    let (items,summary,total)=match list::sql_transaction_items(&state.pg_pool,&query,page,limit,false).await{Ok(value)=>value,Err(response)=>return response};
    let total_pages=if total>0{((total as f64)/(limit as f64)).ceil() as i64}else{1};
    Json(ManualTransactionsResponse{items,meta:ManualTransactionsMeta{page,limit,total,total_pages},summary}).into_response()
}

pub async fn admin_transactions_export(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") { return response; }
    let (items,_,_)=match list::sql_transaction_items(&state.pg_pool,&query,1,TRANSACTION_EXPORT_LIMIT,false).await{Ok(value)=>value,Err(response)=>return response};
    let csv=build_transaction_csv(&items);
    let filename = format!("admin-transactions-{}.csv", date_key(chrono::Utc::now()));
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

pub async fn refund_transaction(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<RefundPayload>,
) -> Response {
    let actor = match require_sql_permission(&headers, &state, "processManualTransaction").await { Ok(user) => user, Err(response) => return response };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.refund") { return response; }
    let Some(transaction_id) = uuid::Uuid::parse_str(id.trim()).ok() else { return status_message(StatusCode::BAD_REQUEST, "ID transaksi tidak valid"); };
    let key = match idempotency::require_idempotency_key(&headers) { Ok(Some(key)) => key, Ok(None) => return status_message(StatusCode::BAD_REQUEST,"Idempotency-Key required"), Err(error) => return error.into_response() };
    let reason = payload.reason.unwrap_or_default().trim().to_owned();
    if !(5..=300).contains(&reason.len()) { return status_message(StatusCode::BAD_REQUEST,"Alasan refund wajib 5-300 karakter"); }
    let digest = format!("{:x}", md5::compute(format!("{}\0{}\0{}", transaction_id, reason, actor.id)));
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    let op_key = format!("transaction-refund:{}:{}",actor.id,key);
    let existing = match sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation='transaction-refund' AND key=$2 FOR UPDATE").bind(actor.id.to_string()).bind(&key).fetch_optional(&mut *tx).await { Ok(v)=>v,Err(_)=>return internal_error() };
    if let Some(row)=existing { if row.get::<String,_>("digest")!=digest { return status_message(StatusCode::CONFLICT,"Idempotency key reused with different request"); } if let Some(body)=row.get::<Option<Value>,_>("response") { let _=tx.rollback().await; return (StatusCode::from_u16(row.get::<Option<i32>,_>("response_status").unwrap_or(200) as u16).unwrap_or(StatusCode::OK),Json(body)).into_response(); } return status_message(StatusCode::CONFLICT,"Transaction is being processed"); }
    if sqlx::query("INSERT INTO financial_requests(actor,operation,key,digest) VALUES($1,'transaction-refund',$2,$3)").bind(actor.id.to_string()).bind(&key).bind(&digest).execute(&mut *tx).await.is_err(){return internal_error();}
    let row=match sqlx::query("SELECT id,user_id,amount,status,refunded,reference_id,target,source,snapshot,created_at,updated_at FROM financial_transactions WHERE id=$1 FOR UPDATE").bind(transaction_id).fetch_optional(&mut *tx).await{Ok(Some(row))=>row,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"Transaction not found"),Err(_)=>return internal_error()};
    let Some(user_id)=row.try_get::<Option<uuid::Uuid>,_>("user_id").ok().flatten() else{return status_message(StatusCode::CONFLICT,"Transaction has no refundable wallet owner")};
    if row.get::<bool,_>("refunded") {return status_message(StatusCode::CONFLICT,"Transaction already refunded");}
    let amount=row.get::<i64,_>("amount"); if amount<=0{return status_message(StatusCode::CONFLICT,"Transaction amount is not refundable");}
    if row.get::<String,_>("status")=="success" { return status_message(StatusCode::BAD_REQUEST,"Transaksi sukses harus diubah ke failed dari edit status agar poin ikut direkonsiliasi"); }
    let balance=match sqlx::query_scalar::<_,i64>("SELECT balance FROM users WHERE id=$1 FOR UPDATE").bind(user_id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"User transaksi tidak ditemukan"),Err(_)=>return internal_error()};
    let next=match balance.checked_add(amount){Some(v)=>v,None=>return internal_error()};let now=chrono::Utc::now();
    if sqlx::query("UPDATE users SET balance=$2,updated_at=$3 WHERE id=$1").bind(user_id).bind(next).bind(now).execute(&mut *tx).await.is_err()
        ||sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'refund',1,$3,$4)").bind(user_id).bind(format!("transaction-refund:{transaction_id}")).bind(amount).bind(next).execute(&mut *tx).await.is_err()
        ||sqlx::query("INSERT INTO financial_audits(actor_id,action,subject_id,amount,operation_key) VALUES($1,'transaction_refund',$2,$3,$4)").bind(actor.id).bind(transaction_id).bind(amount).bind(&op_key).execute(&mut *tx).await.is_err(){return internal_error();}
    let note=format!("Refund transaksi: {reason}");
    if sqlx::query("UPDATE financial_transactions SET refunded=true,status='failed',refunded_at=$2,refund_reason=$3,refunded_by=$4,status_updated_by=$4,status_updated_at=$2,status_update_note=$5,updated_at=$2 WHERE id=$1").bind(transaction_id).bind(now).bind(&reason).bind(actor.id).bind(&note).execute(&mut *tx).await.is_err()
       ||sqlx::query("INSERT INTO financial_status_events(transaction_id,status,payload) VALUES($1,'failed',$2)").bind(transaction_id).bind(serde_json::json!({"source":"transaction_refund","actorId":actor.id,"reason":reason})).execute(&mut *tx).await.is_err(){return internal_error();}
    let body=serde_json::json!({"message":"Saldo transaksi berhasil direfund","transaction":{"_id":transaction_id.to_string(),"user":user_id.to_string(),"target":row.get::<String,_>("target"),"amount":amount,"status":"failed","referenceId":row.get::<String,_>("reference_id"),"refunded":true,"refundedAt":now.to_rfc3339(),"refundReason":reason,"source":row.get::<String,_>("source"),"createdAt":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),"updatedAt":now.to_rfc3339(),"statusUpdatedBy":{"_id":actor.id.to_string() },"statusUpdatedAt":now.to_rfc3339(),"statusUpdateNote":note}});
    if sqlx::query("UPDATE financial_requests SET response=$4,response_status=200 WHERE actor=$1 AND operation='transaction-refund' AND key=$2 AND digest=$3").bind(actor.id.to_string()).bind(&key).bind(&digest).bind(&body).execute(&mut *tx).await.is_err(){return internal_error();}
    if tx.commit().await.is_err(){let replay=sqlx::query("SELECT digest,response,response_status FROM financial_requests WHERE actor=$1 AND operation='transaction-refund' AND key=$2").bind(actor.id.to_string()).bind(&key).fetch_optional(&state.pg_pool).await; if let Ok(Some(row))=replay {if row.get::<String,_>("digest")==digest {if let Some(body)=row.get::<Option<Value>,_>("response"){return (StatusCode::OK,Json(body)).into_response();}}} return status_message(StatusCode::SERVICE_UNAVAILABLE,"Refund result uncertain; retry with the same idempotency key");}
    (StatusCode::OK,Json(body)).into_response()
}

pub async fn update_status(headers: HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(payload): Json<StatusUpdatePayload>) -> Response {
    let actor=match require_sql_permission(&headers,&state,"processManualTransaction").await{Ok(v)=>v,Err(r)=>return r};
    if let Err(r)=require_trusted_step_up_group(&headers,"transactions.manual"){return r;}
    let Some(id)=uuid::Uuid::parse_str(id.trim()).ok()else{return status_message(StatusCode::BAD_REQUEST,"ID transaksi tidak valid")};
    let payload=match normalize_status_payload(payload){Ok(v)=>v,Err(r)=>return r};
    let key=headers.get("idempotency-key").and_then(|v|v.to_str().ok()).map(str::trim).filter(|v|!v.is_empty()).map(str::to_owned);
    let digest=format!("{:x}",md5::compute(serde_json::to_vec(&serde_json::json!([id,payload.status,payload.vendor_trx_id,payload.sn,payload.note])).unwrap_or_default()));
    let mut tx=match state.pg_pool.begin().await{Ok(v)=>v,Err(_)=>return unavailable()};
    if let Some(key)=key.as_deref(){let found=match sqlx::query("SELECT digest,response FROM financial_requests WHERE actor=$1 AND operation='transaction-status' AND key=$2 FOR UPDATE").bind(actor.id.to_string()).bind(key).fetch_optional(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal_error()};if let Some(r)=found{if r.get::<String,_>("digest")!=digest{return status_message(StatusCode::CONFLICT,"Idempotency key reused with different request")}if let Some(v)=r.get::<Option<Value>,_>("response"){let _=tx.rollback().await;return (StatusCode::OK,Json(v)).into_response()}return status_message(StatusCode::CONFLICT,"Transaction is being processed")}if sqlx::query("INSERT INTO financial_requests(actor,operation,key,digest) VALUES($1,'transaction-status',$2,$3)").bind(actor.id.to_string()).bind(key).bind(&digest).execute(&mut *tx).await.is_err(){return internal_error()}}
    let row=match sqlx::query("SELECT user_id,amount,status,refunded,reference_id,target,source,created_at,vendor_trx_id,sn,message FROM financial_transactions WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"Transaction not found"),Err(_)=>return internal_error()};
    let Some(user)=row.try_get::<Option<uuid::Uuid>,_>("user_id").ok().flatten()else{return status_message(StatusCode::CONFLICT,"Transaction has no wallet owner")};let old=row.get::<String,_>("status");let amount=row.get::<i64,_>("amount");let plan=apply_transition_plan(&old,row.get("refunded"),amount,&payload.status);let now=chrono::Utc::now();let note=build_admin_status_note(&old,&payload.status,&payload.note);
    if plan.balance_delta!=0{let bal=match sqlx::query_scalar::<_,i64>("SELECT balance FROM users WHERE id=$1 FOR UPDATE").bind(user).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"User transaksi tidak ditemukan"),Err(_)=>return internal_error()};let next=if plan.balance_delta>0{match bal.checked_add(plan.balance_delta){Some(v)=>v,None=>return internal_error()}}else{match bal.checked_sub(-plan.balance_delta){Some(v)if v>=0=>v,_=>return status_message(StatusCode::CONFLICT,"Insufficient balance")}};let source=format!("transaction-status:{id}:{old}:{}",payload.status);let kind=if plan.balance_delta>0{"refund"}else{"debit"};if sqlx::query("UPDATE users SET balance=$2,updated_at=$3 WHERE id=$1").bind(user).bind(next).bind(now).execute(&mut *tx).await.is_err()||sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,$3,$4,$5,$6)").bind(user).bind(source).bind(kind).bind(if plan.balance_delta>0{1_i16}else{-1_i16}).bind(plan.balance_delta.abs()).bind(next).execute(&mut *tx).await.is_err(){return internal_error()}}
    let source=format!("transaction-success:{id}");let prior=match sqlx::query_scalar::<_,i64>("SELECT points FROM point_awards WHERE source=$1").bind(&source).fetch_optional(&mut *tx).await{Ok(v)=>v,Err(_)=>return internal_error()};
    if plan.should_award_points&&prior.is_none(){let per=match sqlx::query_scalar::<_,Value>("SELECT value FROM site_settings WHERE key='points_per_transaction'").fetch_optional(&mut *tx).await{Ok(v)=>v.and_then(|v|v.as_i64()).filter(|v|*v>0).unwrap_or(100),Err(_)=>return internal_error()};let points=(amount/10_000).saturating_mul(per);if points>0&&(sqlx::query("UPDATE users SET points=points+$2,updated_at=$3 WHERE id=$1").bind(user).bind(points).bind(now).execute(&mut *tx).await.is_err()||sqlx::query("INSERT INTO point_awards(source,user_id,points) VALUES($1,$2,$3)").bind(&source).bind(user).bind(points).execute(&mut *tx).await.is_err()){return internal_error()}}
    if plan.should_revoke_points{if let Some(points)=prior{if sqlx::query("UPDATE users SET points=points-$2,updated_at=$3 WHERE id=$1 AND points >= $2").bind(user).bind(points).bind(now).execute(&mut *tx).await.is_err()||sqlx::query("DELETE FROM point_awards WHERE source=$1").bind(&source).execute(&mut *tx).await.is_err(){return internal_error()}}}
    let vendor=payload.vendor_trx_id.or_else(||row.try_get("vendor_trx_id").ok().flatten());let sn=payload.sn.or_else(||row.try_get("sn").ok().flatten());let message=if payload.note.is_empty(){row.get::<String,_>("message")}else{payload.note.clone()};
    if sqlx::query("UPDATE financial_transactions SET status=$2,refunded=$3,status_updated_by=$4,status_updated_at=$5,status_update_note=$6,vendor_trx_id=$7,sn=$8,message=$9,updated_at=$5 WHERE id=$1").bind(id).bind(&payload.status).bind(plan.next_refunded).bind(actor.id).bind(now).bind(&note).bind(&vendor).bind(&sn).bind(&message).execute(&mut *tx).await.is_err()||sqlx::query("INSERT INTO financial_status_events(transaction_id,status,payload) VALUES($1,$2,$3)").bind(id).bind(&payload.status).bind(serde_json::json!({"source":"manual_status","actorId":actor.id,"note":note})).execute(&mut *tx).await.is_err(){return internal_error()}
    let body=serde_json::json!({"message":"Transaction updated","transaction":{"_id":id.to_string(),"user":{"_id":user.to_string()},"target":row.get::<String,_>("target"),"amount":amount,"status":payload.status,"referenceId":row.get::<String,_>("reference_id"),"vendorTrxId":vendor,"sn":sn,"message":message,"refunded":plan.next_refunded,"source":row.get::<String,_>("source"),"createdAt":row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),"updatedAt":now.to_rfc3339(),"statusUpdatedAt":now.to_rfc3339(),"statusUpdatedBy":{"_id":actor.id.to_string()},"statusUpdateNote":note}});
    if let Some(key)=key.as_deref(){if sqlx::query("UPDATE financial_requests SET response=$4,response_status=200 WHERE actor=$1 AND operation='transaction-status' AND key=$2 AND digest=$3").bind(actor.id.to_string()).bind(key).bind(&digest).bind(&body).execute(&mut *tx).await.is_err(){return internal_error()}}
    if tx.commit().await.is_err(){return status_message(StatusCode::SERVICE_UNAVAILABLE,"Status update result uncertain; retry with same idempotency key")} (StatusCode::OK,Json(body)).into_response()
}

pub async fn recheck_status(headers: HeaderMap, State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Err(r)=require_sql_permission(&headers,&state,"processManualTransaction").await{return r;}
    let Some(id)=uuid::Uuid::parse_str(id.trim()).ok()else{return status_message(StatusCode::BAD_REQUEST,"ID transaksi tidak valid")};
    let row=match sqlx::query("SELECT status,snapshot FROM financial_transactions WHERE id=$1").bind(id).fetch_optional(&state.pg_pool).await{Ok(Some(v))=>v,Ok(None)=>return status_message(StatusCode::NOT_FOUND,"Transaction not found"),Err(_)=>return internal_error()};
    if !matches!(row.get::<String,_>("status").as_str(),"pending"|"processing"){return status_message(StatusCode::BAD_REQUEST,"Hanya transaksi pending/proses yang bisa dicek ulang ke vendor")}
    status_message(StatusCode::SERVICE_UNAVAILABLE,"Vendor recheck unavailable: this route cannot safely resolve encrypted seller credentials or claim and settle provider work through the SQL provider contract; transaction unchanged")
}

pub async fn member_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_user = match require_sql_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let user_id = proxy_user.id;
    let role = proxy_user.role.as_str();
    let all_users = matches!(role, "owner" | "admin" | "cs");
    let member_rows = match sqlx::query(
        "SELECT t.id,t.user_id,t.product_id,t.reference_id,t.partner_ref,t.amount,t.status,t.refunded,t.snapshot,t.created_at,t.updated_at,t.target,t.source,t.provider_reference,t.provider_result,\
         COALESCE(u.name,'') user_name,COALESCE(p.name,'') product_name,COALESCE(p.code,'') product_code \
         FROM financial_transactions t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN products p ON p.id=t.product_id \
         WHERE t.kind='member' AND ($1 OR t.user_id=$2) ORDER BY t.created_at DESC",
    )
    .bind(all_users)
    .bind(user_id)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    let mut items = member_rows.into_iter().map(|row| {
        let created_at = row.get::<chrono::DateTime<chrono::Utc>, _>("created_at");
        let updated_at = row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at");
        serde_json::json!({
            "_id": row.get::<uuid::Uuid, _>("id").to_string(),
            "user": {"_id": row.try_get::<Option<uuid::Uuid>,_>("user_id").ok().flatten().map(|v| v.to_string()),"name":row.get::<String,_>("user_name"),"email":row.get::<String,_>("user_email")},
            "product": {"_id": row.get::<uuid::Uuid,_>("product_id").to_string(),"name":row.get::<String,_>("product_name"),"code":row.get::<String,_>("product_code")},
            "target":row.get::<String,_>("target"),"amount":row.get::<i64,_>("amount"),"status":row.get::<String,_>("status"),
            "referenceId":row.get::<String,_>("reference_id"),"customerRefId":row.try_get::<Option<String>,_>("partner_ref").ok().flatten(),
            "source":row.get::<String,_>("source"),"refunded":row.get::<bool,_>("refunded"),"createdAt":created_at.to_rfc3339(),"updatedAt":updated_at.to_rfc3339(),
            "vendorTrxId":row.try_get::<Option<String>,_>("provider_reference").ok().flatten(),
            "sn":row.get::<Value,_>("provider_result").get("sn").and_then(Value::as_str),
            "message":row.get::<Value,_>("provider_result").get("message").and_then(Value::as_str)
        })
    }).collect::<Vec<_>>();
    if !all_users {
        let guest_rows = match sqlx::query(
            "SELECT gt.id,gt.product_id,gt.user_id,gt.invoice_number,gt.target,gt.total_amount,gt.payment_status,gt.transaction_status,gt.created_at,gt.updated_at,gt.vendor_trx_id,gt.sn,gt.provider_result,COALESCE(p.name,'') product_name,COALESCE(p.code,'') product_code FROM guest_transactions gt LEFT JOIN products p ON p.id=gt.product_id WHERE gt.user_id=$1 ORDER BY gt.created_at DESC",
        ).bind(user_id).fetch_all(&state.pg_pool).await { Ok(rows)=>rows,Err(_)=>return internal_error() };
        items.extend(guest_rows.into_iter().map(|row| {
            let id=row.get::<uuid::Uuid,_>("id"); let created_at=row.get::<chrono::DateTime<chrono::Utc>,_>("created_at"); let updated_at=row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at");
            serde_json::json!({"_id":id.to_string(),"user":user_id.to_string(),"product":{"_id":row.get::<uuid::Uuid,_>("product_id").to_string(),"name":row.get::<String,_>("product_name"),"code":row.get::<String,_>("product_code")},"target":row.get::<String,_>("target"),"amount":row.get::<i64,_>("total_amount"),"status":row.get::<String,_>("transaction_status"),"paymentStatus":row.get::<String,_>("payment_status"),"referenceId":row.get::<String,_>("invoice_number"),"vendorTrxId":row.try_get::<Option<String>,_>("vendor_trx_id").ok().flatten(),"sn":row.try_get::<Option<String>,_>("sn").ok().flatten(),"source":"guest","createdAt":created_at.to_rfc3339(),"updatedAt":updated_at.to_rfc3339(),"providerResult":row.get::<Value,_>("provider_result")})
        }));
    }
    items.sort_by(|left,right| right.get("createdAt").and_then(Value::as_str).cmp(&left.get("createdAt").and_then(Value::as_str)));
    Json(Value::Array(items)).into_response()
}

fn normalize_status_payload(payload: StatusUpdatePayload) -> Result<StatusPayload, Response> {
    let status = payload.status.unwrap_or_default().trim().to_string();
    if !ALLOWED_TRANSACTION_STATUSES.contains(&status.as_str()) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Status transaksi tidak valid",
        ));
    }

    let note_source = payload.note.or(payload.message);
    let note = note_source.unwrap_or_default().trim().to_string();
    if note.len() > 500 {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Catatan status maksimal 500 karakter",
        ));
    }

    let vendor_trx_id = match payload.vendor_trx_id {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > 120 {
                return Err(status_message(
                    StatusCode::BAD_REQUEST,
                    "Vendor Trx ID maksimal 120 karakter",
                ));
            }
            Some(value)
        }
        None => None,
    };
    let sn = match payload.sn {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > 300 {
                return Err(status_message(
                    StatusCode::BAD_REQUEST,
                    "SN / Token maksimal 300 karakter",
                ));
            }
            Some(value)
        }
        None => None,
    };

    Ok(StatusPayload {
        status,
        vendor_trx_id,
        sn,
        note,
    })
}

fn build_admin_status_note(previous_status: &str, next_status: &str, note: &str) -> String {
    if note.is_empty() {
        format!("Manual status update: {previous_status} -> {next_status}")
    } else {
        note.to_string()
    }
}

fn normalize_payload_text(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn date_key(date: chrono::DateTime<chrono::Utc>) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn apply_transition_plan(
    current_status: &str,
    refunded: bool,
    amount: i64,
    next_status: &str,
) -> TransitionPlan {
    let mut balance_delta = 0;
    let mut next_refunded = refunded;

    if next_status == "failed" && !refunded {
        balance_delta = amount;
        next_refunded = true;
    } else if next_status != "failed" && refunded {
        balance_delta = -amount;
        next_refunded = false;
    }

    TransitionPlan {
        balance_delta,
        should_award_points: current_status != "success" && next_status == "success",
        should_revoke_points: current_status == "success" && next_status != "success",
        next_refunded,
    }
}

fn ref_id_sequence_exhausted() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Sequence Ref ID harian habis",
            "error": {
                "code": "REF_ID_SEQUENCE_EXHAUSTED",
                "message": "Sequence Ref ID harian habis"
            }
        })),
    )
        .into_response()
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "PostgreSQL unavailable",
    )
}

fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}
