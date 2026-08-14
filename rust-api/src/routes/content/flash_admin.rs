use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{security::require_permission, state::AppState};

use super::{
    collect_flash_sale_product_ids, current_flash_sale_products, date_value, document_to_json,
    enrich_flash_sales_for_admin, flash_sale_document, flash_sale_record_from_doc,
    flash_sale_status_key, internal_error, normalized_products_bson, not_found,
    object_id_from_bson, populated_flash_sale_document, product_snapshots,
    sanitize_flash_sale_payload, status_message, unavailable, validate_flash_sale_products,
    FlashSalePayload, FlashSaleProductPayload, FlashSaleResponse, MessageResponse,
};

pub async fn flash_sales_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let flash_sale_docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("flashsales")
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_ids = collect_flash_sale_product_ids(&flash_sale_docs);
    let product_map = product_snapshots(client, &state.mongo_db, product_ids).await;
    let records = flash_sale_docs
        .into_iter()
        .map(|document| flash_sale_record_from_doc(document, &product_map))
        .collect::<Vec<_>>();

    Json(enrich_flash_sales_for_admin(records)).into_response()
}

pub async fn flash_sale_admin_detail(
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
    let Ok(object_id) = ObjectId::parse_str(&id) else {
        return not_found("Flash Sale not found");
    };

    let flash_sale = client
        .database(&state.mongo_db)
        .collection::<Document>("flashsales")
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten();
    let Some(flash_sale) = flash_sale else {
        return not_found("Flash Sale not found");
    };

    let product_ids = collect_flash_sale_product_ids(std::slice::from_ref(&flash_sale));
    let product_map = product_snapshots(client, &state.mongo_db, product_ids).await;
    Json(populated_flash_sale_document(flash_sale, &product_map)).into_response()
}

pub async fn flash_sale_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FlashSalePayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let sanitized = match sanitize_flash_sale_payload(&db, payload, None).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = DateTime::now();
    let banner = sanitized.banner.clone();
    let document = flash_sale_document(sanitized, now, now);
    let flash_sales = db.collection::<Document>("flashsales");
    let insert_result = if let Some(path) = crate::services::managed_assets::effectively_changed_cover_path(None, &banner) {
        if !state.mongo_transactions_enabled {
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
        let mut session = match crate::services::managed_assets::start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return crate::services::managed_assets::managed_asset_registry_unavailable_response(),
        };
        if crate::services::managed_assets::fence_legacy_managed_writes(&mut session, &db, &[path]).await.is_err() {
            let _ = crate::services::managed_assets::abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            ).await;
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
        let result = match flash_sales.insert_one(document).session(&mut session).await {
            Ok(result) => result,
            Err(_) => {
                let _ = session.abort_transaction().await;
                return internal_error();
            }
        };
        if crate::services::managed_assets::commit_legacy_managed_write(&mut session).await.is_err() {
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
        result
    } else {
        match flash_sales.insert_one(document).await {
            Ok(result) => result,
            Err(_) => return internal_error(),
        }
    };
    let Some(id) = insert_result.inserted_id.as_object_id() else {
        return internal_error();
    };
    let Some(flash_sale) = flash_sales
        .find_one(doc! { "_id": id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    (
        axum::http::StatusCode::CREATED,
        Json(FlashSaleResponse {
            message: "Flash Sale created",
            flash_sale: document_to_json(flash_sale),
        }),
    )
        .into_response()
}

pub async fn flash_sale_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<FlashSalePayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return not_found("Flash Sale not found");
    };
    let db = client.database(&state.mongo_db);
    let flash_sales = db.collection::<Document>("flashsales");
    let Some(current) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    let previous_banner = crate::utils::bson::read_string(&current, "banner");
    let sanitized = match sanitize_flash_sale_payload(&db, payload, Some(&current)).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let created_at = current
        .get_datetime("createdAt")
        .copied()
        .unwrap_or_else(|_| DateTime::now());
    let next_banner = sanitized.banner.clone();
    let updated = flash_sale_document(sanitized, created_at, DateTime::now());
    if let Some(path) = crate::services::managed_assets::effectively_changed_cover_path(
        Some(&previous_banner),
        &next_banner,
    ) {
        if !state.mongo_transactions_enabled {
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
        let mut session = match crate::services::managed_assets::start_legacy_managed_write(client).await {
            Ok(session) => session,
            Err(_) => return crate::services::managed_assets::managed_asset_registry_unavailable_response(),
        };
        if crate::services::managed_assets::fence_legacy_managed_writes(&mut session, &db, &[path]).await.is_err() {
            let _ = crate::services::managed_assets::abort_legacy_managed_write(
                &mut session,
                crate::services::managed_asset_registry::RegistryError::Unavailable,
            ).await;
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
        if flash_sales
            .update_one(doc! { "_id": object_id }, doc! { "$set": updated })
            .session(&mut session)
            .await
            .is_err()
        {
            let _ = session.abort_transaction().await;
            return internal_error();
        }
        if crate::services::managed_assets::commit_legacy_managed_write(&mut session).await.is_err() {
            return crate::services::managed_assets::managed_asset_registry_unavailable_response();
        }
    } else if flash_sales
        .update_one(doc! { "_id": object_id }, doc! { "$set": updated })
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(flash_sale) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    Json(FlashSaleResponse {
        message: "Flash Sale updated",
        flash_sale: document_to_json(flash_sale),
    })
    .into_response()
}

pub async fn flash_sale_delete(
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
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return not_found("Flash Sale not found");
    };
    let flash_sales = client
        .database(&state.mongo_db)
        .collection::<Document>("flashsales");
    let Some(flash_sale) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    let record = flash_sale_record_from_doc(flash_sale, &HashMap::new());
    if flash_sale_status_key(&record, DateTime::now().timestamp_millis()) == "live" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Flash sale yang sedang berlangsung tidak bisa dihapus. Nonaktifkan dulu atau tunggu sampai selesai.",
        );
    }
    if flash_sales
        .delete_one(doc! { "_id": object_id })
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(MessageResponse {
        message: "Flash Sale deleted",
    })
    .into_response()
}

pub async fn flash_sale_add_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<FlashSaleProductPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return not_found("Flash Sale not found");
    };
    let db = client.database(&state.mongo_db);
    let flash_sales = db.collection::<Document>("flashsales");
    let Some(current) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    let products = current_flash_sale_products(&current)
        .into_iter()
        .chain(std::iter::once(payload))
        .collect::<Vec<_>>();
    let start_date = date_value(&current, "startDate");
    let end_date = date_value(&current, "endDate");
    let is_active = current.get_bool("isActive").unwrap_or(true);
    let normalized = match validate_flash_sale_products(
        &db,
        products,
        start_date,
        end_date,
        is_active,
        Some(object_id),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if flash_sales
        .update_one(
            doc! { "_id": object_id },
            doc! { "$set": { "products": normalized_products_bson(normalized), "updatedAt": DateTime::now() } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(flash_sale) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    Json(FlashSaleResponse {
        message: "Product added to flash sale",
        flash_sale: document_to_json(flash_sale),
    })
    .into_response()
}

pub async fn flash_sale_remove_product(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path((id, product_id)): Path<(String, String)>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageProducts").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return not_found("Flash Sale not found");
    };
    let db = client.database(&state.mongo_db);
    let flash_sales = db.collection::<Document>("flashsales");
    let Some(current) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    let record = flash_sale_record_from_doc(current.clone(), &HashMap::new());
    if flash_sale_status_key(&record, DateTime::now().timestamp_millis()) == "live" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Produk tidak bisa dihapus saat flash sale sedang berlangsung",
        );
    }
    let product_object_id = ObjectId::parse_str(product_id.trim()).ok();
    let mut found_product = false;
    let mut has_sales = false;
    let products = current
        .get_array("products")
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            let Some(document) = item.as_document() else {
                return true;
            };
            let Some(id) = object_id_from_bson(document.get("productId")) else {
                return true;
            };
            let matches = product_object_id
                .map(|target| target == id)
                .unwrap_or(false);
            if matches {
                found_product = true;
                has_sales = document
                    .get_i64("soldCount")
                    .or_else(|_| document.get_i32("soldCount").map(i64::from))
                    .unwrap_or(0)
                    > 0;
            }
            !matches
        })
        .collect::<Vec<_>>();
    if !found_product {
        return not_found("Produk tidak ditemukan di flash sale");
    }
    if has_sales {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Produk sudah memiliki penjualan promo dan tidak bisa dihapus",
        );
    }
    if flash_sales
        .update_one(
            doc! { "_id": object_id },
            doc! { "$set": { "products": products, "updatedAt": DateTime::now() } },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let Some(flash_sale) = flash_sales
        .find_one(doc! { "_id": object_id })
        .await
        .ok()
        .flatten()
    else {
        return not_found("Flash Sale not found");
    };
    Json(FlashSaleResponse {
        message: "Product removed from flash sale",
        flash_sale: document_to_json(flash_sale),
    })
    .into_response()
}
