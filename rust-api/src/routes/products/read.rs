use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{
    security::{require_permission, ErrorResponse},
    state::AppState,
    utils::bson::read_string,
};

use super::{
    build_pipeline, build_public_products_filter, document_to_json, lookup_stage,
    normalize_validation_config, product_item_from_doc, public_product_from_doc, status_message,
    unavailable, unwind_stage, AdminProductsQuery,
};

pub async fn admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminProductsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let pipeline = build_pipeline(&query);
    let inactive_operator_names = inactive_operator_names(client, &state.mongo_db).await;
    let items = match client
        .database(&state.mongo_db)
        .collection::<Document>("products")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|document| product_item_from_doc(document, &inactive_operator_names))
            .collect(),
        Err(_) => Vec::new(),
    };

    Json(items).into_response()
}

pub async fn public_list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminProductsQuery>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let filter = build_public_products_filter(&db, &query).await;
    let inactive_category_ids = inactive_ids(&db, "categories").await;
    let inactive_operator_ids = inactive_ids(&db, "operators").await;
    let inactive_operator_names = inactive_operator_names(client, &state.mongo_db).await;
    let inactive_product_type_ids = inactive_ids(&db, "producttypes").await;
    let mut pipeline = Vec::new();
    if !filter.is_empty() {
        pipeline.push(doc! { "$match": filter });
    }
    pipeline.extend([
        lookup_stage("categories", "categoryId", "categoryData"),
        unwind_stage("$categoryData"),
        lookup_stage("operators", "operatorId", "operatorData"),
        unwind_stage("$operatorData"),
        lookup_stage("producttypes", "productTypeId", "productTypeData"),
        unwind_stage("$productTypeData"),
        doc! { "$sort": { "sortOrder": 1, "createdAt": 1 } },
    ]);

    let products = match db
        .collection::<Document>("products")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|document| {
                public_product_from_doc(
                    document,
                    &inactive_category_ids,
                    &inactive_operator_ids,
                    &inactive_operator_names,
                    &inactive_product_type_ids,
                )
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    Json(products).into_response()
}

pub async fn public_detail(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Product not found");
    };

    match client
        .database(&state.mongo_db)
        .collection::<Document>("products")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(mut document)) => {
            if !document.contains_key("sortOrder") {
                document.insert("sortOrder", 0);
            }
            normalize_validation_config(&mut document);
            Json(document_to_json(document)).into_response()
        }
        Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "Product not found"),
        Err(_) => status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        ),
    }
}

async fn inactive_operator_names(client: &mongodb::Client, db_name: &str) -> Vec<String> {
    match client
        .database(db_name)
        .collection::<Document>("operators")
        .find(doc! { "status": false })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|document| read_string(&document, "name").to_lowercase())
            .filter(|value| !value.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

async fn inactive_ids(db: &mongodb::Database, collection: &str) -> Vec<String> {
    match db
        .collection::<Document>(collection)
        .find(doc! { "status": false })
        .projection(doc! { "_id": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|document| document.get_object_id("_id").ok().map(|id| id.to_hex()))
            .collect(),
        Err(_) => Vec::new(),
    }
}
