use std::sync::Arc;
use axum::{extract::State, http::HeaderMap, response::{IntoResponse, Response}, Json};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};
use sqlx::Row;
use crate::{routes::{transactions::{provider::top_up_vendor, types::RecheckProduct}, validation_engine::{product_validation_config_json, run_paid_validation, PaidValidationStatus}}, services::seller_sql, state::AppState};
use super::{is_valid_pulsa_code, non_negative_i64, send_seller_callback, text_from_value, SellerConfig, SellerPrepaidPayload};

const CHANNEL: &str = "digiflazz";
const PREPAID_PATH: &str = "/api/v2/digiflazz-seller/prepaid";

pub async fn prepaid(headers: HeaderMap, State(state): State<Arc<AppState>>, Json(payload): Json<SellerPrepaidPayload>) -> Response {
    let mut config = seller_config(&state).await;
    let ip = client_ip(&headers);
    let reference = payload.ref_id.as_ref().map(text_from_value).unwrap_or_default();
    let code = payload.pulsa_code.as_ref().map(text_from_value).unwrap_or_default().to_lowercase();
    let target = payload.hp.as_ref().map(text_from_value).unwrap_or_default();
    let price = non_negative_i64(payload.price.as_ref(), 0);
    let sign = payload.sign.as_ref().map(text_from_value).unwrap_or_default();
    let username = payload.username.as_ref().map(text_from_value).unwrap_or_default();
    let command = payload.commands.as_ref().map(text_from_value).unwrap_or_default().to_lowercase();
    if !config.allowed_ips.is_empty() && !config.allowed_ips.iter().any(|rule| super::ip_matches_rule(&ip, rule)) {
        use zeroize::Zeroize;
        config.api_key.zeroize();
        return reject(&state,&config,&ip,&reference,&code,&target,price,"204","Wrong authentication","rejected","IP tidak termasuk whitelist",false).await;
    }
    if config.username.is_empty() || config.api_key.is_empty() || reference.is_empty() || username.is_empty() || sign.is_empty() {
        use zeroize::Zeroize;
        config.api_key.zeroize();
        return reject(&state,&config,&ip,&reference,&code,&target,price,"204","Wrong authentication","rejected","Username, ref_id, atau sign tidak valid",false).await;
    }
    let valid_signature = username == config.username && verify_signature(&config.username,&config.api_key,&reference,&sign);
    use zeroize::Zeroize;
    config.api_key.zeroize();
    if !valid_signature {
        return reject(&state,&config,&ip,&reference,&code,&target,price,"204","Wrong authentication","rejected","Verifikasi signature Digiflazz Seller gagal",false).await;
    }
    if command != "topup" { return reject(&state,&config,&ip,&reference,&code,&target,price,"07","Unsupported command","failed","Command tidak didukung",true).await; }
    if let Some(response) = existing_order(&state,&config,&ip,&reference).await { return response; }
    if code.is_empty() || !is_valid_pulsa_code(&code) { return reject(&state,&config,&ip,&reference,&code,&target,price,"20","Code not found","failed","Pulsa code tidak valid",true).await; }
    if !valid_target(&target) { return reject(&state,&config,&ip,&reference,&code,&target,price,"14","Incorrect destination number","failed","Nomor tujuan tidak valid",true).await; }

    let row = match sqlx::query("SELECT m.product_id,m.enabled AS mapping_enabled,m.data AS mapping_data,p.code,p.cost_price::bigint AS cost_price,p.status,p.vendor_name,p.vendor_sku,p.validation FROM seller_mappings m JOIN products p ON p.id=m.product_id WHERE m.channel=$1 AND m.buyer_sku_code=$2")
        .bind(CHANNEL).bind(&code).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => row,
        _ => return reject(&state,&config,&ip,&reference,&code,&target,price,"20","Code not found","failed","Mapping pulsa code tidak ditemukan",true).await,
    };
    let enabled: bool = row.try_get("mapping_enabled").unwrap_or(false);
    let active: bool = row.try_get("status").unwrap_or(false);
    if !enabled || !active { return reject(&state,&config,&ip,&reference,&code,&target,price,"106","Product is temporarily out of service","failed","Produk sedang nonaktif",true).await; }
    let cost: i64 = row.try_get("cost_price").unwrap_or(0);
    let mapping: Value = row.try_get("mapping_data").unwrap_or_else(|_| json!({}));
    let margin = mapping.get("sellerMarginFlat").and_then(Value::as_i64).unwrap_or(config.seller_margin_flat);
    let amount = cost.saturating_add(margin).max(0);
    if price > 0 && price != amount { return reject(&state,&config,&ip,&reference,&code,&target,price,"07","Price mismatch","failed","Harga request tidak sama dengan harga seller",true).await; }

    let product_id: uuid::Uuid = match row.try_get("product_id") { Ok(value) => value, Err(_) => return internal_failure(&state,&config,&ip,&reference,&code,&target,price).await };
    let product_code: String = row.try_get("code").unwrap_or_default();
    let vendor_name: String = row.try_get("vendor_name").unwrap_or_default();
    let vendor_sku: String = row.try_get("vendor_sku").unwrap_or_default();
    let validation: Value = row.try_get("validation").unwrap_or_else(|_| json!({"enabled":false}));
    let product = json!({"code":product_code,"vendor":{"name":vendor_name,"sku":vendor_sku},"validation":validation});
    let validation_order = product_validation_config_json(&product).is_some();
    let transaction_id = generate_seller_ref_id();
    let snapshot = json!({"rc":"39","message":"Process","sn":"","vendorName":vendor_name,"vendorSku":vendor_sku,"callbackUrl":config.digiflazz_callback_url,"callbackRequired":config.callback_enabled,"validationOrder":validation_order,"pulsaCode":code,"target":target});
    let inserted = sqlx::query("INSERT INTO seller_orders(channel,reference_id,product_id,buyer_sku_code,customer_no,status,amount,snapshot,response,callback_url,vendor_reference,execution_token,execution_lease_until) VALUES($1,$2,$3,$4,$5,'processing',$6,$7,'{}'::jsonb,$8,$9,gen_random_uuid(),now()+interval '90 seconds') ON CONFLICT(channel,reference_id) DO NOTHING RETURNING id")
        .bind(CHANNEL).bind(&reference).bind(product_id).bind(&code).bind(&target).bind(amount).bind(&snapshot).bind(&config.digiflazz_callback_url).bind(&transaction_id).fetch_optional(&state.pg_pool).await;
    let order_id: uuid::Uuid = match inserted { Ok(Some(row)) => match row.try_get("id") { Ok(id) => id, Err(_) => return internal_failure(&state,&config,&ip,&reference,&code,&target,price).await }, _ => return existing_order(&state,&config,&ip,&reference).await.unwrap_or_else(||Json(error_response(&reference,&code,&target,price,"07","Failed",&config)).into_response()) };

    let updated = if let Some(validation_config) = product_validation_config_json(&product) {
        let (first, second) = validation_targets(&target);
        let result = run_paid_validation(&validation_config,&first,&second).await;
        let (status,message,sn) = match result.status { PaidValidationStatus::Success => ("success",Some(result.message.as_str()),result.sn.as_deref()), PaidValidationStatus::Failed => ("failed",Some(result.message.as_str()),None), PaidValidationStatus::ProviderError => ("pending",Some(result.message.as_str()),None) };
        persist_status(&state,order_id,status,None,message,sn,Some(&transaction_id)).await
    } else if vendor_name.is_empty() || vendor_sku.is_empty() {
        persist_status(&state,order_id,"failed",Some("106"),Some("Product is temporarily out of service"),None,None).await
    } else {
        let vendor_product = RecheckProduct { code: product_code, vendor_name, vendor_sku };
        match top_up_vendor(&state,&transaction_id,&target,"",&vendor_product).await {
            Ok(result) => persist_status(&state,order_id,&result.status,None,result.message.as_deref(),result.sn.as_deref(),result.vendor_trx_id.as_deref().or(Some(&transaction_id))).await,
            Err(_) => persist_status(&state,order_id,"failed",Some("07"),Some("Failed"),None,None).await,
        }
    };
    if let Some(order) = updated { send_callback_if_needed(&state,&order).await; record_request(&state,&reference,&order,&ip,true).await; Json(response_from_order(&order,&config)).into_response() }
    else { Json(error_response(&reference,&code,&target,price,"07","Failed",&config)).into_response() }
}

async fn seller_config(state:&AppState)->SellerConfig {
    let mut data=seller_sql::stored_settings(&state.pg_pool,CHANNEL).await.unwrap_or_else(|_|json!({}));
    let stored=data.get("apiKey").and_then(Value::as_str).unwrap_or_default().to_owned();
    let api_key=if crate::services::seller_secrets::is_envelope(&stored){crate::services::seller_secrets::open("digiflazz","apiKey",&stored).unwrap_or_default()}else{String::new()};
    data["apiKey"]=Value::Null;
    let text=|key:&str|data.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let base=text("publicBaseUrl").trim_end_matches('/').to_string();
    let allowed_ips=data.get("allowedIps").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    SellerConfig{username:text("username"),api_key,public_base_url:base.clone(),digiflazz_callback_url:text("digiflazzCallbackUrl"),server_ip:text("serverIp"),reported_balance:data.get("reportedBalance").and_then(Value::as_i64).unwrap_or(0),seller_margin_flat:data.get("sellerMarginFlat").and_then(Value::as_i64).unwrap_or(0),allowed_ips,callback_enabled:data.get("callbackEnabled").and_then(Value::as_bool).unwrap_or(true),prepaid_endpoint_path:PREPAID_PATH.into(),prepaid_endpoint_url:format!("{base}{PREPAID_PATH}")}
}
fn order_value(row:&sqlx::postgres::PgRow)->Value { let snapshot:Value=row.try_get("snapshot").unwrap_or_else(|_|json!({})); json!({"id":row.try_get::<uuid::Uuid,_>("id").map(|v|v.to_string()).unwrap_or_default(),"reference_id":row.try_get::<String,_>("reference_id").unwrap_or_default(),"buyer_sku_code":row.try_get::<String,_>("buyer_sku_code").unwrap_or_default(),"customer_no":row.try_get::<String,_>("customer_no").unwrap_or_default(),"status":row.try_get::<String,_>("status").unwrap_or_default(),"amount":row.try_get::<i64,_>("amount").unwrap_or_default(),"vendor_reference":row.try_get::<String,_>("vendor_reference").unwrap_or_default(),"callback_attempt_count":0,"callback_required":snapshot.get("callbackRequired").and_then(Value::as_bool).unwrap_or(false),"callback_url":row.try_get::<String,_>("callback_url").unwrap_or_default(),"rc":snapshot.get("rc").and_then(Value::as_str).unwrap_or("39"),"message":snapshot.get("message").and_then(Value::as_str).unwrap_or("Process"),"sn":snapshot.get("sn").and_then(Value::as_str).unwrap_or(""),"vendor_name":snapshot.get("vendorName").and_then(Value::as_str).unwrap_or(""),"vendor_sku":snapshot.get("vendorSku").and_then(Value::as_str).unwrap_or(""),"pulsaCode":row.try_get::<String,_>("buyer_sku_code").unwrap_or_default(),"target":row.try_get::<String,_>("customer_no").unwrap_or_default()}) }
async fn existing_order(state:&AppState,config:&SellerConfig,ip:&str,reference:&str)->Option<Response>{
    let row=seller_sql::order_by_reference(&state.pg_pool,CHANNEL,reference).await.ok().flatten()?; let mut order=order_value(&row);
    if order["status"]=="pending" && !row.try_get::<Value,_>("snapshot").ok().and_then(|v|v.get("validationOrder").and_then(Value::as_bool)).unwrap_or(false) {
        let id=order["id"].as_str().unwrap_or_default();
        let claim=sqlx::query("UPDATE seller_orders SET execution_token=gen_random_uuid(),execution_lease_until=now()+interval '90 seconds',status='processing' WHERE id=$1::uuid AND status='pending' AND (execution_lease_until IS NULL OR execution_lease_until<now()) RETURNING id").bind(id).fetch_optional(&state.pg_pool).await.ok().flatten();
        if claim.is_some(){let snapshot:Value=row.try_get("snapshot").unwrap_or_else(|_|json!({}));let p=RecheckProduct{code:order["buyer_sku_code"].as_str().unwrap_or_default().into(),vendor_name:snapshot.get("vendorName").and_then(Value::as_str).unwrap_or_default().into(),vendor_sku:snapshot.get("vendorSku").and_then(Value::as_str).unwrap_or_default().into()};if let Ok(result)=top_up_vendor(state,order["vendor_reference"].as_str().unwrap_or_default(),order["customer_no"].as_str().unwrap_or_default(),"",&p).await{if let Ok(id)=uuid::Uuid::parse_str(id){if let Some(value)=persist_status(state,id,&result.status,None,result.message.as_deref(),result.sn.as_deref(),result.vendor_trx_id.as_deref()).await{order=value;send_callback_if_needed(state,&order).await;}}}}
    }
    record_request(state,reference,&order,ip,true).await; Some(Json(response_from_order(&order,config)).into_response())
}
async fn persist_status(state:&AppState,id:uuid::Uuid,status:&str,rc:Option<&str>,message:Option<&str>,sn:Option<&str>,vendor_id:Option<&str>)->Option<Value>{
    let(wire,default_rc,default_message)=status_shape(status,rc,message);let normalized=match wire{"1"=>"success","2"=>"failed",_=>"pending"};
    let row=sqlx::query("UPDATE seller_orders SET status=$2,response=jsonb_build_object('rc',$3,'message',$4,'sn',$5),snapshot=snapshot||jsonb_build_object('rc',$3,'message',$4,'sn',$5,'vendorTrxId',$6),vendor_reference=COALESCE($6,vendor_reference),execution_token=NULL,execution_lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *").bind(id).bind(normalized).bind(default_rc).bind(default_message).bind(sn.unwrap_or("")).bind(vendor_id).fetch_optional(&state.pg_pool).await.ok().flatten()?;
    let order=order_value(&row);
    if normalized!="pending"&&order["callback_required"].as_bool().unwrap_or(false){let _=sqlx::query("INSERT INTO seller_callbacks(channel,ref_id,order_id,status,payload,callback_url) VALUES('digiflazz',$1,$2,$3,'{}'::jsonb,$4) ON CONFLICT(channel,ref_id) DO NOTHING").bind(order["reference_id"].as_str().unwrap_or_default()).bind(id).bind(normalized).bind(row.try_get::<String,_>("callback_url").unwrap_or_default()).execute(&state.pg_pool).await;}
    Some(order)
}
async fn send_callback_if_needed(state:&AppState,order:&Value){if order["status"]!="pending"&&order["callback_required"].as_bool().unwrap_or(false){let _=send_seller_callback(state,order).await;}}
async fn reject(state:&AppState,c:&SellerConfig,ip:&str,r:&str,code:&str,target:&str,price:i64,rc:&str,message:&str,status:&str,log:&str,verified:bool)->Response{seller_sql::record_event(&state.pg_pool,CHANNEL,"request",if r.is_empty(){"-"}else{r},status,log,verified,ip).await;Json(error_response(r,code,target,price,rc,message,c)).into_response()}
async fn internal_failure(s:&AppState,c:&SellerConfig,ip:&str,r:&str,code:&str,t:&str,p:i64)->Response{reject(s,c,ip,r,code,t,p,"07","Failed","failed","Order could not be stored",true).await}
async fn record_request(s:&AppState,r:&str,o:&Value,ip:&str,verified:bool){seller_sql::record_event(&s.pg_pool,CHANNEL,"request",r,o["status"].as_str().unwrap_or("pending"),o["message"].as_str().unwrap_or(""),verified,ip).await;}
fn response_from_order(o:&Value,c:&SellerConfig)->Value{build_response(o["reference_id"].as_str().unwrap_or(""),o["vendor_reference"].as_str().unwrap_or(""),o["buyer_sku_code"].as_str().unwrap_or(""),o["customer_no"].as_str().unwrap_or(""),o["amount"].as_i64().unwrap_or(0),o["status"].as_str().unwrap_or("pending"),o["rc"].as_str().unwrap_or("39"),o["message"].as_str().unwrap_or("Process"),o["sn"].as_str().unwrap_or(""),c.reported_balance)}
fn error_response(r:&str,code:&str,t:&str,p:i64,rc:&str,msg:&str,c:&SellerConfig)->Value{build_response(if r.is_empty(){"-"}else{r},if r.is_empty(){"-"}else{r},code,t,p,"failed",rc,msg,"",c.reported_balance)}
fn build_response(r:&str,tr:&str,code:&str,target:&str,price:i64,status:&str,rc:&str,msg:&str,sn:&str,balance:i64)->Value{let(status,rc,msg)=status_shape(status,Some(rc),Some(msg));json!({"data":{"ref_id":r,"status":status,"code":code,"hp":target,"price":price.to_string(),"message":msg,"balance":balance.to_string(),"tr_id":tr,"rc":rc,"sn":sn}})}
fn status_shape(s:&str,rc:Option<&str>,message:Option<&str>)->(&'static str,String,String){let(code,default_rc,default_message)=match s{"success"=>("1","00","Success"),"failed"|"rejected"=>("2","07","Failed"),_=>("0","39","Process")};(code,rc.filter(|v|!v.is_empty()).unwrap_or(default_rc).into(),message.filter(|v|!v.is_empty()).unwrap_or(default_message).into())}
fn verify_signature(username:&str,key:&str,ref_id:&str,sign:&str)->bool{let expected=format!("{username}{key}{ref_id}");constant_time_eq(expected.as_bytes(),sign.as_bytes())}
fn constant_time_eq(a:&[u8],b:&[u8])->bool{let mut diff=a.len()^b.len();for i in 0..a.len().max(b.len()){diff|=(a.get(i).copied().unwrap_or(0)^b.get(i).copied().unwrap_or(0))as usize;}diff==0}
fn valid_target(s:&str)->bool{!s.is_empty()&&s.len()<=64&&s.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'_'|'.'|'+'|'|'))}
fn validation_targets(s:&str)->(String,String){let mut parts=s.splitn(2,'|');(parts.next().unwrap_or_default().trim().into(),parts.next().unwrap_or_default().trim().into())}
fn client_ip(h:&HeaderMap)->String{h.get("x-forwarded-for").and_then(|v|v.to_str().ok()).and_then(|v|v.split(',').next_back()).map(str::trim).filter(|v|!v.is_empty()).or_else(||h.get("x-real-ip").and_then(|v|v.to_str().ok()).map(str::trim)).filter(|v|!v.is_empty()).unwrap_or("unknown").into()}
fn generate_seller_ref_id()->String{format!("DS{}",rand::thread_rng().sample_iter(&Alphanumeric).take(13).map(char::from).collect::<String>())}
