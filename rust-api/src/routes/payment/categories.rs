use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::oid::ObjectId;
use mongodb::bson::{doc, Bson, Document};

use crate::{
    security::{load_active_proxy_user, require_permission},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    mappers::{payment_category_item_from_doc, public_payment_category_from_doc},
    queries::{find_sorted, method_stats_by_category},
    responses::{not_found, status_message, string_message, unavailable},
    types::{
        MessageResponse, PaymentCategoryPayload, PaymentCategoryResponse,
        ReorderPaymentCategoriesPayload,
    },
    utils::{escape_regex, read_string_default, slugify},
};

pub async fn categories_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewPayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let stats = method_stats_by_category(&db).await;
    let docs = find_sorted(
        &db,
        "paymentcategories",
        doc! { "order": 1, "createdAt": -1 },
    )
    .await;
    Json(
        docs.into_iter()
            .map(|document| payment_category_item_from_doc(document, &stats))
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn categories_public(State(state): State<Arc<AppState>>) -> Response {
    categories_public_response(&state).await
}

pub async fn categories_active(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = load_active_proxy_user(&headers, &state).await {
        return response;
    }
    categories_public_response(&state).await
}

pub async fn categories_reorder(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReorderPaymentCategoriesPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(orders) = payload.orders else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload reorder tidak valid",
        );
    };
    if orders.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload reorder tidak valid",
        );
    }

    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for item in orders {
        let object_id = match ObjectId::parse_str(&item.id) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Ada ID kategori yang tidak valid pada payload reorder",
                )
            }
        };
        if !seen.insert(item.id) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payload reorder mengandung ID kategori duplikat",
            );
        }
        if item.order < 1 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Urutan kategori harus berupa bilangan bulat positif",
            );
        }
        normalized.push((object_id, item.order));
    }

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("paymentcategories");
    let ids = normalized
        .iter()
        .map(|(id, _)| Bson::ObjectId(*id))
        .collect::<Vec<_>>();
    let category_count = collection
        .count_documents(doc! { "_id": { "$in": ids } })
        .await
        .unwrap_or(0) as usize;
    if category_count != normalized.len() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada kategori yang tidak ditemukan saat reorder",
        );
    }

    for (id, order) in normalized {
        if collection
            .update_one(doc! { "_id": id }, doc! { "$set": { "order": order } })
            .await
            .is_err()
        {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    }

    Json(MessageResponse {
        message: "Order updated successfully",
    })
    .into_response()
}

pub async fn category_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PaymentCategoryPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("paymentcategories");
    let name = payload
        .name
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori wajib diisi",
        );
    }
    let slug_candidate = match payload.slug.as_deref() {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => name.clone(),
    };
    let slug = slugify(&slug_candidate);
    if slug.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Slug kategori tidak valid",
        );
    }
    let status = payload.status.unwrap_or_else(|| "active".to_string());
    if status != "active" && status != "inactive" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status kategori tidak valid",
        );
    }
    let duplicate = collection
        .find_one(doc! {
            "$or": [
                { "slug": &slug },
                { "name": { "$regex": format!("^{}$", escape_regex(&name)), "$options": "i" } },
            ],
        })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if duplicate.is_some() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori dengan nama atau slug tersebut sudah ada",
        );
    }
    let max_order = collection
        .find_one(doc! {})
        .sort(doc! { "order": -1 })
        .projection(doc! { "order": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "order"))
        .unwrap_or(0);
    let order = match payload.order {
        Some(value) if value.is_finite() && value > 0.0 => value.floor() as i64,
        _ => max_order + 1,
    };
    let now = mongodb::bson::DateTime::now();
    let icon = payload.icon.unwrap_or_default().trim().to_string();
    if let Err(response) = crate::services::managed_assets::ensure_managed_fields(&crate::routes::uploads::upload_root(), &[&icon]) {
        return response;
    }
    let insert_doc = doc! {
        "name": name,
        "slug": slug,
        "icon": icon,
        "status": status,
        "order": order,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    let insert_result = match collection.insert_one(insert_doc).await {
        Ok(result) => result,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let category = collection
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
        Json(PaymentCategoryResponse {
            message: "Payment category created",
            category: public_payment_category_from_doc(category),
        }),
    )
        .into_response()
}

pub async fn category_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PaymentCategoryPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let category_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID kategori tidak valid",
            )
        }
    };
    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("paymentcategories");
    let current = collection
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(current) = current else {
        return not_found("Payment category not found");
    };

    let current_name = read_string(&current, "name");
    let name = payload
        .name
        .as_deref()
        .unwrap_or(&current_name)
        .trim()
        .to_string();
    if name.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama kategori wajib diisi",
        );
    }
    let current_slug = read_string(&current, "slug");
    let slug_candidate = match payload.slug.as_deref() {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        Some(_) => name.clone(),
        None if payload.name.is_some() => name.clone(),
        None => current_slug,
    };
    let slug = slugify(&slug_candidate);
    if slug.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Slug kategori tidak valid",
        );
    }
    let status = payload
        .status
        .as_deref()
        .unwrap_or(&read_string_default(&current, "status", "active"))
        .to_string();
    if status != "active" && status != "inactive" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status kategori tidak valid",
        );
    }
    let duplicate = collection
        .find_one(doc! {
            "$or": [
                { "slug": &slug },
                { "name": { "$regex": format!("^{}$", escape_regex(&name)), "$options": "i" } },
            ],
            "_id": { "$ne": category_id },
        })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten();
    if duplicate.is_some() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori dengan nama atau slug tersebut sudah ada",
        );
    }

    let icon = payload
        .icon
        .unwrap_or_else(|| read_string(&current, "icon"))
        .trim()
        .to_string();
    if let Err(response) = crate::services::managed_assets::ensure_managed_fields(&crate::routes::uploads::upload_root(), &[&icon]) {
        return response;
    }
    let mut set_doc = doc! {
        "name": name,
        "slug": slug,
        "icon": icon,
        "status": status,
    };
    if let Some(order) = payload.order {
        if order.is_finite() && order > 0.0 {
            set_doc.insert("order", order.floor() as i64);
        }
    }

    if collection
        .update_one(doc! { "_id": category_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    let category = collection
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(category) = category else {
        return not_found("Payment category not found");
    };
    Json(PaymentCategoryResponse {
        message: "Payment category updated",
        category: public_payment_category_from_doc(category),
    })
    .into_response()
}

pub async fn category_delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let category_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID kategori tidak valid",
            )
        }
    };
    let db = client.database(&state.mongo_db);
    let categories = db.collection::<Document>("paymentcategories");
    let category = categories
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten();
    let Some(category) = category else {
        return not_found("Payment category not found");
    };
    let method_count = db
        .collection::<Document>("paymentmethods")
        .count_documents(doc! { "category": category_id })
        .await
        .unwrap_or(0);
    if method_count > 0 {
        return string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Kategori \"{}\" masih dipakai oleh {} metode pembayaran dan tidak bisa dihapus.",
                read_string(&category, "name"),
                method_count
            ),
        );
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
        message: "Payment category deleted",
    })
    .into_response()
}

async fn categories_public_response(state: &AppState) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("paymentcategories")
        .find(doc! { "status": "active" })
        .sort(doc! { "order": 1, "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(
        docs.into_iter()
            .map(public_payment_category_from_doc)
            .collect::<Vec<_>>(),
    )
    .into_response()
}
