mod conversion;
mod defaults;
mod responses;
mod snapshot;
mod store;
mod types;
mod validation;

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, Bson, DateTime, Document};
use serde_json::{json, Map, Value};

use crate::{
    security::{require_permission, AuthenticatedProxyUser},
    state::AppState,
};

use defaults::default_site_settings;
use responses::{internal_error, status_message, unavailable};
use snapshot::{
    load_consistent_snapshot, matches_site_settings_etag, site_settings_etag, with_revision_field,
    SITE_CONFIG_REVISION_KEY, SnapshotError,
};
use store::upsert_settings;
use types::SetSettingPayload;
use validation::validate_update_payload;

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
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(payload) = payload.as_object() else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Invalid request body");
    };
    update_settings(
        client,
        &state.mongo_db,
        payload,
        "Settings updated successfully",
        None,
        Some(actor),
    )
    .await
}

pub async fn admin_set(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(payload): Json<SetSettingPayload>,
) -> Response {
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    if !default_site_settings().contains_key(&key) {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Setting not found");
    }
    let payload = Map::from_iter([(key.clone(), payload.value)]);
    update_settings(
        client,
        &state.mongo_db,
        &payload,
        "Setting updated",
        Some(key),
        Some(actor),
    )
    .await
}

async fn update_settings(
    client: &mongodb::Client,
    db_name: &str,
    payload: &Map<String, Value>,
    message: &'static str,
    single_key: Option<String>,
    actor: Option<AuthenticatedProxyUser>,
) -> Response {
    let (next_settings, changed_values, previous_settings) =
        match validate_update_payload(client, db_name, payload).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    if upsert_settings(client, db_name, &changed_values)
        .await
        .is_err()
    {
        return internal_error();
    }
    if let Some(actor) = actor.as_ref() {
        write_settings_audit_log(client, db_name, actor, &previous_settings, &changed_values).await;
    }
    match single_key {
        Some(key) => Json(json!({
            "success": true,
            "message": message,
            "key": key,
            "value": next_settings.get(&key).cloned().unwrap_or(Value::Null),
        }))
        .into_response(),
        None => Json(json!({
            "success": true,
            "message": message,
            "data": next_settings,
        }))
        .into_response(),
    }
}

async fn write_settings_audit_log(
    client: &mongodb::Client,
    db_name: &str,
    actor: &AuthenticatedProxyUser,
    previous_settings: &Map<String, Value>,
    changed_values: &Map<String, Value>,
) {
    if changed_values.is_empty() {
        return;
    }
    let changes = changed_values
        .iter()
        .map(|(key, value)| {
            let mut change = Map::new();
            change.insert(
                "from".to_string(),
                previous_settings.get(key).cloned().unwrap_or(Value::Null),
            );
            change.insert("to".to_string(), value.clone());
            (key.clone(), Value::Object(change))
        })
        .collect::<Map<_, _>>();
    let now = DateTime::now();
    let document = doc! {
        "actor": actor.id,
        "actorName": &actor.email,
        "actorEmail": &actor.email,
        "actorRole": &actor.role,
        "action": "update",
        "resource": "Settings",
        "method": "PUT",
        "path": "/v2/settings/admin/update",
        "statusCode": 200_i32,
        "summary": format!("Updated settings: {}", changed_values.keys().cloned().collect::<Vec<_>>().join(", ")),
        "metadata": {
            "changedKeys": changed_values.keys().cloned().collect::<Vec<_>>(),
            "changes": json_to_bson(Value::Object(changes)),
        },
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if let Err(error) = client
        .database(db_name)
        .collection::<Document>("adminauditlogs")
        .insert_one(document)
        .await
    {
        eprintln!("Failed to write settings audit log: {error}");
    }
}

fn json_to_bson(value: Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(value) => Bson::Boolean(value),
        Value::Number(value) => value
            .as_i64()
            .map(Bson::Int64)
            .or_else(|| value.as_f64().map(Bson::Double))
            .unwrap_or(Bson::Null),
        Value::String(value) => Bson::String(value),
        Value::Array(values) => Bson::Array(values.into_iter().map(json_to_bson).collect()),
        Value::Object(map) => Bson::Document(
            map.into_iter()
                .map(|(key, value)| (key, json_to_bson(value)))
                .collect(),
        ),
    }
}
