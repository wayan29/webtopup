use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::require_proxy_context, state::AppState, utils::bson::read_string};

use super::{
    config::{digiflazz_credentials, tokovoucher_credentials, vendor_base_url},
    internal_error,
    providers::{
        fetch_digiflazz_balance_with_base_url, fetch_digiflazz_pricelist_remote,
        fetch_tokovoucher_balance_with_base_url, sync_product_items,
    },
    status_message, unavailable,
};

pub async fn test_vendor_connection(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found");
    };
    let db = client.database(&state.mongo_db);
    let Some(vendor) = (match db
        .collection::<Document>("vendors")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found");
    };

    let vendor_name = read_string(&vendor, "name").to_lowercase();
    if vendor_name.contains("digiflazz") {
        let credentials = digiflazz_credentials(Some(&vendor));
        let balance = fetch_digiflazz_balance_with_base_url(
            &credentials,
            &vendor_base_url(&vendor, "https://api.digiflazz.com/v1"),
        )
        .await;
        return Json(serde_json::json!({
            "success": true,
            "message": "Connection successful",
            "balance": balance
        }))
        .into_response();
    }

    if vendor_name.contains("tokovoucher") {
        let credentials = tokovoucher_credentials(Some(&vendor));
        let balance = match fetch_tokovoucher_balance_with_base_url(
            &credentials,
            &vendor_base_url(&vendor, "https://api.tokovoucher.net"),
        )
        .await
        {
            Ok(balance) => balance,
            Err(message) => {
                return Json(serde_json::json!({
                    "success": false,
                    "message": format!("Connection failed: {message}"),
                    "balance": 0
                }))
                .into_response();
            }
        };
        return Json(serde_json::json!({
            "success": true,
            "message": "Connection successful",
            "balance": balance
        }))
        .into_response();
    }

    Json(serde_json::json!({
        "success": false,
        "message": "Unknown vendor type",
        "balance": 0
    }))
    .into_response()
}

pub async fn sync_vendor_products(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found");
    };
    let db = client.database(&state.mongo_db);
    let vendor = match db
        .collection::<Document>("vendors")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(vendor)) => vendor,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => return internal_error(),
    };
    let vendor_name = read_string(&vendor, "name");
    let vendor_name_lower = vendor_name.to_lowercase();

    let sync_result = if vendor_name_lower.contains("digiflazz") {
        let credentials = digiflazz_credentials(Some(&vendor));
        let pricelist = fetch_digiflazz_pricelist_remote(
            &credentials,
            &vendor_base_url(&vendor, "https://api.digiflazz.com/v1"),
        )
        .await;
        sync_product_items(&db, &vendor_name, pricelist).await
    } else if vendor_name_lower.contains("tokovoucher") {
        Ok(0)
    } else {
        Err("Vendor type not supported for sync".to_string())
    };

    let synced_count = match sync_result {
        Ok(count) => count,
        Err(message) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "message": format!("Sync failed: {message}"),
                    "syncedCount": 0
                })),
            )
                .into_response();
        }
    };

    Json(serde_json::json!({
        "message": format!("Successfully synced {synced_count} products from {vendor_name}"),
        "syncedCount": synced_count
    }))
    .into_response()
}
