//! Public and administrative slider reads. Mutations live in `slider_mutation`.

use std::sync::Arc;

use axum::{extract::State, http::{header, HeaderMap, Method, StatusCode, Uri}, response::{IntoResponse, Response}, Json};
use serde_json::json;

use crate::{security::require_sql_permission, state::AppState};

use super::{
    load_archived_snapshot, load_current_snapshot, load_public_snapshot, matches_slider_etag,
    slider_capability_marker, slider_etag, SliderSnapshotError, SLIDER_MUTATION_CONTRACT,
};

fn snapshot_error(error: SliderSnapshotError) -> Response {
    let status = match error { SliderSnapshotError::Unstable => StatusCode::SERVICE_UNAVAILABLE, SliderSnapshotError::Unavailable => StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(json!({"message": if error == SliderSnapshotError::Unstable { "Snapshot slider tidak stabil" } else { "Slider tidak tersedia" }, "error": {"code": error.code(), "message": "Slider tidak tersedia"}}))).into_response()
}

pub async fn sliders_admin_all(headers: HeaderMap, method: Method, uri: Uri, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageSettings").await { return response; }
    match load_current_snapshot(&state.pg_pool).await {
        Ok(mut snapshot) => { if slider_capability_marker(&headers, &state, &method, &uri) { snapshot.mutation_contract = Some(SLIDER_MUTATION_CONTRACT.to_string()); } Json(snapshot).into_response() }
        Err(error) => snapshot_error(error),
    }
}

pub async fn sliders_admin_archived(headers: HeaderMap, method: Method, uri: Uri, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "manageSettings").await { return response; }
    match load_archived_snapshot(&state.pg_pool).await {
        Ok(mut snapshot) => { if slider_capability_marker(&headers, &state, &method, &uri) { snapshot.mutation_contract = Some(SLIDER_MUTATION_CONTRACT.to_string()); } Json(snapshot).into_response() }
        Err(error) => snapshot_error(error),
    }
}

pub async fn sliders_public(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let (revision, sliders) = match load_public_snapshot(&state.pg_pool).await { Ok(value) => value, Err(error) => return snapshot_error(error) };
    let etag = slider_etag(revision);
    if matches_slider_etag(headers.get(header::IF_NONE_MATCH), revision) {
        return (StatusCode::NOT_MODIFIED, [(header::CACHE_CONTROL, "no-cache"), (header::ETAG, etag.as_str())]).into_response();
    }
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-cache"), (header::ETAG, etag.as_str())], Json(sliders)).into_response()
}

pub async fn sliders_update_sort_order() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"message": "Urutan slider lama tidak tersedia", "error": {"code": "SLIDER_LEGACY_REORDER_DISABLED", "message": "Urutan slider lama tidak tersedia"}}))).into_response()
}

pub async fn slider_delete() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"message": "Penghapusan slider langsung tidak tersedia; gunakan arsip", "error": {"code": "SLIDER_DELETE_DISABLED", "message": "Penghapusan slider langsung tidak tersedia; gunakan arsip"}}))).into_response()
}
