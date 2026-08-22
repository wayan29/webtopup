use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::{
    security::require_proxy_context,
    state::AppState,
    utils::bson::{escape_regex, read_i64},
};

use super::{
    bool_from_value, date_string, document_id, document_string, insert_optional_i64,
    internal_error, is_valid_pulsa_code, non_negative_i64, optional_bool, optional_date_string,
    optional_i64, seller_config, status_message, text_from_value, unavailable, LimitPayload,
    MappingItem, MappingListMeta, MappingListResponse, MappingListSummary, MappingProductItem,
    MappingQuery, SaveMappingPayload, SaveMappingResponse, SavedMappingItem, SellerConfig,
    SellerMappingBulkSyncResponse, SellerMappingSyncItem, SellerMappingSyncResult,
};

pub async fn mappings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<MappingQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let config = seller_config(&db).await;
    let current_page = query.page.unwrap_or(1).clamp(1, 100_000);
    let page_size = query.limit.unwrap_or(20).clamp(1, 100);
    let keyword = query.search.unwrap_or_default().trim().to_string();
    let mapped_filter = query
        .mapped
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_lowercase();

    let mut product_query = doc! {};
    if !keyword.is_empty() {
        let regex = Bson::RegularExpression(mongodb::bson::Regex {
            pattern: escape_regex(&keyword),
            options: "i".to_string(),
        });
        product_query.insert(
            "$or",
            vec![
                doc! { "name": regex.clone() },
                doc! { "code": regex.clone() },
                doc! { "brand": regex.clone() },
                doc! { "category": regex },
            ],
        );
    }

    let products = match db
        .collection::<Document>("products")
        .find(product_query)
        .projection(doc! {
            "name": 1,
            "code": 1,
            "brand": 1,
            "category": 1,
            "status": 1,
            "vendor": 1,
            "price": 1,
            "costPrice": 1,
            "updatedAt": 1,
        })
        .sort(doc! { "updatedAt": -1, "name": 1 })
        .await
    {
        Ok(cursor) => match cursor.try_collect::<Vec<_>>().await {
            Ok(docs) => docs,
            Err(_) => return internal_error(),
        },
        Err(_) => return internal_error(),
    };

    let product_ids = products
        .iter()
        .filter_map(|product| product.get_object_id("_id").ok())
        .collect::<Vec<_>>();
    let mappings_by_product = if product_ids.is_empty() {
        HashMap::new()
    } else {
        match db
            .collection::<Document>("digiflazzsellerproductmaps")
            .find(doc! { "product": { "$in": product_ids } })
            .projection(doc! {
                "product": 1,
                "pulsaCode": 1,
                "price": 1,
                "sellerMarginFlat": 1,
                "isActive": 1,
                "lastSyncStatus": 1,
                "lastSyncRc": 1,
                "lastSyncMessage": 1,
                "lastSyncAt": 1,
                "updatedAt": 1,
            })
            .await
        {
            Ok(cursor) => cursor
                .try_collect::<Vec<_>>()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|mapping| {
                    let product_id = mapping.get_object_id("product").ok()?.to_hex();
                    Some((product_id, mapping))
                })
                .collect::<HashMap<_, _>>(),
            Err(_) => HashMap::new(),
        }
    };

    let merged_items = products
        .into_iter()
        .map(|product| mapping_product_from_doc(product, &mappings_by_product, &config))
        .filter(|item| match mapped_filter.as_str() {
            "mapped" => item
                .mapping
                .as_ref()
                .map(|mapping| !mapping.id.is_empty())
                .unwrap_or(false),
            "unmapped" => item
                .mapping
                .as_ref()
                .map(|mapping| mapping.id.is_empty())
                .unwrap_or(true),
            _ => true,
        })
        .collect::<Vec<_>>();

    let total = merged_items.len() as i64;
    let total_pages = if total > 0 {
        ((total as f64) / (page_size as f64)).ceil() as i64
    } else {
        1
    };
    let start = ((current_page - 1) * page_size).max(0) as usize;
    let end = (start + page_size as usize).min(merged_items.len());
    let items = if start < merged_items.len() {
        merged_items[start..end].to_vec()
    } else {
        Vec::new()
    };
    let mapped_products = merged_items
        .iter()
        .filter(|item| {
            item.mapping
                .as_ref()
                .map(|mapping| !mapping.id.is_empty())
                .unwrap_or(false)
        })
        .count() as i64;
    let active_mappings = merged_items
        .iter()
        .filter(|item| {
            item.mapping
                .as_ref()
                .map(|mapping| mapping.is_active)
                .unwrap_or(false)
        })
        .count() as i64;

    Json(MappingListResponse {
        items,
        meta: MappingListMeta {
            page: current_page,
            limit: page_size,
            total,
            total_pages,
        },
        summary: MappingListSummary {
            total_products: total,
            mapped_products,
            active_mappings,
        },
    })
    .into_response()
}

pub async fn save_mapping(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveMappingPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let product_id_text = payload
        .product_id
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default();
    let Ok(product_id) = ObjectId::parse_str(&product_id_text) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Produk tidak valid");
    };
    let pulsa_code = payload
        .pulsa_code
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default()
        .to_lowercase();
    if pulsa_code.is_empty() || !is_valid_pulsa_code(&pulsa_code) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Pulsa code wajib huruf kecil, angka, titik, underscore, atau dash",
        );
    }

    let db = client.database(&state.mongo_db);
    let config = seller_config(&db).await;
    let products = db.collection::<Document>("products");
    let product = match products
        .find_one(doc! { "_id": product_id })
        .projection(doc! { "name": 1, "code": 1, "brand": 1, "category": 1, "price": 1, "costPrice": 1, "vendor": 1, "status": 1 })
        .await
    {
        Ok(Some(product)) => product,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "Produk tidak ditemukan"),
        Err(_) => return internal_error(),
    };

    let mappings = db.collection::<Document>("digiflazzsellerproductmaps");
    if let Ok(Some(existing_by_code)) = mappings.find_one(doc! { "pulsaCode": &pulsa_code }).await {
        if existing_by_code
            .get_object_id("product")
            .map(|id| id != product_id)
            .unwrap_or(true)
        {
            return status_message(
                axum::http::StatusCode::CONFLICT,
                "Pulsa code sudah dipakai produk lain",
            );
        }
    }

    let existing_mapping = match mappings.find_one(doc! { "product": product_id }).await {
        Ok(mapping) => mapping,
        Err(_) => return internal_error(),
    };
    let cost_price = read_i64(&product, "costPrice").max(0);
    let raw_margin_provided = payload
        .seller_margin_flat
        .as_ref()
        .map(|value| !text_from_value(value).is_empty())
        .unwrap_or(false);
    let raw_price_provided = payload
        .price
        .as_ref()
        .map(|value| !text_from_value(value).is_empty())
        .unwrap_or(false);
    let next_custom_margin = if raw_margin_provided {
        Some(non_negative_i64(payload.seller_margin_flat.as_ref(), 0))
    } else if raw_price_provided {
        Some((non_negative_i64(payload.price.as_ref(), 0) - cost_price).max(0))
    } else {
        existing_mapping
            .as_ref()
            .and_then(|mapping| optional_i64(mapping, "sellerMarginFlat"))
    };
    let recommended_price =
        seller_recommended_price(cost_price, config.seller_margin_flat, next_custom_margin);
    let next_status = bool_from_value(payload.is_active.as_ref()).unwrap_or_else(|| {
        existing_mapping
            .as_ref()
            .and_then(|mapping| optional_bool(mapping, "isActive"))
            .unwrap_or(true)
    });
    let now = DateTime::now();

    let mapping_id = if let Some(existing) = existing_mapping {
        let Some(id) = existing.get_object_id("_id").ok() else {
            return internal_error();
        };
        let mut set_doc = doc! {
            "pulsaCode": &pulsa_code,
            "price": recommended_price,
            "isActive": next_status,
            "updatedAt": now,
        };
        insert_optional_i64(&mut set_doc, "sellerMarginFlat", next_custom_margin);
        if mappings
            .update_one(doc! { "_id": id }, doc! { "$set": set_doc })
            .await
            .is_err()
        {
            return internal_error();
        }
        id
    } else {
        let id = ObjectId::new();
        let mut document = doc! {
            "_id": id,
            "product": product_id,
            "pulsaCode": &pulsa_code,
            "price": recommended_price,
            "isActive": next_status,
            "lastSyncStatus": "never",
            "createdAt": now,
            "updatedAt": now,
        };
        insert_optional_i64(&mut document, "sellerMarginFlat", next_custom_margin);
        if mappings.insert_one(document).await.is_err() {
            return internal_error();
        }
        id
    };

    let saved_mapping = match mappings.find_one(doc! { "_id": mapping_id }).await {
        Ok(Some(mapping)) => mapping,
        _ => return internal_error(),
    };
    Json(SaveMappingResponse {
        success: true,
        message: "Mapping Digiflazz Seller berhasil disimpan",
        mapping: saved_mapping_response(
            &saved_mapping,
            &product,
            cost_price,
            recommended_price,
            &config,
        ),
        sync_result: None,
    })
    .into_response()
}

pub async fn delete_mapping(
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
    let Ok(mapping_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Mapping tidak valid");
    };
    let mappings = client
        .database(&state.mongo_db)
        .collection::<Document>("digiflazzsellerproductmaps");
    match mappings.delete_one(doc! { "_id": mapping_id }).await {
        Ok(result) if result.deleted_count > 0 => Json(serde_json::json!({
            "success": true,
            "message": "Mapping Digiflazz Seller berhasil dihapus"
        }))
        .into_response(),
        Ok(_) => status_message(axum::http::StatusCode::NOT_FOUND, "Mapping tidak ditemukan"),
        Err(_) => internal_error(),
    }
}

pub async fn sync_mapping_by_id(
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
    let Ok(mapping_id) = ObjectId::parse_str(&id) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Mapping tidak valid");
    };
    let db = client.database(&state.mongo_db);
    let mappings = db.collection::<Document>("digiflazzsellerproductmaps");
    let mapping = match mappings.find_one(doc! { "_id": mapping_id }).await {
        Ok(Some(mapping)) => mapping,
        Ok(None) => {
            return status_message(axum::http::StatusCode::NOT_FOUND, "Mapping tidak ditemukan")
        }
        Err(_) => return internal_error(),
    };
    match sync_seller_product_mapping(&db, &mapping).await {
        Ok(result) => Json(result).into_response(),
        Err(SyncMappingError::CredentialsRequired) => status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Konfigurasi Digiflazz Seller belum lengkap",
        ),
        Err(SyncMappingError::Database) => internal_error(),
    }
}

pub async fn sync_all_mappings(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LimitPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let limit = non_negative_i64(payload.limit.as_ref(), 50).clamp(1, 60);
    let mappings = match db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find(doc! {})
        .sort(doc! { "updatedAt": -1 })
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => return internal_error(),
    };
    let mut results = Vec::new();
    for mapping in mappings {
        let id = document_id(&mapping);
        let pulsa_code = document_string(&mapping, "pulsaCode");
        match sync_seller_product_mapping(&db, &mapping).await {
            Ok(result) => results.push(SellerMappingSyncItem {
                id,
                pulsa_code,
                success: result.success,
                rc: result.rc,
                message: result.message,
            }),
            Err(SyncMappingError::CredentialsRequired) => {
                return status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Konfigurasi Digiflazz Seller belum lengkap",
                )
            }
            Err(SyncMappingError::Database) => return internal_error(),
        }
    }
    let success_count = results.iter().filter(|item| item.success).count();
    Json(SellerMappingBulkSyncResponse {
        success: true,
        total: results.len(),
        success_count,
        failed_count: results.len().saturating_sub(success_count),
        results,
    })
    .into_response()
}

#[derive(Debug)]
pub(super) enum SyncMappingError {
    CredentialsRequired,
    Database,
}

pub(super) async fn sync_seller_product_mapping(
    db: &mongodb::Database,
    mapping: &Document,
) -> Result<SellerMappingSyncResult, SyncMappingError> {
    let config = seller_config(db).await;
    if config.username.is_empty() || config.api_key.is_empty() {
        return Err(SyncMappingError::CredentialsRequired);
    }
    let product_id = mapping.get_object_id("product").ok();
    let product = if let Some(product_id) = product_id {
        db.collection::<Document>("products")
            .find_one(doc! { "_id": product_id })
            .projection(doc! { "costPrice": 1 })
            .await
            .map_err(|_| SyncMappingError::Database)?
    } else {
        None
    };
    let cost_price = product
        .as_ref()
        .map(|doc| read_i64(doc, "costPrice"))
        .unwrap_or(0);
    let price = seller_recommended_price(
        cost_price,
        config.seller_margin_flat,
        optional_i64(mapping, "sellerMarginFlat"),
    );
    let pulsa_code = document_string(mapping, "pulsaCode");
    let is_active = mapping.get_bool("isActive").unwrap_or(false);
    let sign = format!(
        "{:x}",
        md5::compute(format!(
            "{}{}{}update_product",
            config.username, pulsa_code, config.api_key
        ))
    );
    let payload = serde_json::json!({
        "username": config.username,
        "pulsa_code": pulsa_code,
        "price": price,
        "status": if is_active { 1 } else { 0 },
        "sign": sign,
    });

    let result = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| SyncMappingError::Database)?
        .post("https://api.digiflazz.com/v1/seller/api/prepaid/product/update")
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => {
            let data = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or_default();
            let response_data = data
                .get("data")
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let rc = response_data
                .get("rc")
                .and_then(|value| value.as_str())
                .unwrap_or("00")
                .trim()
                .to_string();
            let message = response_data
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Success")
                .trim()
                .to_string();
            SellerMappingSyncResult {
                success: rc == "00",
                rc,
                message,
            }
        }
        Err(error) => SellerMappingSyncResult {
            success: false,
            rc: "07".to_string(),
            message: error.to_string(),
        },
    };

    let mapping_id = mapping
        .get_object_id("_id")
        .map_err(|_| SyncMappingError::Database)?;
    db.collection::<Document>("digiflazzsellerproductmaps")
        .update_one(
            doc! { "_id": mapping_id },
            doc! { "$set": {
                "price": price,
                "lastSyncStatus": if result.success { "success" } else { "failed" },
                "lastSyncRc": &result.rc,
                "lastSyncMessage": &result.message,
                "lastSyncAt": DateTime::now(),
                "updatedAt": DateTime::now(),
            } },
        )
        .await
        .map_err(|_| SyncMappingError::Database)?;

    Ok(result)
}

fn mapping_product_from_doc(
    product: Document,
    mappings_by_product: &HashMap<String, Document>,
    config: &SellerConfig,
) -> MappingProductItem {
    let product_id = document_id(&product);
    let cost_price = read_i64(&product, "costPrice");
    let mapping = mappings_by_product
        .get(&product_id)
        .map(|mapping| mapping_item_from_doc(mapping, cost_price, config));

    MappingProductItem {
        id: product_id,
        name: document_string(&product, "name"),
        code: document_string(&product, "code"),
        brand: document_string(&product, "brand"),
        category: document_string(&product, "category"),
        status: product.get_bool("status").unwrap_or(false),
        vendor: document_string(&product, "vendor"),
        price: read_i64(&product, "price"),
        cost_price,
        recommended_price: seller_recommended_price(cost_price, config.seller_margin_flat, None),
        updated_at: date_string(&product, "updatedAt"),
        mapping,
    }
}

fn mapping_item_from_doc(
    mapping: &Document,
    cost_price: i64,
    config: &SellerConfig,
) -> MappingItem {
    let seller_margin_flat = optional_i64(mapping, "sellerMarginFlat");
    MappingItem {
        id: document_id(mapping),
        pulsa_code: document_string(mapping, "pulsaCode"),
        price: seller_recommended_price(cost_price, config.seller_margin_flat, seller_margin_flat),
        seller_margin_flat,
        effective_margin_flat: seller_effective_margin(
            config.seller_margin_flat,
            seller_margin_flat,
        ),
        is_active: mapping.get_bool("isActive").unwrap_or(false),
        last_sync_status: document_string(mapping, "lastSyncStatus"),
        last_sync_rc: document_string(mapping, "lastSyncRc"),
        last_sync_message: document_string(mapping, "lastSyncMessage"),
        last_sync_at: optional_date_string(mapping, "lastSyncAt"),
        updated_at: date_string(mapping, "updatedAt"),
    }
}

pub(super) fn seller_recommended_price(
    cost_price: i64,
    default_margin_flat: i64,
    override_margin_flat: Option<i64>,
) -> i64 {
    cost_price + seller_effective_margin(default_margin_flat, override_margin_flat)
}

fn seller_effective_margin(default_margin_flat: i64, override_margin_flat: Option<i64>) -> i64 {
    override_margin_flat.unwrap_or(default_margin_flat).max(0)
}

fn saved_mapping_response(
    mapping: &Document,
    product: &Document,
    cost_price: i64,
    recommended_price: i64,
    config: &SellerConfig,
) -> SavedMappingItem {
    let seller_margin_flat = optional_i64(mapping, "sellerMarginFlat");
    SavedMappingItem {
        id: document_id(mapping),
        product_id: product
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        product_name: document_string(product, "name"),
        product_code: document_string(product, "code"),
        cost_price,
        recommended_price,
        seller_margin_flat,
        effective_margin_flat: seller_effective_margin(
            config.seller_margin_flat,
            seller_margin_flat,
        ),
        pulsa_code: document_string(mapping, "pulsaCode"),
        price: read_i64(mapping, "price"),
        is_active: mapping.get_bool("isActive").unwrap_or(false),
        last_sync_status: document_string(mapping, "lastSyncStatus"),
        last_sync_rc: document_string(mapping, "lastSyncRc"),
        last_sync_message: document_string(mapping, "lastSyncMessage"),
        last_sync_at: optional_date_string(mapping, "lastSyncAt"),
    }
}
