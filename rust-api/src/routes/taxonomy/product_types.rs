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
    dependencies::{group_counts, product_type_dependencies_json, product_type_dependency_message},
    description_html::sanitize_product_description,
    json::normalize_non_negative_number,
    mappers::{
        product_type_detail_from_doc, product_type_item_from_doc, product_type_response_json,
        public_product_type_from_doc,
    },
    not_found,
    queries::{
        aggregate_documents, id_or_slug_filter, lookup_stage, public_product_type_pipeline,
        slugify, unwind_stage,
    },
    status_message,
    types::{
        CreateProductTypeResponse, MessageResponse, SortOrderPayload, UpdateProductTypePayload,
        UpdateProductTypeResponse,
    },
    unavailable,
};

pub async fn product_types_update_sort_order(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SortOrderPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let operator_id = match payload
        .operator_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Operator jenis produk tidak valid",
                )
            }
        },
        None => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Operator jenis produk tidak valid",
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
                "Ada ID jenis produk yang tidak valid",
            );
        };
        if ids.contains(&id) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Urutan jenis produk mengandung ID duplikat",
            );
        }
        ids.push(id);
    }

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("producttypes");
    let existing = match collection
        .find(doc! { "operatorId": operator_id })
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
            "Urutan jenis produk harus memuat semua jenis pada operator aktif",
        );
    }
    let existing_ids = existing
        .iter()
        .filter_map(|document| document.get_object_id("_id").ok())
        .collect::<Vec<_>>();
    if ids.iter().any(|id| !existing_ids.contains(id)) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada jenis produk yang tidak ditemukan pada operator aktif",
        );
    }

    for (index, id) in ids.into_iter().enumerate() {
        match collection
            .update_one(
                doc! { "_id": id, "operatorId": operator_id },
                doc! { "$set": { "sortOrder": (index as i64) + 1 } },
            )
            .await
        {
            Ok(result) if result.matched_count == 1 => {}
            Ok(_) => {
                return status_message(
                    axum::http::StatusCode::CONFLICT,
                    "Urutan jenis produk berubah. Segarkan halaman lalu coba lagi.",
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

pub async fn validation_taxonomy_product_types(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    product_types_admin_all_inner(headers, state).await
}

async fn product_types_admin_all_inner(
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
    let products = group_counts(
        &db,
        "products",
        "productTypeId",
        doc! { "productTypeId": { "$exists": true, "$ne": Bson::Null } },
    )
    .await;
    let docs = aggregate_documents(
        &db,
        "producttypes",
        vec![
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            lookup_stage("operators", "operatorId", "operatorData"),
            unwind_stage("$operatorData"),
            doc! { "$sort": { "sortOrder": 1, "name": 1 } },
        ],
    )
    .await;
    let items = docs
        .into_iter()
        .map(|document| product_type_item_from_doc(document, &products))
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn product_types_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    product_types_admin_all_inner(headers, state).await
}

pub async fn product_types_public(
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
    if let Some(operator_id) = query
        .get("operatorId")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if let Ok(object_id) = ObjectId::parse_str(operator_id) {
            filter.insert("operatorId", object_id);
        } else {
            filter.insert("operatorId", operator_id);
        }
    }

    let docs = aggregate_documents(&db, "producttypes", public_product_type_pipeline(filter)).await;
    Json(
        docs.into_iter()
            .map(public_product_type_from_doc)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn product_type_admin_detail(
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
    let db = client.database(&state.mongo_db);
    let Some(filter) = id_or_slug_filter(&id) else {
        return not_found("Product type not found");
    };
    let docs = aggregate_documents(
        &db,
        "producttypes",
        vec![
            doc! { "$match": filter },
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            lookup_stage("operators", "operatorId", "operatorData"),
            unwind_stage("$operatorData"),
            doc! { "$limit": 1 },
        ],
    )
    .await;
    match docs.into_iter().next() {
        Some(document) => Json(product_type_detail_from_doc(document)).into_response(),
        None => not_found("Product type not found"),
    }
}

fn apply_create_description(insert_doc: &mut Document, description: Option<String>) {
    insert_doc.insert(
        "description",
        sanitize_product_description(&description.unwrap_or_default()),
    );
}

fn apply_update_description(set_doc: &mut Document, description: Option<String>) {
    if let Some(value) = description {
        set_doc.insert("description", sanitize_product_description(&value));
    }
}

pub async fn product_type_admin_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateProductTypePayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let product_types = db.collection::<Document>("producttypes");

    let normalized_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if normalized_name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama jenis produk wajib diisi",
        );
    }
    let Some(operator_id_raw) = payload.operator_id.as_deref() else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator jenis produk tidak valid",
        );
    };
    let operator_id = match ObjectId::parse_str(operator_id_raw) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Operator jenis produk tidak valid",
            )
        }
    };
    let operator = db
        .collection::<Document>("operators")
        .find_one(doc! { "_id": operator_id })
        .projection(doc! { "name": 1, "categoryId": 1 })
        .await
        .ok()
        .flatten();
    let Some(operator) = operator else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator tidak ditemukan",
        );
    };
    let operator_category_id = operator.get_object_id("categoryId").unwrap_or_default();
    let category_id = match payload.category_id.as_deref() {
        Some(value) if !value.trim().is_empty() => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Kategori jenis produk tidak valid",
                )
            }
        },
        _ => operator_category_id,
    };
    if operator_category_id != category_id {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator tidak berada di kategori yang dipilih",
        );
    }
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
            "Kategori jenis produk tidak ditemukan",
        );
    }
    let Some(slug) = slugify(&normalized_name) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama jenis produk tidak valid untuk dijadikan slug",
        );
    };
    let existing = product_types
        .find_one(doc! { "slug": &slug, "operatorId": operator_id })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if existing.is_some() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Jenis produk dengan nama ini sudah ada untuk operator ini",
        );
    }

    let sort_order = product_types
        .find_one(doc! { "operatorId": operator_id })
        .sort(doc! { "sortOrder": -1 })
        .projection(doc! { "sortOrder": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "sortOrder") + 1)
        .unwrap_or(0);
    let type_id = product_types
        .find_one(doc! {})
        .sort(doc! { "typeId": -1 })
        .projection(doc! { "typeId": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "typeId") + 1)
        .unwrap_or(1);
    let popup_info = payload
        .popup_info
        .as_ref()
        .map(|value| to_bson(value).unwrap_or(Bson::Document(Document::new())))
        .unwrap_or_else(|| Bson::Document(Document::new()));
    let now = DateTime::now();
    let description = payload.description;
    let mut insert_doc = doc! {
        "typeId": type_id,
        "name": normalized_name,
        "slug": slug,
        "categoryId": category_id,
        "operatorId": operator_id,
        "icon": payload.icon.unwrap_or_default(),
        "cover": payload.cover.unwrap_or_default(),
        "openTime": payload.open_time.unwrap_or_else(|| "00:00".to_string()),
        "closeTime": payload.close_time.unwrap_or_else(|| "23:59".to_string()),
        "open24Hours": payload.open_24_hours.unwrap_or(true),
        "estimatedDelivery": payload.estimated_delivery.unwrap_or_default(),
        "processType": payload.process_type.unwrap_or_else(|| "auto".to_string()),
        "popupInfo": popup_info,
        "sortOrder": sort_order,
        "status": payload.status.unwrap_or(true),
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    apply_create_description(&mut insert_doc, description);
    let insert_result = match product_types.insert_one(insert_doc).await {
        Ok(result) => result,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let id = match insert_result.inserted_id.as_object_id() {
        Some(id) => id,
        None => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let docs = aggregate_documents(
        &db,
        "producttypes",
        vec![
            doc! { "$match": { "_id": id } },
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            lookup_stage("operators", "operatorId", "operatorData"),
            unwind_stage("$operatorData"),
            doc! { "$limit": 1 },
        ],
    )
    .await;
    let Some(updated) = docs.into_iter().next() else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };
    let mut product_type_json = product_type_response_json(updated, 0);
    product_type_json.insert("dependencyCount".to_string(), serde_json::json!(0));
    product_type_json.insert("canDelete".to_string(), serde_json::json!(true));

    (
        axum::http::StatusCode::CREATED,
        Json(CreateProductTypeResponse {
            message: "Product type created successfully",
            product_type: Value::Object(product_type_json),
        }),
    )
        .into_response()
}

pub async fn product_type_admin_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateProductTypePayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let product_types = db.collection::<Document>("producttypes");
    let product_type_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return not_found("Product type not found"),
    };
    let product_type = product_types
        .find_one(doc! { "_id": product_type_id })
        .await
        .ok()
        .flatten();
    let Some(product_type) = product_type else {
        return not_found("Product type not found");
    };

    let previous_name = read_string(&product_type, "name");
    let previous_category_id = product_type.get_object_id("categoryId").unwrap_or_default();
    let previous_operator_id = product_type.get_object_id("operatorId").unwrap_or_default();
    let normalized_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or(&previous_name)
        .to_string();
    if normalized_name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama jenis produk wajib diisi",
        );
    }

    let target_operator_id = match payload.operator_id.as_deref() {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Operator jenis produk tidak valid",
                )
            }
        },
        None => previous_operator_id,
    };
    let target_operator = db
        .collection::<Document>("operators")
        .find_one(doc! { "_id": target_operator_id })
        .projection(doc! { "name": 1, "categoryId": 1 })
        .await
        .ok()
        .flatten();
    let Some(target_operator) = target_operator else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator tidak ditemukan",
        );
    };
    let operator_category_id = target_operator
        .get_object_id("categoryId")
        .unwrap_or_default();

    let target_category_id = match payload.category_id.as_deref() {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Kategori jenis produk tidak valid",
                )
            }
        },
        None => operator_category_id,
    };
    if operator_category_id != target_category_id {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Operator tidak berada di kategori yang dipilih",
        );
    }
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
            "Kategori jenis produk tidak ditemukan",
        );
    };
    let target_category_name = read_string(&target_category, "name");
    let target_operator_name = read_string(&target_operator, "name");

    let Some(target_slug) = slugify(&normalized_name) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama jenis produk tidak valid untuk dijadikan slug",
        );
    };
    if normalized_name != previous_name || target_operator_id != previous_operator_id {
        let existing = product_types
            .find_one(doc! {
                "slug": &target_slug,
                "operatorId": target_operator_id,
                "_id": { "$ne": product_type_id },
            })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten();
        if existing.is_some() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Jenis produk dengan nama ini sudah ada untuk operator ini",
            );
        }
    }

    let mut set_doc = doc! {
        "categoryId": target_category_id,
        "operatorId": target_operator_id,
    };
    if payload.name.is_some() || normalized_name != previous_name {
        set_doc.insert("name", &normalized_name);
        set_doc.insert("slug", &target_slug);
    }
    if let Some(value) = payload.icon {
        set_doc.insert("icon", value);
    }
    if let Some(value) = payload.cover {
        set_doc.insert("cover", value);
    }
    if let Some(value) = payload.open_time {
        set_doc.insert("openTime", value);
    }
    if let Some(value) = payload.close_time {
        set_doc.insert("closeTime", value);
    }
    if let Some(value) = payload.open_24_hours {
        set_doc.insert("open24Hours", value);
    }
    if let Some(value) = payload.estimated_delivery {
        set_doc.insert("estimatedDelivery", value);
    }
    if let Some(value) = payload.process_type {
        set_doc.insert("processType", value);
    }
    apply_update_description(&mut set_doc, payload.description);
    if let Some(value) = payload.popup_info {
        set_doc.insert(
            "popupInfo",
            to_bson(&value).unwrap_or(Bson::Document(Document::new())),
        );
    }
    if let Some(value) = payload.sort_order {
        set_doc.insert("sortOrder", normalize_non_negative_number(value));
    }
    if let Some(value) = payload.status {
        set_doc.insert("status", value);
    }
    set_doc.insert("updatedAt", DateTime::now());

    if product_types
        .update_one(doc! { "_id": product_type_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    if previous_name != normalized_name
        || previous_category_id != target_category_id
        || previous_operator_id != target_operator_id
    {
        let _ = db
            .collection::<Document>("products")
            .update_many(
                doc! { "productTypeId": product_type_id },
                doc! { "$set": {
                    "categoryId": target_category_id,
                    "category": &target_category_name,
                    "operatorId": target_operator_id,
                    "brand": &target_operator_name,
                } },
            )
            .await;
    }

    let docs = aggregate_documents(
        &db,
        "producttypes",
        vec![
            doc! { "$match": { "_id": product_type_id } },
            lookup_stage("categories", "categoryId", "categoryData"),
            unwind_stage("$categoryData"),
            lookup_stage("operators", "operatorId", "operatorData"),
            unwind_stage("$operatorData"),
            doc! { "$limit": 1 },
        ],
    )
    .await;
    let Some(updated) = docs.into_iter().next() else {
        return not_found("Product type not found");
    };
    let product_count = db
        .collection::<Document>("products")
        .count_documents(doc! { "productTypeId": product_type_id })
        .await
        .unwrap_or(0) as i64;
    let mut product_type_json = product_type_response_json(updated, product_count);
    product_type_json.insert(
        "dependencyCount".to_string(),
        serde_json::json!(product_count),
    );
    product_type_json.insert(
        "canDelete".to_string(),
        serde_json::json!(product_count == 0),
    );

    Json(UpdateProductTypeResponse {
        message: "Product type updated successfully",
        product_type: Value::Object(product_type_json),
    })
    .into_response()
}

pub async fn product_type_admin_delete(
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
    let db = client.database(&state.mongo_db);
    let product_types = db.collection::<Document>("producttypes");
    let product_type_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return not_found("Product type not found"),
    };
    let product_type = product_types
        .find_one(doc! { "_id": product_type_id })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if product_type.is_none() {
        return not_found("Product type not found");
    }
    let product_count = db
        .collection::<Document>("products")
        .count_documents(doc! { "productTypeId": product_type_id })
        .await
        .unwrap_or(0) as i64;
    if product_count > 0 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "message": product_type_dependency_message(product_count),
                "dependencies": product_type_dependencies_json(product_count),
            })),
        )
            .into_response();
    }

    if product_types
        .delete_one(doc! { "_id": product_type_id })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    Json(MessageResponse {
        message: "Product type deleted successfully",
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{doc, Bson, Document};

    use super::{apply_create_description, apply_update_description};

    const UNSAFE_DESCRIPTION: &str =
        "<p onclick='steal()'>Aman<script>alert(1)</script><a href='http://evil.test'>jahat</a><strong>tebal</strong></p>";
    // Ammonia always injects the configured link_rel on surviving anchors, even after href removal.
    const SANITIZED_DESCRIPTION: &str =
        "<p>Aman<a rel=\"noopener noreferrer\">jahat</a><strong>tebal</strong></p>";

    #[test]
    fn unsafe_create_description_is_written_sanitized_to_insert_document() {
        let mut insert_doc = Document::new();

        apply_create_description(&mut insert_doc, Some(UNSAFE_DESCRIPTION.to_string()));

        assert_eq!(
            insert_doc.get("description"),
            Some(&Bson::String(SANITIZED_DESCRIPTION.to_string()))
        );
    }

    #[test]
    fn unsafe_update_description_is_written_sanitized_to_set_document() {
        let mut set_doc = doc! { "name": "existing" };

        apply_update_description(&mut set_doc, Some(UNSAFE_DESCRIPTION.to_string()));

        assert_eq!(
            set_doc.get("description"),
            Some(&Bson::String(SANITIZED_DESCRIPTION.to_string()))
        );
    }

    #[test]
    fn absent_update_description_does_not_overwrite_stored_value() {
        let mut set_doc = doc! { "name": "existing" };

        apply_update_description(&mut set_doc, None);

        assert!(!set_doc.contains_key("description"));
    }
}

pub async fn product_type_public_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let Some(filter) = id_or_slug_filter(&id) else {
        return not_found("Product type not found");
    };
    let mut pipeline = vec![doc! { "$match": filter }];
    pipeline.extend(public_product_type_pipeline(doc! {}));
    pipeline.push(doc! { "$limit": 1 });
    let docs = aggregate_documents(&db, "producttypes", pipeline).await;

    match docs.into_iter().next() {
        Some(document) => Json(public_product_type_from_doc(document)).into_response(),
        None => not_found("Product type not found"),
    }
}
