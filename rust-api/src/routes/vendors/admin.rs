use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    internal_error,
    json::{config_to_json, date_string, normalize_non_negative_number, value_to_bson},
    status_message,
    types::VendorItem,
    types::VendorPayload,
    unavailable,
};

pub async fn admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let vendor_docs = match db
        .collection::<Document>("vendors")
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    let items = vendor_docs
        .into_iter()
        .map(vendor_item_from_doc)
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn admin_detail(
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
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                message: "Internal Server Error",
            }),
        )
            .into_response();
    };

    match client
        .database(&state.mongo_db)
        .collection::<Document>("vendors")
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    {
        Some(document) => Json(vendor_item_from_doc(document)).into_response(),
        None => (
            axum::http::StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                message: "Vendor not found",
            }),
        )
            .into_response(),
    }
}

pub async fn create_vendor(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<VendorPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let vendors = client
        .database(&state.mongo_db)
        .collection::<Document>("vendors");
    let name = payload.name.unwrap_or_default();

    if vendors
        .find_one(doc! { "name": &name })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Vendor already exists");
    }

    let now = DateTime::now();
    let mut document = Document::new();
    document.insert("name", name);
    document.insert("apiBaseUrl", payload.api_base_url.unwrap_or_default());
    document.insert(
        "config",
        value_to_bson(payload.config.unwrap_or_else(|| serde_json::json!({}))),
    );
    document.insert(
        "lowBalanceThreshold",
        normalize_non_negative_number(payload.low_balance_threshold.as_ref(), 0),
    );
    document.insert("status", payload.status.unwrap_or(true));
    document.insert("createdAt", now);
    document.insert("updatedAt", now);
    document.insert("__v", 0);

    let inserted_id = match vendors.insert_one(document).await {
        Ok(result) => result.inserted_id.as_object_id().map(|id| id.to_hex()),
        Err(error) => {
            if is_duplicate_key(&error) {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Vendor already exists",
                );
            }
            return internal_error();
        }
    };
    let vendor = match inserted_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(id) => vendors
            .find_one(doc! { "_id": id })
            .await
            .ok()
            .flatten()
            .map(vendor_item_from_doc),
        None => None,
    };

    (
        axum::http::StatusCode::CREATED,
        Json(serde_json::json!({
            "message": "Vendor created successfully",
            "vendor": vendor,
        })),
    )
        .into_response()
}

pub async fn update_vendor(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<VendorPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return internal_error();
    };
    let vendors = client
        .database(&state.mongo_db)
        .collection::<Document>("vendors");
    let existing = match vendors.find_one(doc! { "_id": object_id }).await {
        Ok(Some(document)) => document,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => return internal_error(),
    };

    let mut update = Document::new();
    if let Some(name) = payload.name {
        update.insert("name", name);
    }
    if let Some(api_base_url) = payload.api_base_url {
        update.insert("apiBaseUrl", api_base_url);
    }
    if let Some(config) = payload.config {
        update.insert("config", value_to_bson(config));
    }
    if payload.low_balance_threshold.is_some() {
        update.insert(
            "lowBalanceThreshold",
            normalize_non_negative_number(
                payload.low_balance_threshold.as_ref(),
                read_i64(&existing, "lowBalanceThreshold"),
            ),
        );
    }
    if let Some(status) = payload.status {
        update.insert("status", status);
    }
    update.insert("updatedAt", DateTime::now());

    if let Err(error) = vendors
        .update_one(doc! { "_id": object_id }, doc! { "$set": update })
        .await
    {
        if is_duplicate_key(&error) {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "Vendor already exists");
        }
        return internal_error();
    }
    let vendor = vendors
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
        .map(vendor_item_from_doc);

    Json(serde_json::json!({
        "message": "Vendor updated successfully",
        "vendor": vendor,
    }))
    .into_response()
}

pub async fn delete_vendor(
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
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let vendors = db.collection::<Document>("vendors");
    let vendor = match vendors.find_one(doc! { "_id": object_id }).await {
        Ok(Some(document)) => document,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Vendor not found"),
        Err(_) => return internal_error(),
    };
    let products_count = db
        .collection::<Document>("products")
        .count_documents(doc! { "vendor.name": read_string(&vendor, "name") })
        .await
        .unwrap_or(0);
    if products_count > 0 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "message": format!("Cannot delete vendor. {products_count} products are using this vendor.")
            })),
        )
            .into_response();
    }

    if vendors.delete_one(doc! { "_id": object_id }).await.is_err() {
        return internal_error();
    }

    Json(serde_json::json!({ "message": "Vendor deleted successfully" })).into_response()
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    error.to_string().contains("E11000") || error.to_string().contains("duplicate key")
}

fn vendor_item_from_doc(document: Document) -> VendorItem {
    VendorItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&document, "name"),
        api_base_url: read_string(&document, "apiBaseUrl"),
        config: document
            .get_document("config")
            .map(config_to_json)
            .unwrap_or_else(|_| serde_json::json!({})),
        low_balance_threshold: read_i64(&document, "lowBalanceThreshold"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        version: read_i64(&document, "__v"),
        slug: document.get_str("slug").map(ToString::to_string).ok(),
    }
}
