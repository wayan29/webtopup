use std::sync::Arc;

use axum::{extract::Query, response::IntoResponse, response::Response, Json};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{
    security::require_proxy_context,
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    mappers::{
        api_category_item, api_operator_item, api_product_item, api_product_type_item,
        api_transaction_detail, api_transaction_item,
    },
    queries::{name_map, product_code_name_map, user_level},
    responses::{api_error, status_message, unavailable},
    types::{
        ApiCheckTransactionQuery, ApiDataResponse, ApiOperatorsQuery, ApiProductTypesQuery,
        ApiProductsQuery, ApiProfileData, ApiProfileResponse, ApiTransactionsPagination,
        ApiTransactionsQuery, ApiTransactionsResponse,
    },
    utils::{add_optional_object_id_filter, object_ids_from_docs, user_bson},
};

pub async fn profile(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = match context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(user_id) => user_id,
        None => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let user = client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "name": 1, "email": 1, "level": 1, "balance": 1 })
        .await
        .ok()
        .flatten();
    let Some(user) = user else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    Json(ApiProfileResponse {
        success: true,
        data: ApiProfileData {
            name: read_string(&user, "name"),
            email: read_string(&user, "email"),
            level: read_string(&user, "level"),
            balance: read_i64(&user, "balance"),
        },
    })
    .into_response()
}

pub async fn categories(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("categories")
        .find(doc! { "status": true })
        .sort(doc! { "sortOrder": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Json(ApiDataResponse {
        success: true,
        data: docs.into_iter().map(api_category_item).collect::<Vec<_>>(),
    })
    .into_response()
}

pub async fn operators(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
    Query(query): Query<ApiOperatorsQuery>,
) -> Response {
    let axum::extract::State(state) = state;
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let mut filter = doc! { "status": true };
    add_optional_object_id_filter(&mut filter, "categoryId", query.category.as_deref());
    let docs = match db
        .collection::<Document>("operators")
        .find(filter)
        .sort(doc! { "sortOrder": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let category_map = name_map(&db, "categories", object_ids_from_docs(&docs, "categoryId")).await;
    Json(ApiDataResponse {
        success: true,
        data: docs
            .into_iter()
            .map(|doc| api_operator_item(doc, &category_map))
            .collect::<Vec<_>>(),
    })
    .into_response()
}

pub async fn product_types(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
    Query(query): Query<ApiProductTypesQuery>,
) -> Response {
    let axum::extract::State(state) = state;
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let mut filter = doc! { "status": true };
    add_optional_object_id_filter(&mut filter, "categoryId", query.category.as_deref());
    add_optional_object_id_filter(&mut filter, "operatorId", query.operator.as_deref());
    let docs = match db
        .collection::<Document>("producttypes")
        .find(filter)
        .sort(doc! { "sortOrder": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let category_map = name_map(&db, "categories", object_ids_from_docs(&docs, "categoryId")).await;
    let operator_map = name_map(&db, "operators", object_ids_from_docs(&docs, "operatorId")).await;
    Json(ApiDataResponse {
        success: true,
        data: docs
            .into_iter()
            .map(|doc| api_product_type_item(doc, &category_map, &operator_map))
            .collect::<Vec<_>>(),
    })
    .into_response()
}

pub async fn products(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
    Query(query): Query<ApiProductsQuery>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = match context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(user_id) => user_id,
        None => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let db = client.database(&state.mongo_db);
    let level = user_level(&db, user_id).await;
    let mut filter = doc! { "status": true };
    add_optional_object_id_filter(&mut filter, "categoryId", query.category.as_deref());
    add_optional_object_id_filter(&mut filter, "operatorId", query.operator.as_deref());
    add_optional_object_id_filter(&mut filter, "productTypeId", query.product_type.as_deref());

    let docs = match db.collection::<Document>("products").find(filter).await {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let category_map = name_map(&db, "categories", object_ids_from_docs(&docs, "categoryId")).await;
    let operator_map = name_map(&db, "operators", object_ids_from_docs(&docs, "operatorId")).await;
    let product_type_map = name_map(
        &db,
        "producttypes",
        object_ids_from_docs(&docs, "productTypeId"),
    )
    .await;
    Json(ApiDataResponse {
        success: true,
        data: docs
            .into_iter()
            .map(|doc| {
                api_product_item(doc, &level, &category_map, &operator_map, &product_type_map)
            })
            .collect::<Vec<_>>(),
    })
    .into_response()
}

pub async fn transactions(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
    Query(query): Query<ApiTransactionsQuery>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = context.user_id else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let db = client.database(&state.mongo_db);
    let mut filter = doc! { "user": user_bson(&user_id) };
    if let Some(status) = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filter.insert("status", status);
    }
    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).max(1);
    let collection = db.collection::<Document>("transactions");
    let total = collection
        .count_documents(filter.clone())
        .await
        .unwrap_or_default() as i64;
    let docs = match collection
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .skip(((page - 1) * limit) as u64)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_map = product_code_name_map(&db, object_ids_from_docs(&docs, "product")).await;
    Json(ApiTransactionsResponse {
        success: true,
        data: docs
            .into_iter()
            .map(|doc| api_transaction_item(doc, &product_map))
            .collect(),
        pagination: ApiTransactionsPagination {
            page,
            limit,
            total,
            total_pages: ((total as f64) / (limit as f64)).ceil() as i64,
        },
    })
    .into_response()
}

pub async fn transaction_check(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
    Query(query): Query<ApiCheckTransactionQuery>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = context.user_id else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if query
        .trx_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
        && query
            .ref_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return api_error(
            axum::http::StatusCode::BAD_REQUEST,
            "trx_id or ref_id is required",
        );
    }
    let db = client.database(&state.mongo_db);
    let mut filter = doc! { "user": user_bson(&user_id) };
    if let Some(trx_id) = query
        .trx_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(object_id) = ObjectId::parse_str(trx_id) {
            filter.insert("_id", object_id);
        } else {
            filter.insert("_id", trx_id);
        }
    } else if let Some(ref_id) = query
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filter.insert("customerRefId", ref_id);
    }
    let transaction = db
        .collection::<Document>("transactions")
        .find_one(filter)
        .await
        .ok()
        .flatten();
    let Some(transaction) = transaction else {
        return api_error(axum::http::StatusCode::NOT_FOUND, "Transaction not found");
    };
    let product_map = product_code_name_map(
        &db,
        object_ids_from_docs(std::slice::from_ref(&transaction), "product"),
    )
    .await;
    Json(ApiDataResponse {
        success: true,
        data: api_transaction_detail(transaction, &product_map),
    })
    .into_response()
}
