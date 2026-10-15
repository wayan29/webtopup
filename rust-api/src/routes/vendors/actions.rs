use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    config::{digiflazz_credentials, tokovoucher_credentials, vendor_base_url},
    internal_error,
    providers::{fetch_digiflazz_balance_with_base_url, fetch_digiflazz_pricelist_remote, fetch_tokovoucher_balance_with_base_url, sync_product_items},
    status_message,
};

pub async fn test_vendor_connection(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Ok(vendor_id) = id.trim().parse::<uuid::Uuid>() else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found");
    };
    let vendor = match sqlx::query("SELECT id::text AS id, name, api_base_url, config, low_balance_threshold, status FROM vendors WHERE id = $1")
        .bind(vendor_id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => serde_json::json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "name": row.try_get::<String, _>("name").unwrap_or_default(),
            "api_base_url": row.try_get::<String, _>("api_base_url").unwrap_or_default(),
            "config": row.try_get::<Value, _>("config").unwrap_or_default(),
            "low_balance_threshold": row.try_get::<i64, _>("low_balance_threshold").unwrap_or_default(),
            "status": row.try_get::<bool, _>("status").unwrap_or(true),
        }),
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => return internal_error(),
    };

    let vendor_name = vendor.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    if vendor_name.contains("digiflazz") {
        let credentials = digiflazz_credentials(Some(&vendor));
        let balance = match fetch_digiflazz_balance_with_base_url(
            &credentials,
            &vendor_base_url(&vendor, "https://api.digiflazz.com/v1"),
        ).await {
            Ok(balance) => balance,
            Err(message) => return Json(serde_json::json!({"success": false, "message": format!("Connection failed: {message}"), "balance": null})).into_response(),
        };
        return Json(serde_json::json!({"success": true, "message": "Connection successful", "balance": balance})).into_response();
    }

    if vendor_name.contains("tokovoucher") {
        let credentials = tokovoucher_credentials(Some(&vendor));
        let balance = match fetch_tokovoucher_balance_with_base_url(
            &credentials,
            &vendor_base_url(&vendor, "https://api.tokovoucher.net"),
        ).await {
            Ok(balance) => balance,
            Err(message) => return Json(serde_json::json!({"success": false, "message": format!("Connection failed: {message}"), "balance": null})).into_response(),
        };
        return Json(serde_json::json!({"success": true, "message": "Connection successful", "balance": balance})).into_response();
    }

    Json(serde_json::json!({"success": false, "message": "Unknown vendor type", "balance": 0})).into_response()
}

pub async fn sync_vendor_products(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let Ok(vendor_id) = id.trim().parse::<uuid::Uuid>() else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found");
    };
    let vendor = match sqlx::query("SELECT id::text AS id, name, api_base_url, config, low_balance_threshold, status FROM vendors WHERE id = $1")
        .bind(vendor_id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => serde_json::json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "name": row.try_get::<String, _>("name").unwrap_or_default(),
            "api_base_url": row.try_get::<String, _>("api_base_url").unwrap_or_default(),
            "config": row.try_get::<Value, _>("config").unwrap_or_default(),
            "low_balance_threshold": row.try_get::<i64, _>("low_balance_threshold").unwrap_or_default(),
            "status": row.try_get::<bool, _>("status").unwrap_or(true),
        }),
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => return internal_error(),
    };
    let vendor_name = vendor.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let sync_result: Result<i64, String> = if vendor_name.to_lowercase().contains("digiflazz") {
        let credentials = digiflazz_credentials(Some(&vendor));
        let pricelist = fetch_digiflazz_pricelist_remote(&credentials, &vendor_base_url(&vendor, "https://api.digiflazz.com/v1")).await;
        if pricelist.is_empty() {
            Err("Gagal mengambil pricelist dari Digiflazz".to_string())
        } else {
            if sync_product_items(&state.pg_pool, &vendor_name, pricelist.clone()).await.is_err() { return internal_error(); }
            let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return internal_error() };
            if sqlx::query("SELECT pg_advisory_xact_lock(hashtext('provider_pricelist:digiflazz'))").execute(&mut *tx).await.is_err()
                || sqlx::query("DELETE FROM provider_pricelist WHERE provider='digiflazz'").execute(&mut *tx).await.is_err() { return internal_error(); }
            for item in &pricelist {
                let Some(sku) = item.get("buyer_sku_code").and_then(Value::as_str).filter(|sku| !sku.is_empty()) else { continue; };
                if sqlx::query("INSERT INTO provider_pricelist(provider,sku,data) VALUES ('digiflazz',$1,$2) ON CONFLICT(provider,sku) DO UPDATE SET data=excluded.data,updated_at=now()")
                    .bind(sku).bind(item).execute(&mut *tx).await.is_err() { return internal_error(); }
            }
            if tx.commit().await.is_err() { return internal_error(); }
            Ok(pricelist.len() as i64)
        }
    } else if vendor_name.to_lowercase().contains("tokovoucher") {
        Ok(0)
    } else { Err("Vendor type not supported for sync".to_string()) };
    let synced_count = match sync_result {
        Ok(count) => count,
        Err(message) => return (axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({"message": format!("Sync failed: {message}"), "syncedCount": 0}))).into_response(),
    };
    Json(serde_json::json!({"message": format!("Successfully synced {synced_count} products from {vendor_name}"), "syncedCount": synced_count})).into_response()
}
