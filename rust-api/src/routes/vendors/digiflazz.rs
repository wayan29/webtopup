use std::{collections::HashMap, sync::Arc};

use axum::{extract::{Query, State}, http::StatusCode, response::{IntoResponse, Response}, Json};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{security::require_sql_user, state::AppState};
use super::{
    config::{digiflazz_credentials, find_vendor_by_name, short_mask, vendor_base_url},
    internal_error,
    providers::{fetch_digiflazz_balance_with_base_url, fetch_digiflazz_pricelist_remote, send_digiflazz_transaction},
    status_message, types::{VendorBalanceErrorResponse, VendorBalanceResponse}, vendor_balance_bad_request,
};

#[derive(Deserialize)]
pub struct InternalPurchasePayload {
    #[serde(rename = "buyerSkuCode")]
    buyer_sku_code: String,
    #[serde(rename = "customerNo")]
    customer_no: String,
    note: Option<String>,
}

#[derive(Deserialize)]
pub struct InternalPurchaseQuery { limit: Option<i64> }

pub async fn create_digiflazz_internal_purchase(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InternalPurchasePayload>,
) -> Response {
    let actor = match require_sql_user(&headers, &state).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let buyer_sku_code = payload.buyer_sku_code.trim();
    let customer_no = payload.customer_no.trim();
    if buyer_sku_code.is_empty() || customer_no.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "SKU dan nomor tujuan wajib diisi");
    }
    let product = match sqlx::query_scalar::<_, Value>(
        "SELECT data FROM provider_pricelist WHERE provider = 'digiflazz' AND sku = $1",
    ).bind(buyer_sku_code).fetch_optional(&state.pg_pool).await {
        Ok(Some(product)) => product,
        Ok(None) => return status_message(StatusCode::NOT_FOUND, "Produk Digiflazz tidak ditemukan"),
        Err(_) => return internal_error(),
    };
    if product.get("seller_product_status").and_then(Value::as_bool) == Some(false) {
        return status_message(StatusCode::BAD_REQUEST, "Produk Digiflazz nonaktif");
    }
    let vendor = find_vendor_by_name(&state.pg_pool, "digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "Digiflazz credentials not configured");
    }
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor, "https://api.digiflazz.com/v1"))
        .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let purchase_id = Uuid::new_v4();
    let ref_id = format!("INTDGF{}", purchase_id.simple());
    let now = Utc::now();
    let mut purchase = json!({
        "id": purchase_id, "provider": "digiflazz", "buyerSkuCode": buyer_sku_code,
        "productName": product.get("product_name").and_then(Value::as_str).unwrap_or_default(),
        "customerNo": customer_no,
        "price": product.get("price").and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|v| v as i64))).unwrap_or(0),
        "refId": ref_id, "status": "pending", "message": "Transaksi internal dibuat",
        "createdBy": {"id": actor.id, "name": actor.email, "email": actor.email, "role": actor.role},
        "note": payload.note.unwrap_or_default().trim(), "createdAt": now, "updatedAt": now,
    });
    // Persist the pending operation before any provider transaction is sent.
    if insert_purchase(&state.pg_pool, purchase_id, "digiflazz", &ref_id, &purchase).await.is_err() {
        return internal_error();
    }
    let result = send_digiflazz_transaction(&credentials, &base_url, buyer_sku_code, customer_no, &ref_id).await;
    purchase["status"] = json!(result.status);
    purchase["message"] = json!(result.message);
    purchase["sn"] = json!(result.sn.unwrap_or_default());
    purchase["providerResponse"] = result.raw;
    purchase["updatedAt"] = json!(Utc::now());
    let saved = match update_purchase(&state.pg_pool, purchase_id, &purchase).await {
        Ok(saved) => saved,
        Err(_) => return internal_error(),
    };
    Json(json!({"success": true, "message": result.message, "data": saved})).into_response()
}

pub(super) async fn insert_purchase(pool: &PgPool, id: Uuid, provider: &str, ref_id: &str, data: &Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO internal_provider_purchases (id,provider,ref_id,data) VALUES ($1,$2,$3,$4)")
        .bind(id).bind(provider).bind(ref_id).bind(data).execute(pool).await?;
    Ok(())
}

pub(super) async fn update_purchase(pool: &PgPool, id: Uuid, data: &Value) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar("UPDATE internal_provider_purchases SET data=$2,updated_at=now() WHERE id=$1 RETURNING data")
        .bind(id).bind(data).fetch_one(pool).await
}

pub(super) async fn list_purchases(pool: &PgPool, provider: &str, limit: i64) -> Response {
    let items = match sqlx::query_scalar::<_, Value>("SELECT data FROM internal_provider_purchases WHERE provider=$1 ORDER BY created_at DESC,id DESC LIMIT $2")
        .bind(provider).bind(limit.clamp(1,100)).fetch_all(pool).await {
        Ok(items) => items,
        Err(_) => return internal_error(),
    };
    Json(json!({"success": true, "data": items})).into_response()
}

pub async fn digiflazz_internal_purchases(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<InternalPurchaseQuery>) -> Response {
    if let Err(response) = require_sql_user(&headers, &state).await { return response; }
    list_purchases(&state.pg_pool, "digiflazz", query.limit.unwrap_or(20)).await
}

pub async fn digiflazz_pricelist(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<HashMap<String,String>>) -> Response {
    if let Err(response) = require_sql_user(&headers, &state).await { return response; }
    let total = match sqlx::query_scalar::<_, i64>("SELECT count(*) FROM provider_pricelist WHERE provider='digiflazz'").fetch_one(&state.pg_pool).await {
        Ok(total) => total, Err(_) => return internal_error(),
    };
    if total == 0 {
        return Json(json!({"success":false,"message":"Pricelist kosong. Klik \"Get Pricelist\" di halaman settings Digiflazz untuk mengambil data.","data":[],"total":0,"filters":{"categories":[],"brands":[]}})).into_response();
    }
    let category = query_filter(&query,"category");
    let brand = query_filter(&query,"brand");
    let sku = query_filter(&query,"sku");
    let search = query_filter(&query,"search");
    let page = parse_positive_i64(query.get("page"),1,i64::MAX);
    let limit = parse_positive_i64(query.get("limit"),50,1000);
    let filter = "provider='digiflazz' AND ($1='' OR strpos(lower(coalesce(data->>'category','')),lower($1))>0) AND ($2='' OR strpos(lower(coalesce(data->>'brand','')),lower($2))>0) AND ($3='' OR strpos(lower(coalesce(data->>'buyer_sku_code','')),lower($3))>0) AND ($4='' OR strpos(lower(coalesce(data->>'product_name','')),lower($4))>0 OR strpos(lower(coalesce(data->>'buyer_sku_code','')),lower($4))>0 OR strpos(lower(coalesce(data->>'brand','')),lower($4))>0)";
    let count_sql = format!("SELECT count(*) FROM provider_pricelist WHERE {filter}");
    let filtered_total = match sqlx::query_scalar::<_,i64>(&count_sql).bind(category).bind(brand).bind(sku).bind(search).fetch_one(&state.pg_pool).await {
        Ok(total) => total, Err(_) => return internal_error(),
    };
    let data_sql = format!("SELECT data FROM provider_pricelist WHERE {filter} ORDER BY sku LIMIT $5 OFFSET $6");
    let data = match sqlx::query_scalar::<_,Value>(&data_sql).bind(category).bind(brand).bind(sku).bind(search).bind(limit).bind((page-1).saturating_mul(limit)).fetch_all(&state.pg_pool).await {
        Ok(data) => data, Err(_) => return internal_error(),
    };
    let categories = match sqlx::query_scalar::<_,String>("SELECT DISTINCT data->>'category' FROM provider_pricelist WHERE provider='digiflazz' AND jsonb_typeof(data->'category')='string' AND ($1='' OR strpos(lower(coalesce(data->>'brand','')),lower($1))>0) ORDER BY 1")
        .bind(brand).fetch_all(&state.pg_pool).await { Ok(items) => items, Err(_) => return internal_error() };
    let brands = match sqlx::query_scalar::<_,String>("SELECT DISTINCT data->>'brand' FROM provider_pricelist WHERE provider='digiflazz' AND jsonb_typeof(data->'brand')='string' AND ($1='' OR strpos(lower(coalesce(data->>'category','')),lower($1))>0) ORDER BY 1")
        .bind(category).fetch_all(&state.pg_pool).await { Ok(items) => items, Err(_) => return internal_error() };
    Json(json!({"success":true,"data":data,"total":filtered_total,"page":page,"limit":limit,"totalPages":filtered_total/limit+i64::from(filtered_total%limit != 0),"filters":{"categories":categories,"brands":brands}})).into_response()
}

pub async fn fetch_digiflazz_pricelist(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_sql_user(&headers,&state).await { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool,"digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() {
        return status_message(StatusCode::BAD_REQUEST,"Digiflazz credentials not configured");
    }
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor,"https://api.digiflazz.com/v1")).unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let pricelist = fetch_digiflazz_pricelist_remote(&credentials,&base_url).await;
    if pricelist.is_empty() { return status_message(StatusCode::BAD_REQUEST,"Gagal mengambil pricelist dari Digiflazz"); }
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return internal_error() };
    // Serialize full snapshot replacements for this provider.
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtext('provider_pricelist:digiflazz'))").execute(&mut *tx).await.is_err()
        || sqlx::query("DELETE FROM provider_pricelist WHERE provider='digiflazz'").execute(&mut *tx).await.is_err() { return internal_error(); }
    for item in &pricelist {
        let Some(sku) = item.get("buyer_sku_code").and_then(Value::as_str).filter(|sku| !sku.is_empty()) else { return internal_error() };
        if sqlx::query("INSERT INTO provider_pricelist(provider,sku,data) VALUES ('digiflazz',$1,$2) ON CONFLICT(provider,sku) DO UPDATE SET data=excluded.data,updated_at=now()")
            .bind(sku).bind(item).execute(&mut *tx).await.is_err() { return internal_error(); }
    }
    if tx.commit().await.is_err() { return internal_error(); }
    Json(json!({"success":true,"message":format!("Berhasil mengambil {} produk dari Digiflazz",pricelist.len()),"total":pricelist.len()})).into_response()
}

pub async fn digiflazz_balance(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_sql_user(&headers,&state).await { return response; }
    let vendor = find_vendor_by_name(&state.pg_pool,"digiflazz").await;
    let credentials = digiflazz_credentials(vendor.as_ref());
    if credentials.username.is_empty() || credentials.secret.is_empty() { return vendor_balance_bad_request("Digiflazz credentials not configured"); }
    let base_url = vendor.as_ref().map(|vendor| vendor_base_url(vendor,"https://api.digiflazz.com/v1")).unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string());
    let balance = match fetch_digiflazz_balance_with_base_url(&credentials,&base_url).await {
        Ok(balance) => balance,
        Err(_) => return (StatusCode::BAD_GATEWAY,Json(VendorBalanceErrorResponse {message:"Digiflazz balance unavailable".to_string(),balance:None})).into_response(),
    };
    Json(VendorBalanceResponse {provider_field:"username",provider_value:short_mask(&credentials.username),balance}).into_response()
}

fn query_filter<'a>(query: &'a HashMap<String,String>, key: &str) -> &'a str {
    query.get(key).filter(|value| !value.trim().is_empty()).map(String::as_str).unwrap_or_default()
}

fn parse_positive_i64(value: Option<&String>, fallback: i64, max: i64) -> i64 {
    value.and_then(|value| value.parse::<i64>().ok()).filter(|value| *value>0).map(|value| value.min(max)).unwrap_or(fallback)
}
