fn validation_targets_from_tujuan(value: &str) -> (String, String) {
    let mut parts = value.splitn(2, '|');
    (parts.next().unwrap_or_default().trim().to_owned(), parts.next().unwrap_or_default().trim().to_owned())
}

use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, response::{IntoResponse, Response}, Json};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, Row};
use uuid::Uuid;

use crate::{
    routes::{transactions::{provider::top_up_vendor, types::RecheckProduct}, validation_engine::{product_validation_config_json, run_paid_validation, PaidValidationStatus}},
    state::AppState,
};

use super::types::{constant_time_required_match, text_value};
use super::{client_ip, ip_matches_rule, IRS_PROVIDER};

const IRS_STORAGE_FAILURE_MESSAGE: &str = "Layanan IRS Seller tidak tersedia";
const IRS_EXECUTION_FAILURE_MESSAGE: &str = "Transaksi IRS gagal diproses";

pub async fn prepaid(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<Value>) -> Response {
    let config = match crate::services::seller_sql::stored_settings(&state.pg_pool, "irs").await { Ok(config)=>config,Err(_)=>return irs_response("-","-","-","2","",IRS_STORAGE_FAILURE_MESSAGE) };
    let ref_id=text_value(&payload,&["ref_id","refId","id_trx"]).unwrap_or_default();
    let produk=text_value(&payload,&["produk","productCode","kode_produk"]).unwrap_or_default().to_lowercase();
    let tujuan=text_value(&payload,&["tujuan","target","hp"]).unwrap_or_default();
    let request_ip=client_ip(&headers);
    if ref_id.is_empty()||produk.is_empty()||tujuan.is_empty(){log_irs(&state,&ref_id,"failed","Field ref_id, produk, atau tujuan kosong",false,&request_ip).await;return irs_response(&ref_id,&produk,&tujuan,"2","","Field ref_id, produk, atau tujuan wajib diisi")}
    if !config.get("enabled").and_then(Value::as_bool).unwrap_or(false){log_irs(&state,&ref_id,"failed","IRS Seller belum aktif",false,&request_ip).await;return irs_response(&ref_id,&produk,&tujuan,"2","","IRS Seller belum aktif")}
    let allowed_ips=config.get("allowedIps").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
    if !allowed_ips.is_empty()&&!allowed_ips.iter().any(|ip|ip_matches_rule(&request_ip,ip)){log_irs(&state,&ref_id,"failed","IP tidak diizinkan",false,&request_ip).await;return irs_response(&ref_id,&produk,&tujuan,"2","","Wrong authentication")}
    if !valid_credentials(&payload,&config){log_irs(&state,&ref_id,"failed","Credential IRS tidak valid",false,&request_ip).await;return irs_response(&ref_id,&produk,&tujuan,"2","","Wrong authentication")}
    let existing=match crate::services::seller_sql::order_by_reference(&state.pg_pool,"irs",&ref_id).await{Ok(row)=>row,Err(_)=>return irs_response(&ref_id,&produk,&tujuan,"2","",IRS_STORAGE_FAILURE_MESSAGE)};
    if let Some(row)=existing { if row.try_get::<String,_>("snapshot").is_ok() { return execute_irs_order(&state,row,&request_ip).await; } }
    let mapping=match sqlx::query("SELECT m.id,m.product_id,m.data,p.code,p.status,p.name,p.vendor_name,p.vendor_sku,p.validation FROM seller_mappings m JOIN products p ON p.id=m.product_id WHERE m.channel='irs' AND m.buyer_sku_code=$1 AND m.enabled=true").bind(&produk).fetch_optional(&state.pg_pool).await{Ok(Some(row))=>row,Ok(None)=>{log_irs(&state,&ref_id,"failed","Mapping produk IRS Seller tidak ditemukan",true,&request_ip).await;return irs_response(&ref_id,&produk,&tujuan,"2","","Produk tidak ditemukan")},Err(_)=>return irs_response(&ref_id,&produk,&tujuan,"2","",IRS_STORAGE_FAILURE_MESSAGE)};
    if !mapping.get::<bool,_>("status"){return irs_response(&ref_id,&produk,&tujuan,"2","","Produk sedang nonaktif")}
    let internal_ref_id=generate_irs_ref_id();
    let vendor_name:String=mapping.get("vendor_name"); let sku:String=mapping.get("vendor_sku"); let vendor_sku=if sku.is_empty(){mapping.get::<String,_>("code")}else{sku};
    let product_id:Uuid=mapping.get("product_id"); let mapping_data:Value=mapping.get("data");
    let validation_value:Option<Value>=mapping.try_get("validation").ok();
    let validation_order=validation_value.as_ref().and_then(|value|crate::routes::validation_engine::product_validation_config_json(&serde_json::json!({"validation":value}))).is_some();
    let snapshot=json!({"internalRefId":internal_ref_id,"irsCode":produk,"productCode":produk,"target":tujuan,"sn":"","vendorName":vendor_name,"vendorSku":vendor_sku,"vendorTrxId":internal_ref_id,"requestIp":request_ip,"validationOrder":validation_order,"executionState":"ready"});
    let response=json!({"status":"pending","statusCode":"3","message":"Pending","sn":""});
    let inserted=sqlx::query("INSERT INTO seller_orders(channel,reference_id,product_id,buyer_sku_code,customer_no,status,amount,snapshot,response,vendor_reference) VALUES('irs',$1,$2,$3,$4,'pending',$5,$6,$7,$8) ON CONFLICT(channel,reference_id) DO NOTHING RETURNING id,snapshot,response,reference_id,status,product_id,buyer_sku_code,customer_no,amount,created_at,updated_at")
      .bind(&ref_id).bind(product_id).bind(&produk).bind(&tujuan).bind(mapping_data.get("price").and_then(Value::as_i64).unwrap_or_default()).bind(snapshot).bind(response).bind(&internal_ref_id).fetch_optional(&state.pg_pool).await;
    let row=match inserted{Ok(Some(row))=>row,Ok(None)=>match crate::services::seller_sql::order_by_reference(&state.pg_pool,"irs",&ref_id).await{Ok(Some(row))=>row, _=>return irs_response(&ref_id,&produk,&tujuan,"2","",IRS_STORAGE_FAILURE_MESSAGE)},Err(_)=>return irs_response(&ref_id,&produk,&tujuan,"2","",IRS_STORAGE_FAILURE_MESSAGE)};
    execute_irs_order(&state,row,&request_ip).await
}

async fn execute_irs_order(state:&Arc<AppState>, order:PgRow, request_ip:&str)->Response {
    let id:Uuid=order.get("id"); let ref_id:String=order.get("reference_id"); let produk:String=order.get("buyer_sku_code"); let tujuan:String=order.get("customer_no");
    let claimed=sqlx::query("UPDATE seller_orders SET status='processing',execution_token=$2,execution_lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND status='pending' AND (execution_token IS NULL OR execution_lease_until<now()) RETURNING snapshot").bind(id).bind(Uuid::new_v4()).fetch_optional(&state.pg_pool).await;
    let snapshot=match claimed{Ok(Some(row))=>row.get::<Value,_>("snapshot"),Ok(None)=>return match crate::services::seller_sql::order_by_reference(&state.pg_pool,"irs",&ref_id).await{Ok(Some(row))=>irs_response_from_sql(&row),_=>irs_response(&ref_id,&produk,&tujuan,"3","","Pending")},Err(_)=>return irs_response(&ref_id,&produk,&tujuan,"2","",IRS_STORAGE_FAILURE_MESSAGE)};
    let internal_ref_id=text_value(&snapshot,&["internalRefId"]).unwrap_or_default();
    let validation=snapshot.get("validationOrder").and_then(Value::as_bool).unwrap_or(false);
    let (status,message,sn,vendor_ref)=if validation {
        let validation=sqlx::query_scalar::<_,Value>("SELECT validation FROM products WHERE id=$1").bind(order.get::<Uuid,_>("product_id")).fetch_optional(&state.pg_pool).await.ok().flatten();
        match validation.and_then(|value|crate::routes::validation_engine::product_validation_config_json(&serde_json::json!({"validation":value}))) {
            Some(config)=>{let(target,secondary)=validation_targets_from_tujuan(&tujuan);let result=run_paid_validation(&config,&target,&secondary).await;match result.status{PaidValidationStatus::Success=>("success".to_string(),result.message,result.sn.unwrap_or_default(),Some(internal_ref_id)),PaidValidationStatus::Failed=>("failed".to_string(),result.message,String::new(),Some(internal_ref_id)),PaidValidationStatus::ProviderError=>("pending".to_string(),result.message,String::new(),Some(internal_ref_id))}},
            None=>("failed".to_string(),IRS_EXECUTION_FAILURE_MESSAGE.to_string(),String::new(),None),
        }
    } else {
        let vendor_name=text_value(&snapshot,&["vendorName"]).unwrap_or_default(); let vendor_sku=text_value(&snapshot,&["vendorSku"]).unwrap_or_default();
        if vendor_name.is_empty()||vendor_sku.is_empty(){("failed".to_string(),"Produk belum punya vendor supplier yang bisa diproses".to_string(),String::new(),None)}else{
            let recheck=RecheckProduct{code:produk.clone(),vendor_name,vendor_sku};
            match top_up_vendor(state,&internal_ref_id,&tujuan,"",&recheck).await{Ok(result)=>{let status=result.status;let message=result.message.unwrap_or_else(||default_irs_message(&status));let trx=result.vendor_trx_id.filter(|v|!v.is_empty()).or(Some(internal_ref_id));(status,message,result.sn.unwrap_or_default(),trx)},Err(_)=>("failed".to_string(),IRS_EXECUTION_FAILURE_MESSAGE.to_string(),String::new(),Some(internal_ref_id))}
        }
    };
    let status_code=irs_status_code(&status);
    let response=json!({"status":status,"statusCode":status_code,"message":message,"sn":sn});
    let next_snapshot=json!({"internalRefId":snapshot.get("internalRefId"),"irsCode":produk,"productCode":produk,"target":tujuan,"sn":sn,"message":message,"vendorName":snapshot.get("vendorName"),"vendorSku":snapshot.get("vendorSku"),"vendorTrxId":vendor_ref,"requestIp":request_ip,"validationOrder":validation,"executionState":"completed"});
    let update=sqlx::query("UPDATE seller_orders SET status=$2,response=$3,snapshot=$4,vendor_reference=COALESCE($5,vendor_reference),execution_token=NULL,execution_lease_until=NULL,updated_at=now() WHERE id=$1 AND status='processing' RETURNING *").bind(id).bind(if status=="success"{"success"}else if status=="failed"{"failed"}else{"pending"}).bind(response).bind(next_snapshot).bind(vendor_ref).fetch_optional(&state.pg_pool).await;
    match update{Ok(Some(row))=>{log_irs(state,&ref_id,&status,&message,true,request_ip).await;irs_response_from_sql(&row)},_=>irs_response(&ref_id,&produk,&tujuan,"3","","Pending")}
}

fn irs_response_from_sql(row:&PgRow)->Response{let snapshot:Value=row.get("snapshot");let response:Value=row.get("response");let status=response.get("status").and_then(Value::as_str).unwrap_or("pending");irs_response(&row.get::<String,_>("reference_id"),&row.get::<String,_>("buyer_sku_code"),&row.get::<String,_>("customer_no"),irs_status_code(status),response.get("sn").and_then(Value::as_str).unwrap_or(""),response.get("message").and_then(Value::as_str).or_else(||snapshot.get("message").and_then(Value::as_str)).unwrap_or("Pending"))}
fn default_irs_message(status:&str)->String{match status{"success"=>"BERHASIL".into(),"failed"=>"GAGAL".into(),_=>"Pending".into()}}
fn generate_irs_ref_id()->String{let suffix:String=rand::thread_rng().sample_iter(&Alphanumeric).take(13).map(char::from).collect();format!("IRS{suffix}")}
async fn log_irs(state:&AppState,ref_id:&str,status:&str,message:&str,verified:bool,request_ip:&str){crate::services::seller_sql::record_event(&state.pg_pool,"irs","request",ref_id,status,message,verified,request_ip).await;}
pub(super) fn irs_status_code(status:&str)->&'static str{match status{"success"=>"1","failed"=>"2",_=>"3"}}
fn irs_response(ref_id:&str,produk:&str,tujuan:&str,statuscode:&str,sn:&str,msg:&str)->Response{Json(irs_response_value(ref_id,produk,tujuan,statuscode,sn,msg)).into_response()}
pub(super) fn irs_response_value(ref_id:&str,produk:&str,tujuan:&str,statuscode:&str,sn:&str,msg:&str)->Value{json!({"data":{"ref_id":if ref_id.is_empty(){"-"}else{ref_id},"produk":if produk.is_empty(){"-"}else{produk},"tujuan":if tujuan.is_empty(){"-"}else{tujuan},"statuscode":statuscode,"sn":sn,"msg":msg}})}
fn valid_credentials(payload:&Value,config:&Value)->bool{[(&["merchant_id","merchantId","username","user"][..],"merchantId"),(&["pass","password"][..],"password"),(&["pin"][..],"pin"),(&["secret","sign","id"][..],"secret")].iter().all(|(aliases,key)|{let stored=config.get(*key).and_then(Value::as_str).unwrap_or("");let Some(mut expected)=crate::services::seller_secrets::open("irs",key,stored).ok() else{return false};let mut provided=text_value(payload,aliases).unwrap_or_default();let valid=expected.len()==provided.len()&&bool::from(subtle::ConstantTimeEq::ct_eq(expected.as_bytes(),provided.as_bytes()));use zeroize::Zeroize;expected.zeroize();provided.zeroize();valid})}
