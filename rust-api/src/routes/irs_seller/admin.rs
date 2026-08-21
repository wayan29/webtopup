use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
    response::Response,
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::Serialize;
use serde_json::Value;

use crate::{
    security::require_proxy_context,
    state::AppState,
    utils::bson::{optional_i64, read_i64, read_string},
};

use super::{date_string, document_id, internal_error, status_message, unavailable};
use super::types::{irs_admin_order_item, irs_log_item, IrsAdminOrdersResponse, IrsLogItem};

pub async fn mappings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find(doc! {})
        .sort(doc! { "updatedAt": -1 })
        .limit(200)
        .await
    {
        Ok(cursor) => match cursor.try_collect::<Vec<_>>().await {
            Ok(docs) => docs,
            Err(_) => return internal_error(),
        },
        Err(_) => return internal_error(),
    };
    Json(IrsMappingsResponse {
        items: docs.iter().map(irs_mapping_item).collect(),
    })
    .into_response()
}

pub async fn save_mapping(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(_payload): Json<Value>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(_client) = &state.mongo_client else {
        return unavailable();
    };
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "IRS Seller memakai mapping produk Digiflazz Seller",
    )
}

pub async fn delete_mapping(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(_id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(_client) = &state.mongo_client else {
        return unavailable();
    };
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "IRS Seller memakai mapping produk Digiflazz Seller",
    )
}

pub async fn admin_orders(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = match recent_docs(
        &client.database(&state.mongo_db),
        "irssellerorders",
        doc! {},
    )
    .await
    {
        Ok(docs) => docs,
        Err(_) => return internal_error(),
    };
    Json(IrsAdminOrdersResponse {
        items: docs.iter().map(irs_admin_order_item).collect(),
    })
    .into_response()
}

pub async fn logs(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = match recent_docs(
        &client.database(&state.mongo_db),
        "webhookeventlogs",
        doc! { "provider": "irs_seller" },
    )
    .await
    {
        Ok(docs) => docs,
        Err(_) => return internal_error(),
    };
    Json(docs.iter().map(irs_log_item).collect::<Vec<IrsLogItem>>()).into_response()
}

async fn recent_docs(
    db: &mongodb::Database,
    collection: &str,
    filter: Document,
) -> mongodb::error::Result<Vec<Document>> {
    let cursor = db
        .collection::<Document>(collection)
        .find(filter)
        .sort(doc! { "createdAt": -1, "_id": -1 })
        .limit(100)
        .await?;
    cursor.try_collect::<Vec<_>>().await
}

#[derive(Serialize)]
struct IrsMappingsResponse {
    items: Vec<IrsMappingItem>,
}

#[derive(Serialize)]
struct IrsMappingItem {
    id: String,
    #[serde(rename = "productId")]
    product_id: String,
    #[serde(rename = "pulsaCode")]
    pulsa_code: String,
    price: i64,
    #[serde(rename = "sellerMarginFlat")]
    seller_margin_flat: Option<i64>,
    #[serde(rename = "isActive")]
    is_active: bool,
    #[serde(rename = "lastSyncStatus")]
    last_sync_status: String,
    #[serde(rename = "lastSyncRc")]
    last_sync_rc: String,
    #[serde(rename = "lastSyncMessage")]
    last_sync_message: String,
    #[serde(rename = "lastSyncAt")]
    last_sync_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

fn irs_mapping_item(mapping: &Document) -> IrsMappingItem {
    let last_sync_at = date_string(mapping, "lastSyncAt");
    IrsMappingItem {
        id: document_id(mapping),
        product_id: mapping
            .get_object_id("product")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        pulsa_code: read_string(mapping, "pulsaCode"),
        price: read_i64(mapping, "price"),
        seller_margin_flat: optional_i64(mapping, "sellerMarginFlat"),
        is_active: mapping.get_bool("isActive").unwrap_or(false),
        last_sync_status: read_string(mapping, "lastSyncStatus"),
        last_sync_rc: read_string(mapping, "lastSyncRc"),
        last_sync_message: read_string(mapping, "lastSyncMessage"),
        last_sync_at: if last_sync_at.is_empty() {
            None
        } else {
            Some(last_sync_at)
        },
        updated_at: date_string(mapping, "updatedAt"),
    }
}
