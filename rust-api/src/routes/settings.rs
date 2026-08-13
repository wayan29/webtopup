mod conversion;
mod defaults;
mod idempotency;
mod mutation;
mod policy;
mod responses;
mod snapshot;
mod store;
mod types;
mod validation;

pub use idempotency::ensure_site_config_foundation_indexes;
pub use mutation::execute_site_config_mutation;

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

use crate::{
    security::require_permission,
    state::AppState,
};

use defaults::default_site_settings;
use responses::{internal_error, status_message, unavailable};
use snapshot::{
    load_consistent_snapshot, matches_site_settings_etag, site_settings_etag, with_revision_field,
    SITE_CONFIG_REVISION_KEY, SnapshotError,
};

pub async fn admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let defaults = default_site_settings();
    let selected_keys = defaults.keys().map(String::as_str).collect::<Vec<_>>();
    let snapshot = match load_consistent_snapshot(client, &state.mongo_db, &selected_keys).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            eprintln!("Failed to load admin site settings snapshot: {error:?}");
            return snapshot_error_response(error);
        }
    };
    Json(Value::Object(with_revision_field(
        snapshot.settings,
        snapshot.revision,
    )))
    .into_response()
}

pub async fn public_settings(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let snapshot = match load_consistent_snapshot(
        client,
        &state.mongo_db,
        defaults::public_site_setting_keys(),
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            eprintln!("Failed to load public site settings snapshot: {error:?}");
            return snapshot_error_response(error);
        }
    };
    let etag = site_settings_etag(snapshot.revision);
    if matches_site_settings_etag(headers.get(header::IF_NONE_MATCH), snapshot.revision) {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, "no-cache".to_string()),
                (header::ETAG, etag),
            ],
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "no-cache".to_string()),
            (header::ETAG, etag),
        ],
        Json(Value::Object(with_revision_field(
            snapshot.settings,
            snapshot.revision,
        ))),
    )
        .into_response()
}

pub async fn admin_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageSettings").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    if key == SITE_CONFIG_REVISION_KEY {
        return status_message(StatusCode::NOT_FOUND, "Setting not found");
    }
    let defaults = default_site_settings();
    if !defaults.contains_key(&key) {
        return status_message(StatusCode::NOT_FOUND, "Setting not found");
    }
    let snapshot =
        match load_consistent_snapshot(client, &state.mongo_db, &[key.as_str()]).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                eprintln!("Failed to load site setting {key}: {error:?}");
                return snapshot_error_response(error);
            }
        };
    let value = snapshot
        .settings
        .get(&key)
        .cloned()
        .unwrap_or_else(|| defaults.get(&key).cloned().unwrap_or(Value::Null));
    Json(json!({ "key": key, "value": value, "revision": snapshot.revision })).into_response()
}

fn snapshot_error_response(error: SnapshotError) -> Response {
    match error {
        SnapshotError::Unstable => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "message": "Snapshot pengaturan tidak stabil",
                "error": {
                    "code": error.code(),
                    "message": "Snapshot pengaturan tidak stabil"
                }
            })),
        )
            .into_response(),
        SnapshotError::Unavailable => internal_error(),
    }
}

pub async fn admin_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    execute_site_config_mutation(state, headers, payload).await
}
