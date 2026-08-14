use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, to_bson, Bson, DateTime, Document};
use serde_json::Value;

use crate::{
    security::{require_permission, require_proxy_context},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    dependencies::{
        group_counts, operator_dependencies_json, operator_dependencies_map,
        operator_dependency_counts, operator_dependency_message,
    },
    json::{document_to_json, normalize_non_negative_number},
    mappers::{operator_detail_from_doc, operator_item_from_doc, public_operator_from_doc},
    not_found,
    queries::{aggregate_documents, id_or_slug_filter, lookup_stage, slugify, unwind_stage},
    status_message,
    types::{
        CreateOperatorResponse, MessageResponse, SortOrderPayload, UpdateOperatorPayload,
        UpdateOperatorResponse,
    },
    unavailable,
};

pub async fn operators_update_sort_order(
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
    let category_id = match payload
        .category_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Kategori operator tidak valid",
                )
            }
        },
        None => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kategori operator tidak valid",
            )
        }
    };
    let Some(orders) = payload.orders else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Orders array is required",
        );
    };
    if orders.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Orders array is required",
        );
    }

    let mut ids = Vec::with_capacity(orders.len());
    for item in &orders {
        let Ok(id) = ObjectId::parse_str(item.id.trim()) else {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Ada ID operator yang tidak valid",
            );
        };
        if ids.contains(&id) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Urutan operator mengandung ID duplikat",
            );
        }
        ids.push(id);
    }

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("operators");
    let existing = match collection
        .find(doc! { "categoryId": category_id })
        .projection(doc! { "_id": 1 })
        .await
    {
        Ok(cursor) => match futures_util::TryStreamExt::try_collect::<Vec<_>>(cursor).await {
            Ok(docs) => docs,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            }
        },
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    if existing.len() != ids.len() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Urutan operator harus memuat semua operator pada kategori aktif",
        );
    }
    let existing_ids = existing
        .iter()
        .filter_map(|document| document.get_object_id("_id").ok())
        .collect::<Vec<_>>();
    if ids.iter().any(|id| !existing_ids.contains(id)) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada operator yang tidak ditemukan pada kategori aktif",
        );
    }

    for (index, id) in ids.into_iter().enumerate() {
        match collection
            .update_one(
                doc! { "_id": id, "categoryId": category_id },
                doc! { "$set": { "sortOrder": (index as i64) + 1 } },
            )
            .await
        {
            Ok(result) if result.matched_count == 1 => {}
            Ok(_) => {
                return status_message(
                    axum::http::StatusCode::CONFLICT,
                    "Urutan operator berubah. Segarkan halaman lalu coba lagi.",
                )
            }
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            }
        }
    }

    Json(MessageResponse {
        message: "Sort order updated successfully",
    })
    .into_response()
}

pub async fn validation_taxonomy_operators(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    operators_admin_all_inner(headers, state).await
}

async fn operators_admin_all_inner(
    headers: axum::http::HeaderMap,
    state: Arc<AppState>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let direct_products = group_counts(
        &db,
        "products",
        "operatorId",
        doc! { "operatorId": { "$exists": true, "$ne": Bson::Null } },
    )
    .await;
    let product_types = group_counts(&db, "producttypes", "operatorId", Document::new()).await;
    let docs = aggregate_documents(
        &db,
        "operators",
        vec![
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            doc! { "$sort": { "sortOrder": 1, "name": 1 } },
        ],
    )
    .await;
    let items = docs
        .into_iter()
        .map(|document| operator_item_from_doc(document, &direct_products, &product_types))
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn operators_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    operators_admin_all_inner(headers, state).await
}

pub async fn operator_admin_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let Some(filter) = id_or_slug_filter(&id) else {
        return not_found("Operator not found");
    };
    let docs = aggregate_documents(
        &db,
        "operators",
        vec![
            doc! { "$match": filter },
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            doc! { "$limit": 1 },
        ],
    )
    .await;
    match docs.into_iter().next() {
        Some(document) => Json(operator_detail_from_doc(document)).into_response(),
        None => not_found("Operator not found"),
    }
}

pub async fn operator_admin_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateOperatorPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let operators = db.collection::<Document>("operators");

    let normalized_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if normalized_name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama operator wajib diisi",
        );
    }
    let Some(category_id_raw) = payload.category_id.as_deref() else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori operator tidak valid",
        );
    };
    let category_id = match ObjectId::parse_str(category_id_raw) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kategori operator tidak valid",
            )
        }
    };
    let Some(slug) = slugify(&normalized_name) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama operator tidak valid untuk dijadikan slug",
        );
    };

    let category = db
        .collection::<Document>("categories")
        .find_one(doc! { "_id": category_id })
        .projection(doc! { "name": 1 })
        .await
        .ok()
        .flatten();
    if category.is_none() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori operator tidak ditemukan",
        );
    }

    let existing = operators
        .find_one(doc! { "slug": &slug, "categoryId": category_id })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if existing.is_some() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator dengan nama ini sudah ada di kategori ini",
        );
    }

    let sort_order = operators
        .find_one(doc! { "categoryId": category_id })
        .sort(doc! { "sortOrder": -1 })
        .projection(doc! { "sortOrder": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "sortOrder") + 1)
        .unwrap_or(0);
    let operator_id = operators
        .find_one(doc! {})
        .sort(doc! { "operatorId": -1 })
        .projection(doc! { "operatorId": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "operatorId") + 1)
        .unwrap_or(1);
    let now = DateTime::now();
    let server_options = payload
        .server_options
        .as_ref()
        .map(|value| to_bson(value).unwrap_or(Bson::Array(Vec::new())))
        .unwrap_or_else(|| Bson::Array(Vec::new()));
    let icon = payload.icon.unwrap_or_default();
    let instruction_image = payload.instruction_image.unwrap_or_default();
    if let Err(response) = crate::services::managed_assets::ensure_managed_field(
        &crate::routes::uploads::upload_root(),
        &icon,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
    ) {
        return response;
    }
    if let Err(response) = crate::services::managed_assets::ensure_managed_field(
        &crate::routes::uploads::upload_root(),
        &instruction_image,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Instructions,
    ) {
        return response;
    }
    let insert_doc = doc! {
        "operatorId": operator_id,
        "name": normalized_name,
        "slug": slug,
        "categoryId": category_id,
        "icon": icon,
        "instructionImage": instruction_image,
        "checkUsername": payload.check_username.unwrap_or(false),
        "usernameLabel": payload.username_label.unwrap_or_default(),
        "validationType": payload.validation_type.unwrap_or_else(|| "none".to_string()),
        "description": payload.description.unwrap_or_default(),
        "isCustomProduct": payload.is_custom_product.unwrap_or(false),
        "userIdLabel": payload.user_id_label.unwrap_or_else(|| "User ID".to_string()),
        "userIdType": payload.user_id_type.unwrap_or_else(|| "number".to_string()),
        "hasServerId": payload.has_server_id.unwrap_or(false),
        "serverIdLabel": payload.server_id_label.unwrap_or_else(|| "Server ID".to_string()),
        "serverIdDropdown": payload.server_id_dropdown.unwrap_or(false),
        "serverIdType": payload.server_id_type.unwrap_or_else(|| "number".to_string()),
        "serverOptions": server_options,
        "sortOrder": sort_order,
        "status": payload.status.unwrap_or(true),
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    let insert_result = match operators.insert_one(insert_doc).await {
        Ok(result) => result,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let operator = operators
        .find_one(doc! { "_id": insert_result.inserted_id })
        .await
        .ok()
        .flatten();
    let Some(operator) = operator else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };

    (
        axum::http::StatusCode::CREATED,
        Json(CreateOperatorResponse {
            message: "Operator created successfully",
            operator: document_to_json(operator),
        }),
    )
        .into_response()
}

pub async fn operator_admin_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateOperatorPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let operators = db.collection::<Document>("operators");
    let operator_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return not_found("Operator not found"),
    };
    let operator = operators
        .find_one(doc! { "_id": operator_id })
        .await
        .ok()
        .flatten();
    let Some(operator) = operator else {
        return not_found("Operator not found");
    };

    let previous_name = read_string(&operator, "name");
    let previous_icon = read_string(&operator, "icon");
    let previous_instruction_image = read_string(&operator, "instructionImage");
    let previous_category_id = match operator.get_object_id("categoryId") {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kategori operator tidak valid",
            )
        }
    };
    let previous_category = db
        .collection::<Document>("categories")
        .find_one(doc! { "_id": previous_category_id })
        .projection(doc! { "name": 1 })
        .await
        .ok()
        .flatten();

    let normalized_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or(&previous_name)
        .to_string();
    if normalized_name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama operator wajib diisi",
        );
    }

    let target_category_id = match payload.category_id.as_deref() {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Kategori operator tidak valid",
                )
            }
        },
        None => previous_category_id,
    };
    let target_category = db
        .collection::<Document>("categories")
        .find_one(doc! { "_id": target_category_id })
        .projection(doc! { "name": 1 })
        .await
        .ok()
        .flatten();
    let Some(target_category) = target_category else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori operator tidak ditemukan",
        );
    };
    let target_category_name = read_string(&target_category, "name");

    let Some(target_slug) = slugify(&normalized_name) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama operator tidak valid untuk dijadikan slug",
        );
    };
    if normalized_name != previous_name || target_category_id != previous_category_id {
        let existing = operators
            .find_one(doc! {
                "slug": &target_slug,
                "categoryId": target_category_id,
                "_id": { "$ne": operator_id },
            })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten();
        if existing.is_some() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Operator dengan nama ini sudah ada di kategori ini",
            );
        }
    }

    let mut set_doc = Document::new();
    if payload.name.is_some() || normalized_name != previous_name {
        set_doc.insert("name", &normalized_name);
        set_doc.insert("slug", &target_slug);
    }
    if payload.category_id.is_some() {
        set_doc.insert("categoryId", target_category_id);
    }
    if let Some(value) = payload.icon {
        if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
            &crate::routes::uploads::upload_root(),
            &value,
            crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
            crate::services::managed_assets::effectively_changed_managed_field(
                Some(&previous_icon),
                &value,
            ),
        ) {
            return response;
        }
        set_doc.insert("icon", value);
    }
    if let Some(value) = payload.instruction_image {
        if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
            &crate::routes::uploads::upload_root(),
            &value,
            crate::services::managed_assets::ManagedFieldFolderPolicy::Instructions,
            crate::services::managed_assets::effectively_changed_managed_field(
                Some(&previous_instruction_image),
                &value,
            ),
        ) {
            return response;
        }
        set_doc.insert("instructionImage", value);
    }
    if let Some(value) = payload.check_username {
        set_doc.insert("checkUsername", value);
    }
    if let Some(value) = payload.username_label {
        set_doc.insert("usernameLabel", value);
    }
    if let Some(value) = payload.validation_type {
        set_doc.insert("validationType", value);
    }
    if let Some(value) = payload.description {
        set_doc.insert("description", value);
    }
    if let Some(value) = payload.is_custom_product {
        set_doc.insert("isCustomProduct", value);
    }
    if let Some(value) = payload.user_id_label {
        set_doc.insert("userIdLabel", value);
    }
    if let Some(value) = payload.user_id_type {
        set_doc.insert("userIdType", value);
    }
    if let Some(value) = payload.has_server_id {
        set_doc.insert("hasServerId", value);
    }
    if let Some(value) = payload.server_id_label {
        set_doc.insert("serverIdLabel", value);
    }
    if let Some(value) = payload.server_id_dropdown {
        set_doc.insert("serverIdDropdown", value);
    }
    if let Some(value) = payload.server_id_type {
        set_doc.insert("serverIdType", value);
    }
    if let Some(value) = payload.server_options {
        set_doc.insert(
            "serverOptions",
            to_bson(&value).unwrap_or(Bson::Array(Vec::new())),
        );
    }
    if let Some(value) = payload.sort_order {
        set_doc.insert("sortOrder", normalize_non_negative_number(value));
    }
    if let Some(value) = payload.status {
        set_doc.insert("status", value);
    }
    set_doc.insert("updatedAt", DateTime::now());

    if operators
        .update_one(doc! { "_id": operator_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    let operator_changed =
        normalized_name != previous_name || target_category_id != previous_category_id;
    if operator_changed {
        let previous_category_name = previous_category
            .as_ref()
            .map(|category| read_string(category, "name"))
            .unwrap_or_default();
        let _ = db
            .collection::<Document>("products")
            .update_many(
                doc! { "operatorId": operator_id },
                doc! { "$set": { "brand": &normalized_name, "categoryId": target_category_id, "category": &target_category_name } },
            )
            .await;
        let _ = db
            .collection::<Document>("products")
            .update_many(
                doc! {
                    "brand": &previous_name,
                    "$and": [
                        { "$or": [{ "operatorId": { "$exists": false } }, { "operatorId": Bson::Null }] },
                        { "$or": [{ "categoryId": previous_category_id }, { "category": previous_category_name }] }
                    ]
                },
                doc! { "$set": { "brand": &normalized_name, "categoryId": target_category_id, "category": &target_category_name } },
            )
            .await;
        let _ = db
            .collection::<Document>("producttypes")
            .update_many(
                doc! { "operatorId": operator_id },
                doc! { "$set": { "categoryId": target_category_id } },
            )
            .await;
    }

    let updated_operator = operators
        .find_one(doc! { "_id": operator_id })
        .await
        .ok()
        .flatten();
    let Some(updated_operator) = updated_operator else {
        return not_found("Operator not found");
    };
    let counts = operator_dependency_counts(
        &db,
        &operator_id,
        &normalized_name,
        &target_category_id,
        &target_category_name,
    )
    .await;
    let mut operator_json = match document_to_json(updated_operator) {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    for (key, value) in operator_dependencies_map(&counts) {
        operator_json.insert(key, value);
    }

    Json(UpdateOperatorResponse {
        message: "Operator updated successfully",
        operator: Value::Object(operator_json),
    })
    .into_response()
}

pub async fn operator_admin_delete(
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
    let db = client.database(&state.mongo_db);
    let operators = db.collection::<Document>("operators");
    let operator_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return not_found("Operator not found"),
    };
    let operator = operators
        .find_one(doc! { "_id": operator_id })
        .await
        .ok()
        .flatten();
    let Some(operator) = operator else {
        return not_found("Operator not found");
    };
    let operator_name = read_string(&operator, "name");
    let category_id = operator.get_object_id("categoryId").unwrap_or_default();
    let category = db
        .collection::<Document>("categories")
        .find_one(doc! { "_id": category_id })
        .projection(doc! { "name": 1 })
        .await
        .ok()
        .flatten();
    let category_name = category
        .as_ref()
        .map(|category| read_string(category, "name"))
        .unwrap_or_default();
    let counts = operator_dependency_counts(
        &db,
        &operator_id,
        &operator_name,
        &category_id,
        &category_name,
    )
    .await;
    if counts.dependency_count > 0 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "message": operator_dependency_message(&counts),
                "dependencies": operator_dependencies_json(&counts),
            })),
        )
            .into_response();
    }

    if operators
        .delete_one(doc! { "_id": operator_id })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    Json(MessageResponse {
        message: "Operator deleted successfully",
    })
    .into_response()
}

pub async fn operators_public(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let mut filter = doc! { "status": true };
    if let Some(category_id) = query
        .get("categoryId")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if let Ok(object_id) = ObjectId::parse_str(category_id) {
            filter.insert("categoryId", object_id);
        } else {
            filter.insert("categoryId", category_id);
        }
    }

    let docs = aggregate_documents(
        &db,
        "operators",
        vec![
            doc! { "$match": filter },
            lookup_stage("categories", "categoryId", "categoryData"),
            doc! { "$unwind": "$categoryData" },
            doc! { "$match": { "$or": [
                { "categoryData.status": true },
                { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": true }] },
                { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": { "$exists": false } }] }
            ] } },
            doc! { "$sort": { "sortOrder": 1, "name": 1 } },
        ],
    )
    .await;

    Json(
        docs.into_iter()
            .map(public_operator_from_doc)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn operator_public_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let Some(filter) = id_or_slug_filter(&id) else {
        return not_found("Operator not found");
    };
    let docs = aggregate_documents(
        &db,
        "operators",
        vec![
            doc! { "$match": filter },
            lookup_stage("categories", "categoryId", "categoryData"),
            doc! { "$unwind": "$categoryData" },
            doc! { "$match": { "status": true, "$or": [
                { "categoryData.status": true },
                { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": true }] },
                { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": { "$exists": false } }] }
            ] } },
            doc! { "$limit": 1 },
        ],
    )
    .await;

    match docs.into_iter().next() {
        Some(document) => Json(public_operator_from_doc(document)).into_response(),
        None => not_found("Operator not found"),
    }
}
