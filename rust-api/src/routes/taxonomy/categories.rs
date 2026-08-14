use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::Value;

use crate::{
    security::{require_permission, require_proxy_context},
    services::managed_assets::effectively_changed_managed_field,
    state::AppState,
    utils::bson::read_string,
};

use super::{
    category_dependencies, category_dependency_counts, category_item_from_doc, dependencies_json,
    dependency_message, document_to_json, find_sorted, id_or_slug_filter, max_sort_order,
    normalize_non_negative_number, not_found, slugify, status_message, unavailable,
    CreateCategoryPayload, CreateCategoryResponse, MessageResponse, SortOrderPayload,
    UpdateCategoryPayload, UpdateCategoryResponse,
};

pub async fn validation_taxonomy_categories(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    categories_admin_all_inner(headers, state).await
}

async fn categories_admin_all_inner(
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
    let direct_products = super::group_counts(
        &db,
        "products",
        "categoryId",
        doc! { "categoryId": { "$exists": true, "$ne": Bson::Null } },
    )
    .await;
    let legacy_products = super::group_string_counts(
        &db,
        "products",
        "category",
        doc! { "$or": [{ "categoryId": { "$exists": false } }, { "categoryId": Bson::Null }] },
    )
    .await;
    let operators = super::group_counts(&db, "operators", "categoryId", Document::new()).await;
    let product_types =
        super::group_counts(&db, "producttypes", "categoryId", Document::new()).await;
    let docs = find_sorted(&db, "categories", doc! { "sortOrder": 1, "name": 1 }).await;
    let items = docs
        .into_iter()
        .map(|document| {
            category_item_from_doc(
                document,
                &direct_products,
                &legacy_products,
                &operators,
                &product_types,
            )
        })
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn categories_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewProducts").await {
        return response;
    }
    categories_admin_all_inner(headers, state).await
}

pub async fn categories_update_sort_order(
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
                "Ada ID kategori yang tidak valid",
            );
        };
        if ids.contains(&id) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Urutan kategori mengandung ID duplikat",
            );
        }
        ids.push(id);
    }

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("categories");
    let existing = match collection.find(doc! {}).projection(doc! { "_id": 1 }).await {
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
            "Urutan kategori harus memuat semua kategori",
        );
    }
    let existing_ids = existing
        .iter()
        .filter_map(|document| document.get_object_id("_id").ok())
        .collect::<Vec<_>>();
    if ids.iter().any(|id| !existing_ids.contains(id)) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada kategori yang tidak ditemukan pada payload urutan",
        );
    }

    for (index, id) in ids.into_iter().enumerate() {
        match collection
            .update_one(
                doc! { "_id": id },
                doc! { "$set": { "sortOrder": (index as i64) + 1 } },
            )
            .await
        {
            Ok(result) if result.matched_count == 1 => {}
            Ok(_) => {
                return status_message(
                    axum::http::StatusCode::CONFLICT,
                    "Urutan kategori berubah. Segarkan halaman lalu coba lagi.",
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

pub async fn category_admin_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateCategoryPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let categories = db.collection::<Document>("categories");
    let normalized_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if normalized_name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori wajib diisi",
        );
    }
    let Some(slug) = slugify(&normalized_name) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori tidak valid untuk dijadikan slug",
        );
    };

    let existing = categories
        .find_one(doc! { "slug": &slug })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if existing.is_some() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Category with this name already exists",
        );
    }

    let resolved_sort_order = match payload.sort_order {
        Some(value) if value.is_finite() => normalize_non_negative_number(value),
        _ => max_sort_order(&categories).await + 1,
    };
    let icon = payload.icon.unwrap_or_else(|| "📦".to_string());
    if let Err(response) = crate::services::managed_assets::ensure_managed_field(
        &crate::routes::uploads::upload_root(),
        &icon,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
    ) {
        return response;
    }
    let now = DateTime::now();
    let insert_doc = doc! {
        "name": normalized_name,
        "slug": slug,
        "icon": icon,
        "sortOrder": resolved_sort_order,
        "status": payload.status.unwrap_or(true),
        "createdAt": now,
        "updatedAt": now,
    };
    let insert_result = match categories.insert_one(insert_doc).await {
        Ok(result) => result,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let category = categories
        .find_one(doc! { "_id": insert_result.inserted_id })
        .await
        .ok()
        .flatten();
    let Some(category) = category else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };

    (
        axum::http::StatusCode::CREATED,
        Json(CreateCategoryResponse {
            message: "Category created successfully",
            category: document_to_json(category),
        }),
    )
        .into_response()
}

pub async fn category_admin_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateCategoryPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let categories = db.collection::<Document>("categories");
    let category_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return status_message(axum::http::StatusCode::NOT_FOUND, "Category not found"),
    };
    let category = categories
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(category) = category else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Category not found");
    };
    let previous_name = read_string(&category, "name");
    let mut set_doc = Document::new();

    if let Some(name) = payload.name {
        let normalized_name = name.trim().to_string();
        if normalized_name.is_empty() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nama kategori wajib diisi",
            );
        }
        let Some(slug) = slugify(&normalized_name) else {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Nama kategori tidak valid untuk dijadikan slug",
            );
        };
        let existing = categories
            .find_one(doc! { "slug": &slug, "_id": { "$ne": category_id } })
            .projection(doc! { "_id": 1 })
            .await
            .ok()
            .flatten();
        if existing.is_some() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Category with this name already exists",
            );
        }
        set_doc.insert("name", normalized_name);
        set_doc.insert("slug", slug);
    }

    if let Some(icon) = payload.icon {
        let previous_icon = read_string(&category, "icon");
        if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
            &crate::routes::uploads::upload_root(),
            &icon,
            crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
            effectively_changed_managed_field(Some(&previous_icon), &icon),
        ) {
            return response;
        }
        set_doc.insert("icon", icon);
    }
    if let Some(sort_order) = payload.sort_order {
        set_doc.insert("sortOrder", normalize_non_negative_number(sort_order));
    }
    if let Some(status) = payload.status {
        set_doc.insert("status", status);
    }

    set_doc.insert("updatedAt", DateTime::now());
    if categories
        .update_one(doc! { "_id": category_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    let updated_category = categories
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(updated_category) = updated_category else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Category not found");
    };

    let current_name = read_string(&updated_category, "name");
    if previous_name != current_name {
        let _ = db
            .collection::<Document>("products")
            .update_many(
                doc! { "$or": [{ "categoryId": category_id }, { "category": &previous_name }] },
                doc! { "$set": { "category": &current_name } },
            )
            .await;
    }

    let dependencies = category_dependencies(&db, &category_id, &current_name).await;
    let mut category_json = match document_to_json(updated_category) {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    for (key, value) in dependencies {
        category_json.insert(key, value);
    }

    Json(UpdateCategoryResponse {
        message: "Category updated successfully",
        category: Value::Object(category_json),
    })
    .into_response()
}

pub async fn category_admin_delete(
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
    let categories = db.collection::<Document>("categories");
    let category_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return status_message(axum::http::StatusCode::NOT_FOUND, "Category not found"),
    };
    let category = categories
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(category) = category else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Category not found");
    };
    let category_name = read_string(&category, "name");
    let dependencies = category_dependency_counts(&db, &category_id, &category_name).await;
    if dependencies.dependency_count > 0 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "message": dependency_message(&dependencies),
                "dependencies": dependencies_json(&dependencies),
            })),
        )
            .into_response();
    }

    if categories
        .delete_one(doc! { "_id": category_id })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }

    Json(MessageResponse {
        message: "Category deleted successfully",
    })
    .into_response()
}

pub async fn categories_public(State(state): State<Arc<AppState>>) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("categories")
        .find(doc! { "$or": [{ "status": true }, { "isActive": true }] })
        .sort(doc! { "sortOrder": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Json(docs.into_iter().map(document_to_json).collect::<Vec<_>>()).into_response()
}

pub async fn category_public_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(filter) = id_or_slug_filter(&id) else {
        return not_found("Category not found");
    };

    match client
        .database(&state.mongo_db)
        .collection::<Document>("categories")
        .find_one(filter)
        .await
        .ok()
        .flatten()
    {
        Some(document) => Json(document_to_json(document)).into_response(),
        None => not_found("Category not found"),
    }
}
