use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{
    security::require_permission,
    services::product_id::{
        allocate_product_id, classify_duplicate_key_constraint, is_duplicate_key,
        should_retry_duplicate_product_id_attempt, DuplicateKeyConstraint,
        MAX_PRODUCT_ID_INSERT_ATTEMPTS,
    },
    state::AppState,
    utils::bson::read_i64,
};

use super::{
    build_product_payload, internal_error, object_id, populated_product_json, status_message,
    unavailable, ProductMutationResponse, ProductNormalizedPayload, ProductPayload,
};

pub async fn create_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ProductPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let normalized = match build_product_payload(&db, &payload.0, None).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let products = db.collection::<Document>("products");
    if products
        .find_one(doc! { "code": &normalized.code })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return duplicate_code(&normalized.code);
    }
    let sort_order = max_sort_order(&products, &normalized).await + 1;
    let now = DateTime::now();
    let inserted_id = match insert_product_with_allocated_id(
        &db,
        &products,
        &normalized,
        sort_order,
        now,
    )
    .await
    {
        Ok(id) => id,
        Err(response) => return response,
    };
    let product = match inserted_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(id) => populated_product_json(&db, id).await,
        None => None,
    };
    (
        axum::http::StatusCode::CREATED,
        Json(ProductMutationResponse {
            message: "Product created",
            product,
            product_id: None,
        }),
    )
        .into_response()
}

pub async fn update_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ProductPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(object_id) = object_id(Some(&id)) else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let products = db.collection::<Document>("products");
    let existing = match products.find_one(doc! { "_id": object_id }).await {
        Ok(Some(document)) => document,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Product not found"),
        Err(_) => return internal_error(),
    };
    let normalized = match build_product_payload(&db, &payload.0, Some(&existing)).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if products
        .find_one(doc! { "code": &normalized.code, "_id": { "$ne": object_id } })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return duplicate_code(&normalized.code);
    }
    let update = normalized.into_update_document(DateTime::now());
    if let Err(error) = products
        .update_one(doc! { "_id": object_id }, doc! { "$set": update })
        .await
    {
        if is_duplicate_key(&error) {
            return duplicate_code("");
        }
        return internal_error();
    }
    let product = populated_product_json(&db, object_id).await;
    Json(ProductMutationResponse {
        message: "Product updated",
        product,
        product_id: None,
    })
    .into_response()
}

pub async fn delete_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(object_id) = object_id(Some(&id)) else {
        return internal_error();
    };
    let products = client
        .database(&state.mongo_db)
        .collection::<Document>("products");
    let product = match products.find_one(doc! { "_id": object_id }).await {
        Ok(Some(document)) => document,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Product not found"),
        Err(_) => return internal_error(),
    };
    if !product.get_bool("status").unwrap_or(true) {
        if products
            .delete_one(doc! { "_id": object_id })
            .await
            .is_err()
        {
            return internal_error();
        }
        return Json(ProductMutationResponse {
            message: "Product removed permanently",
            product: None,
            product_id: Some(id),
        })
        .into_response();
    }
    let now = DateTime::now();
    if products
        .update_one(
            doc! { "_id": object_id },
            doc! { "$set": { "status": false, "updatedAt": now } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let product = populated_product_json(&client.database(&state.mongo_db), object_id).await;
    Json(ProductMutationResponse {
        message: "Product deactivated (soft delete)",
        product,
        product_id: None,
    })
    .into_response()
}

async fn insert_product_with_allocated_id(
    db: &mongodb::Database,
    products: &mongodb::Collection<Document>,
    normalized: &ProductNormalizedPayload,
    sort_order: i64,
    now: DateTime,
) -> Result<Option<String>, Response> {
    for attempt in 0..MAX_PRODUCT_ID_INSERT_ATTEMPTS {
        let product_id = match allocate_product_id(db).await {
            Ok(value) => value,
            Err(_) => return Err(internal_error()),
        };
        let document = normalized
            .clone()
            .into_document(product_id, sort_order, now, now);
        match products.insert_one(document).await {
            Ok(result) => {
                return Ok(result.inserted_id.as_object_id().map(|id| id.to_hex()));
            }
            Err(error) => {
                if is_duplicate_key(&error) {
                    if let Some(response) =
                        product_insert_duplicate_error(&error, attempt, &normalized.code)
                    {
                        return Err(response);
                    }
                    continue;
                }
                return Err(internal_error());
            }
        }
    }
    Err(internal_error())
}

async fn max_sort_order(
    products: &mongodb::Collection<Document>,
    payload: &ProductNormalizedPayload,
) -> i64 {
    products
        .find_one(doc! { "productTypeId": payload.product_type_id })
        .projection(doc! { "sortOrder": 1 })
        .sort(doc! { "sortOrder": -1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "sortOrder"))
        .unwrap_or_default()
}

fn product_insert_duplicate_error(
    error: &mongodb::error::Error,
    attempt: usize,
    code: &str,
) -> Option<Response> {
    match classify_duplicate_key_constraint(error) {
        DuplicateKeyConstraint::ProductId => {
            if should_retry_duplicate_product_id_attempt(attempt) {
                None
            } else {
                tracing::error!(%attempt, "productId duplicate after max insert attempts");
                Some(internal_error())
            }
        }
        DuplicateKeyConstraint::Code => Some(duplicate_code(code)),
        DuplicateKeyConstraint::Unknown => {
            tracing::error!(error = %error, "unknown duplicate key on product insert");
            Some(internal_error())
        }
    }
}

fn duplicate_code(code: &str) -> Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Kode produk sudah digunakan, gunakan kode unik lain",
            "field": "code",
            "duplicate": code,
        })),
    )
        .into_response()
}
