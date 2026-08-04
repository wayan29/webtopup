use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use mongodb::options::ReturnDocument;
use serde::Deserialize;

use super::audit::{
    build_validation_product_audit_document, persist_validation_product_audit,
    resolve_audit_operation, ValidationProductAuditOperation,
};
use super::concurrency::{
    active_version_filter, validate_expected_version, validation_product_version_for_mutation,
    validation_product_version_for_response, versioned_update,
};

use crate::{
    security::{require_permission, ErrorResponse},
    services::product_id::{
        allocate_product_id, classify_duplicate_key_constraint, is_duplicate_key,
        should_retry_duplicate_product_id_attempt, DuplicateKeyConstraint,
        MAX_PRODUCT_ID_INSERT_ATTEMPTS,
    },
    state::AppState,
};

use crate::routes::products::utils::{document_to_json, lookup_stage, unwind_stage};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationProductPayload {
    pub name: Option<String>,
    pub code: Option<String>,
    pub category_id: Option<String>,
    pub operator_id: Option<String>,
    pub product_type_id: Option<String>,
    pub cost_price: Option<i64>,
    pub price: Option<ValidationProductPricePayload>,
    pub status: Option<bool>,
    pub validation_type: Option<String>,
    pub game: Option<String>,
    pub target_label: Option<String>,
    pub secondary_target_label: Option<String>,
    pub result_label: Option<String>,
    pub version: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationProductVersionQuery {
    pub version: i64,
}

#[derive(Deserialize)]
pub struct ValidationProductPricePayload {
    pub basic: Option<i64>,
    pub gold: Option<i64>,
    pub platinum: Option<i64>,
}

fn clean_text(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(max).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn status_message(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn validation_product_conflict() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Data produk telah berubah. Muat ulang daftar sebelum mencoba lagi.",
            "code": "VALIDATION_PRODUCT_CONFLICT",
        })),
    )
        .into_response()
}

fn validation_product_json(document: Document) -> serde_json::Value {
    let version = validation_product_version_for_response(&document);
    let mut value = document_to_json(document);
    if let Some(map) = value.as_object_mut() {
        map.remove("__v");
        if let Some(version) = version {
            map.insert("version".to_string(), serde_json::json!(version));
        }
    }
    value
}

const MAX_VALIDATION_PRICE: i64 = 100_000_000;

fn parse_object_id(value: &str) -> Result<ObjectId, Response> {
    ObjectId::parse_str(value)
        .map_err(|_| status_message(StatusCode::BAD_REQUEST, "ID tidak valid"))
}

pub async fn list(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return status_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "Layanan database belum tersedia",
        );
    };

    let db = client.database(&state.mongo_db);
    let pipeline = vec![
        doc! { "$match": { "validation.enabled": true, "validation.archived": { "$ne": true } } },
        lookup_stage("categories", "categoryId", "categoryData"),
        unwind_stage("$categoryData"),
        lookup_stage("operators", "operatorId", "operatorData"),
        unwind_stage("$operatorData"),
        lookup_stage("producttypes", "productTypeId", "productTypeData"),
        unwind_stage("$productTypeData"),
        doc! { "$sort": { "updatedAt": -1 } },
    ];

    let items = match db
        .collection::<Document>("products")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => match cursor.try_collect::<Vec<_>>().await {
            Ok(documents) => documents
                .into_iter()
                .map(validation_product_json)
                .collect::<Vec<_>>(),
            Err(_) => {
                return status_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Gagal memuat produk validasi",
                );
            }
        },
        Err(_) => {
            return status_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Gagal memuat produk validasi",
            );
        }
    };

    Json(serde_json::json!({ "items": items })).into_response()
}

pub async fn create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ValidationProductPayload>,
) -> Response {
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return status_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "Layanan database belum tersedia",
        );
    };
    let db = client.database(&state.mongo_db);
    let products = db.collection::<Document>("products");

    let Some(name) = clean_text(payload.name, 120) else {
        return status_message(StatusCode::BAD_REQUEST, "Nama produk wajib diisi");
    };
    let Some(code) = clean_text(payload.code, 80) else {
        return status_message(StatusCode::BAD_REQUEST, "Kode produk wajib diisi");
    };
    let Some(category_id) = clean_text(payload.category_id, 64) else {
        return status_message(StatusCode::BAD_REQUEST, "Kategori wajib dipilih");
    };
    let Some(operator_id) = clean_text(payload.operator_id, 64) else {
        return status_message(StatusCode::BAD_REQUEST, "Operator wajib dipilih");
    };
    let Some(product_type_id) = clean_text(payload.product_type_id, 64) else {
        return status_message(StatusCode::BAD_REQUEST, "Tipe produk wajib dipilih");
    };
    let category_oid = match parse_object_id(&category_id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let operator_oid = match parse_object_id(&operator_id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let product_type_oid = match parse_object_id(&product_type_id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(response) =
        ensure_catalog_references(&db, category_oid, operator_oid, product_type_oid).await
    {
        return response;
    }

    if products
        .find_one(doc! { "code": &code })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_some()
    {
        return duplicate_code(&code);
    }

    let validation_type =
        clean_text(payload.validation_type, 20).unwrap_or_else(|| "operator".to_string());
    if !matches!(validation_type.as_str(), "nickname" | "operator") {
        return status_message(StatusCode::BAD_REQUEST, "Tipe validasi tidak valid");
    }
    let game = clean_text(payload.game, 30).unwrap_or_default();
    if validation_type == "nickname" && !matches!(game.as_str(), "freefire" | "mobilelegends") {
        return status_message(StatusCode::BAD_REQUEST, "Game validasi tidak valid");
    }
    if validation_type == "operator" && !game.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "Game validasi tidak valid");
    }

    let price = payload.price.unwrap_or(ValidationProductPricePayload {
        basic: Some(0),
        gold: Some(0),
        platinum: Some(0),
    });
    let (basic, gold, platinum) = match normalize_price_tiers(price) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let cost_price = match normalize_money(payload.cost_price.unwrap_or(0), "Harga modal") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = DateTime::now();
    let target_label = clean_text(payload.target_label, 60).unwrap_or_else(|| "Target".to_string());
    let secondary_target_label = clean_text(payload.secondary_target_label, 60).unwrap_or_default();
    let result_label = clean_text(payload.result_label, 60).unwrap_or_else(|| "Hasil".to_string());
    let inserted_id = match insert_validation_product_with_allocated_id(
        &db,
        &products,
        &code,
        &name,
        category_oid,
        operator_oid,
        product_type_oid,
        cost_price,
        basic,
        gold,
        platinum,
        payload.status.unwrap_or(true),
        &validation_type,
        &game,
        &target_label,
        &secondary_target_label,
        &result_label,
        now,
    )
    .await
    {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(id) = inserted_id else {
        return status_message(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Produk validasi tersimpan tanpa ID",
        );
    };

    let Some(inserted_doc) = products.find_one(doc! { "_id": id }).await.ok().flatten() else {
        return status_message(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Produk validasi tidak ditemukan setelah disimpan",
        );
    };
    let sku = inserted_doc.get_str("code").unwrap_or_default().to_string();
    let audit_at = DateTime::now();
    let audit_doc = build_validation_product_audit_document(
        &actor,
        ValidationProductAuditOperation::Create,
        id,
        &sku,
        None,
        Some(&inserted_doc),
        &headers,
        audit_at,
    );
    persist_validation_product_audit(&db, audit_doc, id, ValidationProductAuditOperation::Create)
        .await;

    match populated_validation_product(&db, id).await {
        Some(product) => Json(product).into_response(),
        None => status_message(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Produk validasi tidak ditemukan setelah disimpan",
        ),
    }
}

pub async fn update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<ValidationProductPayload>,
) -> Response {
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(expected_version) = payload.version else {
        return status_message(StatusCode::BAD_REQUEST, "Versi produk wajib dikirim");
    };
    if validate_expected_version(expected_version).is_err() {
        return status_message(StatusCode::BAD_REQUEST, "Versi produk tidak valid");
    }
    let product_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return status_message(StatusCode::BAD_REQUEST, "ID produk tidak valid"),
    };
    let Some(client) = &state.mongo_client else {
        return status_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "Layanan database belum tersedia",
        );
    };

    let db = client.database(&state.mongo_db);
    let products = db.collection::<Document>("products");
    let existing = products
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten();
    let Some(existing) = existing else {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    };
    if existing.get_bool("validation.enabled").ok() != Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    }
    if existing.get_bool("validation.archived").ok() == Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi telah diarsipkan");
    }
    let stored_version = match validation_product_version_for_mutation(&existing) {
        Ok(version) => version,
        Err(_) => return validation_product_conflict(),
    };
    if stored_version != expected_version {
        return validation_product_conflict();
    }
    let before_snapshot = existing.clone();
    let status_only = is_status_only_payload(&payload);

    let next_validation_type = clean_text(payload.validation_type.clone(), 20)
        .or_else(|| {
            existing
                .get_document("validation")
                .ok()
                .and_then(|doc| doc.get_str("type").ok().map(ToString::to_string))
        })
        .unwrap_or_else(|| "operator".to_string());
    if !matches!(next_validation_type.as_str(), "nickname" | "operator") {
        return status_message(StatusCode::BAD_REQUEST, "Tipe validasi tidak valid");
    }

    let next_game = payload
        .game
        .clone()
        .map(|value| value.trim().chars().take(30).collect::<String>())
        .or_else(|| {
            existing
                .get_document("validation")
                .ok()
                .and_then(|doc| doc.get_str("game").ok().map(ToString::to_string))
        })
        .unwrap_or_default();
    if next_validation_type == "nickname"
        && !matches!(next_game.as_str(), "freefire" | "mobilelegends")
    {
        return status_message(StatusCode::BAD_REQUEST, "Game validasi tidak valid");
    }
    if next_validation_type == "operator" && !next_game.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "Game validasi tidak valid");
    }
    let next_game = if next_validation_type == "operator" {
        String::new()
    } else {
        next_game
    };

    let mut set_doc = Document::new();
    if let Some(name) = clean_text(payload.name, 120) {
        set_doc.insert("name", name);
    }
    if let Some(code) = clean_text(payload.code, 80) {
        let current_code = existing.get_str("code").unwrap_or_default();
        if code != current_code
            && products
                .find_one(doc! { "code": &code, "_id": { "$ne": product_id } })
                .projection(doc! { "_id": 1 })
                .await
                .ok()
                .flatten()
                .is_some()
        {
            return duplicate_code(&code);
        }
        set_doc.insert("code", code.clone());
        set_doc.insert("vendor.sku", code);
    }
    let next_category_id = if let Some(category_id) = clean_text(payload.category_id.clone(), 64) {
        match parse_object_id(&category_id) {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        existing
            .get_object_id("categoryId")
            .ok()
            .unwrap_or_default()
    };
    let next_operator_id = if let Some(operator_id) = clean_text(payload.operator_id.clone(), 64) {
        match parse_object_id(&operator_id) {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        existing
            .get_object_id("operatorId")
            .ok()
            .unwrap_or_default()
    };
    let next_product_type_id =
        if let Some(product_type_id) = clean_text(payload.product_type_id.clone(), 64) {
            match parse_object_id(&product_type_id) {
                Ok(value) => value,
                Err(response) => return response,
            }
        } else {
            existing
                .get_object_id("productTypeId")
                .ok()
                .unwrap_or_default()
        };
    if let Err(response) = ensure_catalog_references(
        &db,
        next_category_id,
        next_operator_id,
        next_product_type_id,
    )
    .await
    {
        return response;
    }
    if payload.category_id.is_some() {
        set_doc.insert("categoryId", next_category_id);
    }
    if payload.operator_id.is_some() {
        set_doc.insert("operatorId", next_operator_id);
    }
    if payload.product_type_id.is_some() {
        set_doc.insert("productTypeId", next_product_type_id);
    }
    if let Some(cost_price) = payload.cost_price {
        let cost_price = match normalize_money(cost_price, "Harga modal") {
            Ok(value) => value,
            Err(response) => return response,
        };
        set_doc.insert("costPrice", cost_price);
    }
    if let Some(status) = payload.status {
        set_doc.insert("status", status);
    }
    if let Some(price) = payload.price {
        let (basic, gold, platinum) = match normalize_price_tiers(price) {
            Ok(value) => value,
            Err(response) => return response,
        };
        set_doc.insert(
            "price",
            doc! {
                "basic": basic,
                "gold": gold,
                "platinum": platinum,
            },
        );
    }
    if payload.validation_type.is_some() {
        set_doc.insert("validation.type", next_validation_type);
    }
    if payload.game.is_some() {
        set_doc.insert("validation.game", next_game);
    }
    if let Some(target_label) = clean_text(payload.target_label, 60) {
        set_doc.insert("validation.targetLabel", target_label);
    }
    if payload.secondary_target_label.is_some() {
        set_doc.insert(
            "validation.secondaryTargetLabel",
            clean_text(payload.secondary_target_label, 60).unwrap_or_default(),
        );
    }
    if let Some(result_label) = clean_text(payload.result_label, 60) {
        set_doc.insert("validation.resultLabel", result_label);
    }
    set_doc.insert("validation.enabled", true);
    set_doc.insert("updatedAt", DateTime::now());

    let filter = active_version_filter(product_id, expected_version);
    let update = versioned_update(set_doc);
    let after_doc = match products
        .find_one_and_update(filter, update)
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => {
            return classify_versioned_mutation_miss(&products, product_id).await;
        }
        Err(_) => {
            return status_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Gagal memperbarui produk validasi",
            );
        }
    };
    let sku = after_doc.get_str("code").unwrap_or_default().to_string();
    let operation = resolve_audit_operation(false, status_only);
    let audit_doc = build_validation_product_audit_document(
        &actor,
        operation,
        product_id,
        &sku,
        Some(&before_snapshot),
        Some(&after_doc),
        &headers,
        DateTime::now(),
    );
    persist_validation_product_audit(&db, audit_doc, product_id, operation).await;

    match populated_validation_product(&db, product_id).await {
        Some(product) => Json(product).into_response(),
        None => status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan"),
    }
}

pub async fn archive(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(version_query): Query<ValidationProductVersionQuery>,
) -> Response {
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let expected_version = version_query.version;
    if validate_expected_version(expected_version).is_err() {
        return status_message(StatusCode::BAD_REQUEST, "Versi produk tidak valid");
    }
    let product_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => return status_message(StatusCode::BAD_REQUEST, "ID produk tidak valid"),
    };
    let Some(client) = &state.mongo_client else {
        return status_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "Layanan database belum tersedia",
        );
    };
    let db = client.database(&state.mongo_db);
    let products = db.collection::<Document>("products");
    let existing = products
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten();
    let Some(existing) = existing else {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    };
    if existing.get_bool("validation.enabled").ok() != Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    }
    if existing.get_bool("validation.archived").ok() == Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi telah diarsipkan");
    }
    let stored_version = match validation_product_version_for_mutation(&existing) {
        Ok(version) => version,
        Err(_) => return validation_product_conflict(),
    };
    if stored_version != expected_version {
        return validation_product_conflict();
    }
    let before_snapshot = existing.clone();
    let mut set_doc = Document::new();
    set_doc.insert("status", false);
    set_doc.insert("validation.archived", true);
    set_doc.insert("updatedAt", DateTime::now());
    let filter = active_version_filter(product_id, expected_version);
    let update = versioned_update(set_doc);
    let after_doc = match products
        .find_one_and_update(filter, update)
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => {
            return classify_versioned_mutation_miss(&products, product_id).await;
        }
        Err(_) => {
            return status_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Gagal mengarsipkan produk validasi",
            );
        }
    };
    let sku = after_doc.get_str("code").unwrap_or_default().to_string();
    let operation = ValidationProductAuditOperation::Archive;
    let audit_doc = build_validation_product_audit_document(
        &actor,
        operation,
        product_id,
        &sku,
        Some(&before_snapshot),
        Some(&after_doc),
        &headers,
        DateTime::now(),
    );
    persist_validation_product_audit(&db, audit_doc, product_id, operation).await;
    Json(serde_json::json!({
        "message": "Produk validasi berhasil diarsipkan"
    }))
    .into_response()
}

async fn insert_validation_product_with_allocated_id(
    db: &mongodb::Database,
    products: &mongodb::Collection<Document>,
    code: &str,
    name: &str,
    category_oid: ObjectId,
    operator_oid: ObjectId,
    product_type_oid: ObjectId,
    cost_price: i64,
    basic: i64,
    gold: i64,
    platinum: i64,
    status: bool,
    validation_type: &str,
    game: &str,
    target_label: &str,
    secondary_target_label: &str,
    result_label: &str,
    now: DateTime,
) -> Result<Option<ObjectId>, Response> {
    for attempt in 0..MAX_PRODUCT_ID_INSERT_ATTEMPTS {
        let product_id = match allocate_product_id(db).await {
            Ok(value) => value,
            Err(_) => {
                return Err(status_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Gagal membuat nomor produk validasi",
                ));
            }
        };
        let document = doc! {
            "productId": product_id,
            "code": code,
            "name": name,
            "categoryId": category_oid,
            "operatorId": operator_oid,
            "productTypeId": product_type_oid,
            "category": "Validation",
            "brand": "Validation",
            "paymentType": "prabayar",
            "costPrice": cost_price,
            "price": { "basic": basic, "gold": gold, "platinum": platinum },
            "rewardPoints": 0,
            "icon": "",
            "vendor": { "name": "Validation", "sku": code },
            "status": status,
            "validation": {
                "enabled": true,
                "type": validation_type,
                "game": game,
                "targetLabel": target_label,
                "secondaryTargetLabel": secondary_target_label,
                "resultLabel": result_label,
            },
            "sortOrder": 0,
            "createdAt": now,
            "updatedAt": now,
            "__v": 0,
        };
        match products.insert_one(document).await {
            Ok(result) => return Ok(result.inserted_id.as_object_id()),
            Err(error) => {
                if is_duplicate_key(&error) {
                    if let Some(response) = validation_insert_duplicate_error(&error, attempt, code)
                    {
                        return Err(response);
                    }
                    continue;
                }
                return Err(status_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Gagal menyimpan produk validasi",
                ));
            }
        }
    }
    Err(status_message(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Gagal menyimpan produk validasi",
    ))
}

async fn populated_validation_product(
    db: &mongodb::Database,
    id: ObjectId,
) -> Option<serde_json::Value> {
    let pipeline = vec![
        doc! { "$match": { "_id": id } },
        lookup_stage("categories", "categoryId", "categoryData"),
        unwind_stage("$categoryData"),
        lookup_stage("operators", "operatorId", "operatorData"),
        unwind_stage("$operatorData"),
        lookup_stage("producttypes", "productTypeId", "productTypeData"),
        unwind_stage("$productTypeData"),
    ];
    db.collection::<Document>("products")
        .aggregate(pipeline)
        .await
        .ok()?
        .try_collect::<Vec<_>>()
        .await
        .ok()?
        .into_iter()
        .next()
        .map(validation_product_json)
}

fn is_status_only_payload(payload: &ValidationProductPayload) -> bool {
    payload.status.is_some()
        && payload.name.is_none()
        && payload.code.is_none()
        && payload.category_id.is_none()
        && payload.operator_id.is_none()
        && payload.product_type_id.is_none()
        && payload.cost_price.is_none()
        && payload.price.is_none()
        && payload.validation_type.is_none()
        && payload.game.is_none()
        && payload.target_label.is_none()
        && payload.secondary_target_label.is_none()
        && payload.result_label.is_none()
}

async fn classify_versioned_mutation_miss(
    products: &mongodb::Collection<Document>,
    product_id: ObjectId,
) -> Response {
    let current = products
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten();
    let Some(current) = current else {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    };
    if current.get_bool("validation.enabled").ok() != Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi tidak ditemukan");
    }
    if current.get_bool("validation.archived").ok() == Some(true) {
        return status_message(StatusCode::NOT_FOUND, "Produk validasi telah diarsipkan");
    }
    validation_product_conflict()
}

#[cfg(test)]
mod response_tests {
    use super::*;
    use axum::body::to_bytes;
    use mongodb::bson::doc;

    #[test]
    fn validation_product_json_maps_version_field() {
        let document = doc! { "_id": ObjectId::new(), "code": "X", "__v": 4_i64 };
        let json = validation_product_json(document);
        assert_eq!(json.get("version").and_then(|v| v.as_i64()), Some(4));
        assert!(json.get("__v").is_none());
    }

    #[test]
    fn validation_product_json_maps_missing_legacy_version_to_zero() {
        let document = doc! { "_id": ObjectId::new(), "code": "LEGACY" };
        let json = validation_product_json(document);
        assert_eq!(json.get("version").and_then(|v| v.as_i64()), Some(0));
    }

    #[test]
    fn validation_product_json_omits_version_for_malformed_stored_value() {
        let document = doc! { "_id": ObjectId::new(), "code": "BAD", "__v": "x" };
        let json = validation_product_json(document);
        assert!(json.get("version").is_none());
    }

    #[tokio::test]
    async fn conflict_response_includes_code() {
        let response = validation_product_conflict();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            value.get("code").and_then(|v| v.as_str()),
            Some("VALIDATION_PRODUCT_CONFLICT")
        );
    }

    #[test]
    fn validate_expected_version_rejects_negative_and_unsafe() {
        assert!(validate_expected_version(-1).is_err());
        assert!(validate_expected_version(9_007_199_254_740_992).is_err());
        assert!(validate_expected_version(0).is_ok());
    }
}

async fn ensure_catalog_references(
    db: &mongodb::Database,
    category_id: ObjectId,
    operator_id: ObjectId,
    product_type_id: ObjectId,
) -> Result<(), Response> {
    let categories = db.collection::<Document>("categories");
    if categories
        .find_one(doc! { "_id": category_id })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Kategori tidak ditemukan",
        ));
    }

    let operators = db.collection::<Document>("operators");
    let operator = operators
        .find_one(doc! { "_id": operator_id })
        .projection(doc! { "_id": 1, "categoryId": 1 })
        .await
        .ok()
        .flatten();
    let Some(operator) = operator else {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Operator tidak ditemukan",
        ));
    };
    if !object_id_matches(operator.get("categoryId"), category_id) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Operator tidak sesuai dengan kategori yang dipilih",
        ));
    }

    let product_types = db.collection::<Document>("producttypes");
    let product_type = product_types
        .find_one(doc! { "_id": product_type_id })
        .projection(doc! { "_id": 1, "operatorId": 1 })
        .await
        .ok()
        .flatten();
    let Some(product_type) = product_type else {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Tipe produk tidak ditemukan",
        ));
    };
    if !object_id_matches(product_type.get("operatorId"), operator_id) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Tipe produk tidak sesuai dengan operator yang dipilih",
        ));
    }

    Ok(())
}

fn normalize_money(value: i64, label: &'static str) -> Result<i64, Response> {
    if value < 0 {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Nominal tidak boleh negatif",
        ));
    }
    if value > MAX_VALIDATION_PRICE {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            if label == "Harga modal" {
                "Harga modal melebihi batas maksimal Rp100.000.000"
            } else {
                "Harga jual melebihi batas maksimal Rp100.000.000"
            },
        ));
    }
    Ok(value)
}

fn normalize_price_tiers(
    price: ValidationProductPricePayload,
) -> Result<(i64, i64, i64), Response> {
    let basic = normalize_money(price.basic.unwrap_or(0), "Harga jual")?;
    let gold = normalize_money(price.gold.unwrap_or(basic), "Harga jual")?;
    let platinum = normalize_money(price.platinum.unwrap_or(gold), "Harga jual")?;
    if gold < basic || platinum < gold {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Urutan harga wajib Basic <= Gold <= Platinum",
        ));
    }
    Ok((basic, gold, platinum))
}

fn object_id_matches(value: Option<&Bson>, expected: ObjectId) -> bool {
    match value {
        Some(Bson::ObjectId(id)) => *id == expected,
        Some(Bson::String(id)) => ObjectId::parse_str(id)
            .map(|id| id == expected)
            .unwrap_or(false),
        _ => false,
    }
}

fn validation_insert_duplicate_error(
    error: &mongodb::error::Error,
    attempt: usize,
    code: &str,
) -> Option<Response> {
    match classify_duplicate_key_constraint(error) {
        DuplicateKeyConstraint::ProductId => {
            if should_retry_duplicate_product_id_attempt(attempt) {
                None
            } else {
                tracing::error!(%attempt, "productId duplicate after max validation insert attempts");
                Some(status_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Gagal menyimpan produk validasi",
                ))
            }
        }
        DuplicateKeyConstraint::Code => Some(duplicate_code(code)),
        DuplicateKeyConstraint::Unknown => {
            tracing::error!(error = %error, "unknown duplicate key on validation product insert");
            Some(status_message(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Gagal menyimpan produk validasi",
            ))
        }
    }
}

fn duplicate_code(code: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Kode produk sudah digunakan, gunakan kode unik lain",
            "field": "code",
            "duplicate": code,
        })),
    )
        .into_response()
}
