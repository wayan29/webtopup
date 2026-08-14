use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    options::{UpdateModifications, UpdateOneModel, WriteModel},
    Namespace,
};
use serde_json::Value;
use url::Url;

use crate::{
    security::require_permission,
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    date_string, document_to_json, i64_value, internal_error, load_archived_snapshot,
    load_current_snapshot, load_public_snapshot, matches_slider_etag, not_found, slider_capability_marker,
    slider_etag, status_message, text_value, text_value_or_current, unavailable, MessageResponse,
    NormalizedSliderPayload, SliderItem, SliderPayload, SliderResponse, SliderSortOrderPayload,
    SliderSnapshotError,
};

fn slider_snapshot_error_response(error: SliderSnapshotError) -> Response {
    match error {
        SliderSnapshotError::Unstable => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "message": "Snapshot slider tidak stabil",
                "error": {
                    "code": error.code(),
                    "message": "Snapshot slider tidak stabil"
                }
            })),
        )
            .into_response(),
        SliderSnapshotError::Unavailable => internal_error(),
    }
}

pub async fn sliders_admin_all(
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match load_current_snapshot(client, &state.mongo_db).await {
        Ok(mut snapshot) => {
            if slider_capability_marker(&headers, &state, &method, &uri) {
                snapshot.mutation_contract = Some(super::SLIDER_MUTATION_CONTRACT.to_string());
            }
            Json(snapshot).into_response()
        }
        Err(error) => slider_snapshot_error_response(error),
    }
}

pub async fn sliders_admin_archived(
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    match load_archived_snapshot(client, &state.mongo_db).await {
        Ok(mut snapshot) => {
            if slider_capability_marker(&headers, &state, &method, &uri) {
                snapshot.mutation_contract = Some(super::SLIDER_MUTATION_CONTRACT.to_string());
            }
            Json(snapshot).into_response()
        }
        Err(error) => slider_snapshot_error_response(error),
    }
}

pub async fn sliders_public(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let (revision, sliders) = match load_public_snapshot(client, &state.mongo_db).await {
        Ok(snapshot) => snapshot,
        Err(error) => return slider_snapshot_error_response(error),
    };
    let etag = slider_etag(revision);
    if matches_slider_etag(headers.get(header::IF_NONE_MATCH), revision) {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, "no-cache"),
                (header::ETAG, etag.as_str()),
            ],
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "no-cache"),
            (header::ETAG, etag.as_str()),
        ],
        Json(sliders),
    )
        .into_response()
}

pub async fn slider_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SliderPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let payload = match normalize_slider_payload(payload, None) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let sliders = db.collection::<Document>("sliders");
    let sort_order = match next_slider_sort_order(&sliders).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let now = DateTime::now();
    let document = doc! {
        "name": payload.name,
        "image": payload.image,
        "link": payload.link,
        "sortOrder": sort_order,
        "status": payload.status,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    let insert_result = match sliders.insert_one(document.clone()).await {
        Ok(result) => result,
        Err(_) => return internal_error(),
    };
    let Some(slider_id) = insert_result.inserted_id.as_object_id() else {
        return internal_error();
    };
    let mut slider = document;
    slider.insert("_id", slider_id);
    (
        axum::http::StatusCode::CREATED,
        Json(SliderResponse {
            message: "Slider created",
            slider: document_to_json(slider),
        }),
    )
        .into_response()
}

pub async fn slider_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<SliderPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let slider_id = match ObjectId::parse_str(id.trim()) {
        Ok(id) => id,
        Err(_) => {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "ID slider tidak valid")
        }
    };
    let sliders = client
        .database(&state.mongo_db)
        .collection::<Document>("sliders");
    let current = match sliders.find_one(doc! { "_id": slider_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let Some(current) = current else {
        return not_found("Slider not found");
    };
    let payload = match normalize_slider_payload(payload, Some(&current)) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if sliders
        .update_one(
            doc! { "_id": slider_id },
            doc! {
                "$set": {
                    "name": payload.name,
                    "image": payload.image,
                    "link": payload.link,
                    "status": payload.status,
                    "updatedAt": DateTime::now(),
                }
            },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    let slider = sliders
        .find_one(doc! { "_id": slider_id })
        .await
        .ok()
        .flatten();
    let Some(slider) = slider else {
        return not_found("Slider not found");
    };
    Json(SliderResponse {
        message: "Slider updated",
        slider: document_to_json(slider),
    })
    .into_response()
}

pub async fn slider_delete(
    _headers: axum::http::HeaderMap,
    _state: State<Arc<AppState>>,
    _id: Path<String>,
) -> Response {
    legacy_slider_method_not_allowed("SLIDER_HARD_DELETE_DISABLED", "Penghapusan permanen slider tidak tersedia")
}

pub fn legacy_slider_method_not_allowed(code: &'static str, message: &'static str) -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(serde_json::json!({"error":{"code":code,"message":message}}))).into_response()
}

#[allow(dead_code)]
async fn slider_delete_legacy_impl(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let slider_id = match ObjectId::parse_str(id.trim()) {
        Ok(id) => id,
        Err(_) => {
            return status_message(axum::http::StatusCode::BAD_REQUEST, "ID slider tidak valid")
        }
    };
    let db = client.database(&state.mongo_db);
    let sliders = db.collection::<Document>("sliders");
    let deleted = sliders
        .find_one_and_delete(doc! { "_id": slider_id })
        .await
        .ok()
        .flatten();
    if deleted.is_none() {
        return not_found("Slider not found");
    }
    if reindex_slider_sort_order(&db).await.is_err() {
        return internal_error();
    }
    Json(MessageResponse {
        message: "Slider deleted",
    })
    .into_response()
}

pub async fn sliders_update_sort_order(
    _headers: axum::http::HeaderMap,
    _state: State<Arc<AppState>>,
    _payload: Json<SliderSortOrderPayload>,
) -> Response {
    legacy_slider_method_not_allowed("SLIDER_LEGACY_REORDER_DISABLED", "Urutan slider lama tidak tersedia")
}

#[allow(dead_code)]
async fn sliders_update_sort_order_legacy_impl(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SliderSortOrderPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(orders) = payload.orders else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload urutan slider wajib berupa array dan tidak boleh kosong",
        );
    };
    if orders.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload urutan slider wajib berupa array dan tidak boleh kosong",
        );
    }
    let db = client.database(&state.mongo_db);
    let sliders = db.collection::<Document>("sliders");
    let all_sliders = match sliders
        .find(doc! {})
        .sort(doc! { "sortOrder": 1, "createdAt": 1 })
        .await
    {
        Ok(cursor) => match cursor.try_collect::<Vec<_>>().await {
            Ok(docs) => docs,
            Err(error) => {
                eprintln!("Failed to collect sliders for sort order: {error}");
                return internal_error();
            }
        },
        Err(error) => {
            eprintln!("Failed to query sliders for sort order: {error}");
            return internal_error();
        }
    };
    if orders.len() != all_sliders.len() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload urutan slider harus mencakup seluruh slider",
        );
    }
    let valid_ids = all_sliders
        .iter()
        .filter_map(|slider| slider.get_object_id("_id").ok().map(|id| id.to_hex()))
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    let mut seen_orders = HashSet::new();
    let mut normalized = Vec::new();
    for item in orders {
        let id = text_value(item.id).unwrap_or_default();
        let object_id = match ObjectId::parse_str(id.trim()) {
            Ok(id) => id,
            Err(_) => {
                return status_message(axum::http::StatusCode::BAD_REQUEST, "ID slider tidak valid")
            }
        };
        if !valid_ids.contains(id.trim()) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payload urutan slider mengandung ID yang tidak dikenal",
            );
        }
        let Some(sort_order) = i64_value(item.sort_order) else {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Sort order slider harus berupa bilangan bulat non-negatif",
            );
        };
        if sort_order < 0 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Sort order slider harus berupa bilangan bulat non-negatif",
            );
        }
        if !seen_ids.insert(id.trim().to_string()) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payload urutan slider mengandung ID duplikat",
            );
        }
        if !seen_orders.insert(sort_order) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payload urutan slider mengandung sort order duplikat",
            );
        }
        normalized.push((object_id, sort_order));
    }
    if seen_ids.len() != valid_ids.len() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payload urutan slider belum lengkap",
        );
    }
    normalized.sort_by_key(|(_, sort_order)| *sort_order);
    if bulk_update_slider_sort_order(client, &state.mongo_db, normalized)
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(MessageResponse {
        message: "Sort order updated",
    })
    .into_response()
}

fn slider_from_doc(document: Document) -> SliderItem {
    SliderItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&document, "name"),
        image: read_string(&document, "image"),
        link: read_string(&document, "link"),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

fn normalize_slider_payload(
    payload: SliderPayload,
    current: Option<&Document>,
) -> Result<NormalizedSliderPayload, Response> {
    let name = text_value_or_current(payload.name, current, "name", "");
    if name.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama slider wajib diisi",
        ));
    }
    let image = text_value_or_current(payload.image, current, "image", "");
    let previous_image = current.map(|document| read_string(document, "image"));
    let image_effectively_changed = crate::services::managed_assets::effectively_changed_managed_field(
        previous_image.as_deref(),
        &image,
    );
    if image.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Gambar slider wajib diisi",
        ));
    }
    if !is_safe_slider_image(&image) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Gambar slider harus berupa URL http/https atau path internal upload yang diawali \"/\"",
        ));
    }
    // Legacy slider mutation remains closed until Task 9 supplies its transactional writer.
    // Historical values may be retained on unrelated edits, but a new managed cover must never
    // be persisted without the session-aware slider transaction protocol.
    if image_effectively_changed
        && crate::services::managed_assets::parse_managed_upload_url(&image)
            .map(|(folder, _)| folder == "covers")
            .unwrap_or(false)
    {
        return Err(crate::services::managed_assets::managed_asset_registry_unavailable_response());
    }
    crate::services::managed_assets::ensure_managed_field_for_update(
        &crate::routes::uploads::upload_root(),
        &image,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Covers,
        image_effectively_changed,
    )?;
    let link_was_supplied = payload.link.is_some();
    let link = text_value_or_current(payload.link, current, "link", "");
    if link_was_supplied && !is_safe_slider_link(&link) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Link slider harus berupa URL http/https atau path internal yang diawali \"/\"",
        ));
    }
    let status = match payload.status {
        Some(Value::Bool(value)) => value,
        Some(_) => {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Status slider tidak valid",
            ));
        }
        None => current
            .and_then(|document| document.get_bool("status").ok())
            .unwrap_or(true),
    };
    Ok(NormalizedSliderPayload {
        name,
        image,
        link,
        status,
    })
}

async fn reindex_slider_sort_order(db: &mongodb::Database) -> Result<(), ()> {
    let sliders = match db
        .collection::<Document>("sliders")
        .find(doc! {})
        .sort(doc! { "sortOrder": 1, "createdAt": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.map_err(|error| {
            eprintln!("Failed to collect sliders for reindex: {error}");
        })?,
        Err(error) => {
            eprintln!("Failed to query sliders for reindex: {error}");
            return Err(());
        }
    };
    let normalized = sliders
        .into_iter()
        .filter_map(|slider| slider.get_object_id("_id").ok())
        .enumerate()
        .map(|(index, id)| (id, index as i64))
        .collect::<Vec<_>>();
    bulk_update_slider_sort_order(db.client(), db.name(), normalized).await
}

async fn next_slider_sort_order(
    sliders: &mongodb::Collection<Document>,
) -> Result<i64, mongodb::error::Error> {
    let latest = sliders
        .find_one(doc! {})
        .sort(doc! { "sortOrder": -1, "createdAt": -1 })
        .await?;
    Ok(latest
        .map(|doc| read_i64(&doc, "sortOrder") + 1)
        .unwrap_or(0))
}

async fn bulk_update_slider_sort_order(
    client: &mongodb::Client,
    db_name: &str,
    ordered_ids: Vec<(ObjectId, i64)>,
) -> Result<(), ()> {
    if ordered_ids.is_empty() {
        return Ok(());
    }
    let namespace = Namespace::new(db_name, "sliders");
    let now = DateTime::now();
    let models = ordered_ids
        .into_iter()
        .map(|(id, sort_order)| {
            WriteModel::UpdateOne(
                UpdateOneModel::builder()
                    .namespace(namespace.clone())
                    .filter(doc! { "_id": id })
                    .update(UpdateModifications::Document(doc! {
                        "$set": { "sortOrder": sort_order, "updatedAt": now }
                    }))
                    .build(),
            )
        })
        .collect::<Vec<_>>();
    client
        .bulk_write(models)
        .ordered(true)
        .await
        .map_err(|error| {
            eprintln!("Failed to bulk update slider sort order: {error}");
        })?;
    Ok(())
}

fn has_control_or_whitespace_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '\r' | '\n' | '\t') || character.is_control())
}

fn is_safe_internal_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.starts_with("/\\")
        && !has_control_or_whitespace_control(value)
}

fn is_safe_external_url(value: &str) -> bool {
    if has_control_or_whitespace_control(value) {
        return false;
    }
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

fn is_safe_slider_link(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    if value.starts_with('/') {
        return is_safe_internal_path(value);
    }
    is_safe_external_url(value)
}

fn is_safe_slider_image(value: &str) -> bool {
    if value.starts_with('/') {
        return is_safe_internal_path(value);
    }
    is_safe_external_url(value)
}
