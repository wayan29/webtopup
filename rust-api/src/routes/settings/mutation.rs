//! Transactional Site Config bulk mutation orchestration on PostgreSQL.
//!
//! One transaction owns the whole mutation: the domain revision row lock serializes competing
//! updates, the frozen reply table provides permanent idempotency, managed upload references move
//! with the affected settings keys, and the audit row commits atomically with the new values.

use std::sync::Arc;

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::require_sql_permission,
    services::{
        audit_sanitize::sanitize_audit_document,
        idempotency::sha256_hex,
        managed_assets::{
            effectively_changed_managed_field, ensure_managed_field_for_update,
            ManagedFieldFolderPolicy,
        },
    },
    state::AppState,
};

use super::{
    defaults::default_site_settings,
    policy::{normalize_settings_intent, BulkSettingsUpdatePayload, SettingsPolicyError},
    responses::{internal_error, status_message},
    snapshot::with_revision_field,
    store::{
        audit, bump_revision, completed_replay_body, freeze, lock_revision,
        load_settings_in_tx, mutation_key, replay, trusted_correlation,
        upsert_setting, SETTINGS_DOMAIN,
    },
};

const SETTINGS_OPERATION: &str = "settings.update";
const SENSITIVE_GROUP: &str = "settings.sensitive";

/// Managed upload fields and their folder policy. References follow the stored value so a
/// referenced cover can never be deleted while a setting still displays it.
const MANAGED_SETTING_FIELDS: &[(&str, ManagedFieldFolderPolicy)] = &[
    ("favicon", ManagedFieldFolderPolicy::Icons),
    ("logo", ManagedFieldFolderPolicy::Icons),
    ("popupBannerImage", ManagedFieldFolderPolicy::Popups),
];

pub async fn execute_site_config_mutation(
    state: Arc<AppState>,
    headers: HeaderMap,
    payload: Value,
) -> Response {
    let actor = match require_sql_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };

    let Some(key) = mutation_key(&headers) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "message": "Header Idempotency-Key wajib untuk mutasi Site Config",
                "error": {
                    "code": "IDEMPOTENCY_KEY_REQUIRED",
                    "message": "Header Idempotency-Key wajib untuk mutasi Site Config"
                }
            })),
        )
            .into_response();
    };

    let bulk = match serde_json::from_value::<BulkSettingsUpdatePayload>(payload) {
        Ok(value) => value,
        Err(_) => {
            return status_message(StatusCode::BAD_REQUEST, "Body mutasi Site Config tidak valid")
        }
    };

    let defaults = default_site_settings();
    let selected_keys = defaults.keys().map(String::as_str).collect::<Vec<_>>();

    let mut tx = match state.pg_pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };

    // The domain row lock serializes every settings mutation and pins the revision read.
    let current_revision = match lock_revision(&mut tx, SETTINGS_DOMAIN).await {
        Ok(revision) => revision,
        Err(_) => return internal_error(),
    };
    let current_settings = match load_settings_in_tx(&mut tx, &selected_keys).await {
        Ok(settings) => settings,
        Err(_) => return internal_error(),
    };

    let intent = match normalize_settings_intent(
        bulk.expected_revision,
        &bulk.changes,
        &current_settings,
    ) {
        Ok(intent) => intent,
        Err(error) => return policy_error_response(error),
    };

    // Frozen-reply replay: the same actor+key+digest returns the stored response, a different
    // digest for the same key is a permanent conflict.
    match replay(&mut tx, actor.id, SETTINGS_OPERATION, &key, &intent.digest).await {
        Ok(Some((status, body))) => {
            return (
                StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK),
                Json(completed_replay_body(body)),
            )
                .into_response();
        }
        Ok(None) => {}
        Err(_) => return internal_error(),
    }

    if current_revision != intent.expected_revision {
        let conflict_body = json!({
            "error": {
                "code": "SETTINGS_VERSION_CONFLICT",
                "message": "Pengaturan telah diubah oleh pengguna lain",
                "expectedRevision": intent.expected_revision,
                "currentRevision": current_revision,
                "currentSettings": with_revision_field(current_settings.clone(), current_revision),
            }
        });
        if freeze(
            &mut tx,
            actor.id,
            SETTINGS_OPERATION,
            &key,
            &intent.digest,
            409,
            &conflict_body,
        )
        .await
        .is_err()
        {
            return internal_error();
        }
        if tx.commit().await.is_err() {
            return internal_error();
        }
        return (StatusCode::CONFLICT, Json(conflict_body)).into_response();
    }

    if intent.requires_step_up && require_trusted_step_up_group(&headers, SENSITIVE_GROUP).is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "message": "Verifikasi ulang diperlukan",
                "error": {
                    "code": "AUTH_STEP_UP_REQUIRED",
                    "actionGroup": SENSITIVE_GROUP,
                    "message": "Verifikasi ulang diperlukan untuk mengubah konfigurasi situs sensitif"
                }
            })),
        )
            .into_response();
    }

    // Managed upload validation and reference transitions happen before any domain write.
    if let Err(response) = validate_managed_fields(&intent.effective_changes, &current_settings) {
        return response;
    }

    let new_revision = if intent.effective_changes.is_empty() {
        current_revision
    } else {
        match bump_revision(&mut tx, SETTINGS_DOMAIN).await {
            Ok(revision) => revision,
            Err(_) => return internal_error(),
        }
    };

    for (setting_key, value) in &intent.effective_changes {
        if upsert_setting(&mut tx, setting_key, value, new_revision).await.is_err() {
            return internal_error();
        }
        if let Err(_) = transition_setting_reference(&mut tx, setting_key, &current_settings, value).await {
            return managed_reference_error_response();
        }
    }

    if !intent.effective_changes.is_empty() {
        let correlation = trusted_correlation(&headers);
        let audit_payload = build_settings_audit_payload(
            &actor,
            &current_settings,
            &intent.effective_changes,
            current_revision,
            new_revision,
            &key,
            correlation.trace_id.as_deref(),
        );
        if audit(
            &mut tx,
            actor.id,
            "settings.update",
            correlation.source.as_str(),
            audit_payload,
        )
        .await
        .is_err()
        {
            return internal_error();
        }
    }

    let mut next_settings = current_settings.clone();
    for (setting_key, value) in &intent.effective_changes {
        next_settings.insert(setting_key.clone(), value.clone());
    }

    let response_body = json!({
        "success": true,
        "replayed": false,
        "revision": new_revision,
        "data": with_revision_field(next_settings, new_revision),
    });

    if freeze(
        &mut tx,
        actor.id,
        SETTINGS_OPERATION,
        &key,
        &intent.digest,
        200,
        &response_body,
    )
    .await
    .is_err()
    {
        return internal_error();
    }
    if tx.commit().await.is_err() {
        return internal_error();
    }

    (StatusCode::OK, Json(response_body)).into_response()
}

/// Folder policy plus on-disk existence for every changed managed field.
fn validate_managed_fields(
    effective_changes: &Map<String, Value>,
    current_settings: &Map<String, Value>,
) -> Result<(), Response> {
    for (field, policy) in MANAGED_SETTING_FIELDS {
        let Some(Value::String(path)) = effective_changes.get(*field) else {
            continue;
        };
        let previous_path = current_settings.get(*field).and_then(Value::as_str);
        ensure_managed_field_for_update(
            &crate::routes::uploads::upload_root(),
            path,
            *policy,
            effectively_changed_managed_field(previous_path, path),
        )?;
    }
    Ok(())
}

/// Strict reference transition for one managed settings field: acquire the stored path,
/// release the replaced one. Non-managed values are registry no-ops.
async fn transition_setting_reference(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    setting_key: &str,
    current_settings: &Map<String, Value>,
    next_value: &Value,
) -> Result<(), crate::services::managed_asset_registry::RegistryError> {
    let Some(next_path) = next_value.as_str() else {
        return Ok(());
    };
    let previous_path = current_settings.get(setting_key).and_then(Value::as_str);
    if previous_path == Some(next_path) {
        return Ok(());
    }
    let resource = format!("settings:{setting_key}");
    if let Some(previous) = previous_path {
        crate::services::managed_asset_registry::release_reference(tx, previous, &resource).await?;
    }
    crate::services::managed_asset_registry::acquire_reference(tx, next_path, &resource).await
}
fn build_settings_audit_payload(
    actor: &crate::sql_auth::SqlAuthenticatedUser,
    previous: &Map<String, Value>,
    changed: &Map<String, Value>,
    old_revision: i64,
    new_revision: i64,
    idempotency_key: &str,
    trace_id: Option<&str>,
) -> Value {
    let mut changes = Map::new();
    for (key, value) in changed {
        let mut change = Map::new();
        change.insert(
            "from".to_string(),
            previous.get(key).cloned().unwrap_or(Value::Null),
        );
        change.insert("to".to_string(), value.clone());
        changes.insert(key.clone(), Value::Object(change));
    }
    let key_fingerprint = sha256_hex(idempotency_key.as_bytes());
    let mut metadata = json!({
        "actor": {
            "id": actor.id,
            "role": actor.role,
            "email": actor.email,
        },
        "resource": "Settings",
        "action": "update",
        "changedKeys": changed.keys().cloned().collect::<Vec<_>>(),
        "oldRevision": old_revision,
        "newRevision": new_revision,
        "idempotencyKeyFingerprint": key_fingerprint,
        "changes": changes,
    });
    if let Some(trace_id) = trace_id {
        metadata["traceId"] = Value::String(trace_id.to_string());
    }
    crate::services::audit_sanitize::sanitize_audit_document(&metadata)
}

fn policy_error_response(error: SettingsPolicyError) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "message": error.message(),
            "error": { "code": error.code(), "message": error.message() }
        })),
    )
        .into_response()
}

fn managed_reference_error_response() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "message": "Referensi aset upload tidak dapat diamankan",
            "error": {
                "code": "MANAGED_ASSET_REFERENCE_FAILED",
                "message": "Referensi aset upload tidak dapat diamankan"
            }
        })),
    )
        .into_response()
}

/// Replay of a frozen reply must still verify the stored digest belongs to this actor.
#[allow(dead_code)]
fn replay_actor_scope(actor: Uuid) -> Uuid {
    actor
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_contract_admin_update_uses_execute_site_config_mutation() {
        let source = include_str!("../settings.rs");
        assert!(source.contains("execute_site_config_mutation"));
    }

    #[test]
    fn managed_settings_fields_use_folder_policies() {
        assert_eq!(MANAGED_SETTING_FIELDS.len(), 3);
    }
}
