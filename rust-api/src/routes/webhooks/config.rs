use std::sync::Arc;

use axum::{extract::{Path, State}, response::{IntoResponse, Response}, Json};

use crate::{security::require_sql_permission, state::AppState};
use super::{responses::{internal_error, provider_not_found, status_message, unavailable}, store::{setting_string, tokovoucher_credentials_configured, upsert_setting}, types::{DigiflazzWebhookConfig, TokovoucherWebhookConfig, WebhookConfigPayload, WebhookSaveResponse}, utils::{has_whitelist, normalize_whitelist, protection_mode}};

pub async fn config(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(provider): Path<String>) -> Response {
    if let Err(response)=require_sql_permission(&headers,&state,"manageVendors").await{return response;}
    match provider.as_str(){"digiflazz"=>digiflazz_config(&state).await,"tokovoucher"=>tokovoucher_config(&state).await,_=>provider_not_found()}
}

pub async fn save_config(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Path(provider): Path<String>, Json(payload): Json<WebhookConfigPayload>) -> Response {
    if let Err(response)=require_sql_permission(&headers,&state,"manageVendors").await{return response;}
    match provider.as_str(){"digiflazz"=>save_digiflazz_config(&state,payload).await,"tokovoucher"=>save_tokovoucher_config(&state,payload).await,_=>provider_not_found()}
}

async fn digiflazz_config(state:&AppState)->Response {
    let secret=match setting_string(&state.pg_pool,"digiflazzWebhookSecret").await{Ok(v)=>v,Err(_)=>return unavailable()};
    let whitelist_ip=match setting_string(&state.pg_pool,"digiflazzWhitelistIP").await{Ok(v)=>v,Err(_)=>return unavailable()};
    let has_secret=!secret.is_empty();let has_ip=has_whitelist(&whitelist_ip);
    Json(DigiflazzWebhookConfig{secret:if has_secret{"********".into()}else{String::new()},configured:has_secret,whitelist_ip,protected:has_secret||has_ip,protection_mode:protection_mode(has_secret,has_ip).into()}).into_response()
}

async fn save_digiflazz_config(state:&AppState,payload:WebhookConfigPayload)->Response {
    let requested_secret=payload.secret.as_deref().map(str::trim).filter(|v|!v.is_empty()).map(str::to_owned);
    let current_secret=match setting_string(&state.pg_pool,"digiflazzWebhookSecret").await{Ok(v)=>v,Err(_)=>return unavailable()};
    let next_secret=requested_secret.clone().unwrap_or(current_secret);
    let next_whitelist=payload.whitelist_ip.as_deref().map(normalize_whitelist);
    let effective_whitelist=match &next_whitelist{Some(v)=>v.clone(),None=>match setting_string(&state.pg_pool,"digiflazzWhitelistIP").await{Ok(v)=>v,Err(_)=>return unavailable()}};
    if next_secret.is_empty()&&effective_whitelist.is_empty(){return status_message(axum::http::StatusCode::BAD_REQUEST,"Minimal atur secret atau whitelist IP untuk mengamankan webhook Digiflazz");}
    if let Some(secret)=requested_secret{if upsert_setting(&state.pg_pool,"digiflazzWebhookSecret",secret).await.is_err(){return internal_error();}}
    if let Some(whitelist)=next_whitelist{if upsert_setting(&state.pg_pool,"digiflazzWhitelistIP",whitelist).await.is_err(){return internal_error();}}
    Json(WebhookSaveResponse{message:"Webhook config saved"}).into_response()
}

async fn tokovoucher_config(state:&AppState)->Response {
    let whitelist_ip=match setting_string(&state.pg_pool,"tokovoucherWhitelistIP").await{Ok(v)=>v,Err(_)=>return unavailable()};
    let configured=match tokovoucher_credentials_configured(&state.pg_pool).await{Ok(v)=>v,Err(_)=>return unavailable()};let has_ip=has_whitelist(&whitelist_ip);
    Json(TokovoucherWebhookConfig{whitelist_ip,configured,protected:configured||has_ip,protection_mode:protection_mode(configured,has_ip).into()}).into_response()
}

async fn save_tokovoucher_config(state:&AppState,payload:WebhookConfigPayload)->Response {
    match tokovoucher_credentials_configured(&state.pg_pool).await{Ok(true)=>{},Ok(false)=>return status_message(axum::http::StatusCode::BAD_REQUEST,"Konfigurasi kredensial Tokovoucher terlebih dahulu sebelum mengatur webhook"),Err(_)=>return unavailable()}
    if let Some(whitelist)=payload.whitelist_ip.as_deref().map(normalize_whitelist){if upsert_setting(&state.pg_pool,"tokovoucherWhitelistIP",whitelist).await.is_err(){return internal_error();}}
    Json(WebhookSaveResponse{message:"Webhook config saved"}).into_response()
}
