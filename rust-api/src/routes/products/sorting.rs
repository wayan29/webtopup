use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::require_permission, state::AppState};

use super::{
    normalize_non_negative_number, object_id, sorting_product_from_doc, status_message,
    unavailable, ProductSortingQuery, SortByPricePayload, SortOrderPayload, SortOrderResponse,
};

pub async fn admin_sorting(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProductSortingQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let filter = build_sorting_filter(&query);
    if filter.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Please provide categoryId, operatorId, or productTypeId",
        );
    }

    let products = match client
        .database(&state.mongo_db)
        .collection::<Document>("products")
        .find(filter)
        .projection(doc! { "code": 1, "name": 1, "price": 1, "sortOrder": 1, "status": 1 })
        .sort(doc! { "sortOrder": 1, "createdAt": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(sorting_product_from_doc)
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    Json(products).into_response()
}

pub async fn update_sort_order(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SortOrderPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(products) = payload.products else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Products array is required",
        );
    };

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("products");
    for product in &products {
        let filter = match ObjectId::parse_str(&product.id) {
            Ok(id) => doc! { "_id": id },
            Err(_) => doc! { "_id": &product.id },
        };
        let sort_order = normalize_non_negative_number(product.sort_order.unwrap_or_default());
        if collection
            .update_one(filter, doc! { "$set": { "sortOrder": sort_order } })
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    }

    Json(SortOrderResponse {
        success: true,
        message: format!("{} products updated", products.len()),
    })
    .into_response()
}

pub async fn sort_by_price(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SortByPricePayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let filter = build_sort_by_price_filter(&payload);
    if filter.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Please provide categoryId, operatorId, or productTypeId",
        );
    }

    let order = if payload.order.as_deref() == Some("desc") {
        -1
    } else {
        1
    };
    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("products");
    let products = match collection
        .find(filter)
        .projection(doc! { "_id": 1, "price.basic": 1 })
        .sort(doc! { "price.basic": order })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    for (index, product) in products.iter().enumerate() {
        let filter = match product.get_object_id("_id") {
            Ok(id) => doc! { "_id": id },
            Err(_) => continue,
        };
        if collection
            .update_one(filter, doc! { "$set": { "sortOrder": (index + 1) as i64 } })
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    }

    Json(SortOrderResponse {
        success: true,
        message: format!("{} products sorted by price", products.len()),
    })
    .into_response()
}

fn build_sorting_filter(query: &ProductSortingQuery) -> Document {
    let mut filter = Document::new();
    if let Some(id) = object_id(query.category_id.as_deref()) {
        filter.insert("categoryId", id);
    }
    if let Some(id) = object_id(query.operator_id.as_deref()) {
        filter.insert("operatorId", id);
    }
    if let Some(id) = object_id(query.product_type_id.as_deref()) {
        filter.insert("productTypeId", id);
    }
    filter
}

fn build_sort_by_price_filter(payload: &SortByPricePayload) -> Document {
    let mut filter = Document::new();
    if let Some(id) = object_id(payload.category_id.as_deref()) {
        filter.insert("categoryId", id);
    }
    if let Some(id) = object_id(payload.operator_id.as_deref()) {
        filter.insert("operatorId", id);
    }
    if let Some(id) = object_id(payload.product_type_id.as_deref()) {
        filter.insert("productTypeId", id);
    }
    filter
}
