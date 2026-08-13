//! Transaction-only Site Config bulk mutation orchestration.

use std::sync::Arc;

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use mongodb::options::UpdateModifications;
use mongodb::{ClientSession, Database};
use serde_json::{json, Map, Value};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, AuthenticatedProxyUser},
    services::{
        audit_sanitize::sanitize_audit_document,
        idempotency::{
            commit_mongo_transaction_with_unknown_retry, sha256_hex, TransactionCommitOutcome,
        },
    },
    state::AppState,
};

use super::{
    conversion::json_to_bson,
    defaults::default_site_settings,
    idempotency::{
        begin_claim, complete_claim_in_session, completed_replay_body, mark_commit_unknown,
        mark_transaction_started, normalize_site_config_idempotency_key, undo_pre_effect_claim,
        SiteConfigClaimBegin, SiteConfigClaimBinding, SITE_CONFIG_CLAIMS_COLLECTION,
    },
    policy::{normalize_settings_intent, BulkSettingsUpdatePayload, SettingsPolicyError},
    responses::{internal_error, status_message, unavailable},
    snapshot::{
        load_consistent_snapshot, with_revision_field, SITE_CONFIG_REVISION_KEY, SnapshotError,
    },
    store::load_settings,
};

pub async fn execute_site_config_mutation(
    state: Arc<AppState>,
    headers: HeaderMap,
    payload: Value,
) -> Response {
    let actor = match require_permission(&headers, &state, "manageSettings").await {
        Ok(actor) => actor,
        Err(response) => return response,
    };

    let raw_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let key = match normalize_site_config_idempotency_key(raw_key) {
        Ok(key) => key,
        Err(_) => {
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
                .into_response()
        }
    };

    if !state.mongo_transactions_enabled {
        return settings_transactions_unavailable();
    }
    let Some(client) = state.mongo_client.as_ref() else {
        return unavailable();
    };
    let db_name = state.mongo_db.clone();
    let db = client.database(&db_name);

    if let Err(response) = probe_site_config_transactions(client, &db_name).await {
        return response;
    }

    let bulk = match serde_json::from_value::<BulkSettingsUpdatePayload>(payload) {
        Ok(value) => value,
        Err(_) => {
            return status_message(StatusCode::BAD_REQUEST, "Body mutasi Site Config tidak valid")
        }
    };

    let defaults = default_site_settings();
    let selected_keys = defaults.keys().map(String::as_str).collect::<Vec<_>>();
    let snapshot = match load_consistent_snapshot(client, &db_name, &selected_keys).await {
        Ok(snapshot) => snapshot,
        Err(SnapshotError::Unstable) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "message": "Snapshot pengaturan tidak stabil",
                    "error": { "code": "SETTINGS_SNAPSHOT_UNSTABLE" }
                })),
            )
                .into_response()
        }
        Err(_) => return internal_error(),
    };

    let intent = match normalize_settings_intent(
        bulk.expected_revision,
        &bulk.changes,
        &snapshot.settings,
    ) {
        Ok(intent) => intent,
        Err(error) => return policy_error_response(error),
    };

    let revision_matches = snapshot.revision == intent.expected_revision;
    if revision_matches && intent.requires_step_up {
        if require_trusted_step_up_group(&headers, "settings.sensitive").is_err() {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "message": "Verifikasi ulang diperlukan",
                    "error": {
                        "code": "AUTH_STEP_UP_REQUIRED",
                        "actionGroup": "settings.sensitive",
                        "message": "Verifikasi ulang diperlukan untuk mengubah konfigurasi situs sensitif"
                    }
                })),
            )
                .into_response();
        }
    }

    let binding = SiteConfigClaimBinding {
        key: key.clone(),
        operator_id: actor.id,
        expected_revision: intent.expected_revision,
        payload_digest: intent.digest.clone(),
    };

    let begin = match begin_claim(&db, &binding).await {
        Ok(begin) => begin,
        Err(_) => return internal_error(),
    };

    match begin {
        SiteConfigClaimBegin::Completed {
            status,
            body,
            result_revision: _,
        } => {
            return (
                StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                Json(body),
            )
                .into_response()
        }
        SiteConfigClaimBegin::Conflict => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "message": "Idempotency-Key bentrok dengan permintaan berbeda",
                    "error": {
                        "code": "IDEMPOTENCY_CONFLICT",
                        "message": "Idempotency-Key bentrok dengan permintaan berbeda"
                    }
                })),
            )
                .into_response()
        }
        SiteConfigClaimBegin::InProgress => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses",
                    "error": {
                        "code": "IDEMPOTENCY_IN_PROGRESS",
                        "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses"
                    }
                })),
            )
                .into_response()
        }
        SiteConfigClaimBegin::CommitUnknown => return settings_commit_unknown(),
        SiteConfigClaimBegin::Started {
            claim_id,
            claim_token,
            undo,
        } => {
            if !mark_transaction_started(&db, claim_id, &claim_token, &binding)
                .await
                .unwrap_or(false)
            {
                return settings_commit_unknown();
            }

            let mut session = match client.start_session().await {
                Ok(session) => session,
                Err(_) => {
                    if undo_pre_effect_claim(&db, &undo).await.is_ok() {
                        return settings_transactions_unavailable();
                    }
                    return settings_commit_unknown();
                }
            };
            if session.start_transaction().await.is_err() {
                let _ = session.abort_transaction().await;
                if undo_pre_effect_claim(&db, &undo).await.is_ok() {
                    return settings_transactions_unavailable();
                }
                return settings_commit_unknown();
            }

            let mut effects_attempted = false;
            let outcome = run_mutation_transaction(
                &db,
                &mut session,
                &actor,
                &headers,
                &binding,
                claim_id,
                &claim_token,
                &intent.normalized_changes,
                &mut effects_attempted,
            )
            .await;

            match outcome {
                Ok(response) => response,
                Err(MutationTxnError::DefinitePreEffect) if !effects_attempted => {
                    let _ = session.abort_transaction().await;
                    if undo_pre_effect_claim(&db, &undo).await.is_ok() {
                        settings_transactions_unavailable()
                    } else {
                        let _ = mark_commit_unknown(&db, claim_id, &claim_token, &binding).await;
                        settings_commit_unknown()
                    }
                }
                Err(MutationTxnError::CommitUnknown) => {
                    let _ = mark_commit_unknown(&db, claim_id, &claim_token, &binding).await;
                    // Attempt majority read of completed claim.
                    if let Ok(Some(doc)) = db
                        .collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
                        .find_one(doc! {
                            "_id": claim_id,
                            "status": "completed",
                            "claimToken": &claim_token,
                        })
                        .await
                    {
                        if let Ok(raw) = doc.get_str("responseBodyJson") {
                            if let Ok(body) = serde_json::from_str::<Value>(raw) {
                                let status = match doc.get("responseStatus") {
                                    Some(Bson::Int32(value)) => *value as u16,
                                    Some(Bson::Int64(value)) => *value as u16,
                                    _ => 200,
                                };
                                return (
                                    StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                                    Json(completed_replay_body(&body, true)),
                                )
                                    .into_response();
                            }
                        }
                    }
                    settings_commit_unknown()
                }
                Err(MutationTxnError::Response(response)) => response,
                Err(_) => {
                    let _ = session.abort_transaction().await;
                    internal_error()
                }
            }
        }
    }
}

enum MutationTxnError {
    DefinitePreEffect,
    CommitUnknown,
    Response(Response),
    Internal,
}

async fn run_mutation_transaction(
    db: &Database,
    session: &mut ClientSession,
    actor: &AuthenticatedProxyUser,
    headers: &HeaderMap,
    binding: &SiteConfigClaimBinding,
    claim_id: ObjectId,
    claim_token: &str,
    normalized_changes: &Map<String, Value>,
    effects_attempted: &mut bool,
) -> Result<Response, MutationTxnError> {
    let defaults = default_site_settings();
    let selected_keys = defaults.keys().map(String::as_str).collect::<Vec<_>>();

    // Authoritative in-transaction revision read.
    let current_revision = load_revision_in_session(db, session)
        .await
        .map_err(|_| MutationTxnError::DefinitePreEffect)?;
    let current_settings = load_settings(db.client(), db.name(), &selected_keys)
        .await
        .map_err(|_| MutationTxnError::Internal)?;

    if current_revision != binding.expected_revision {
        let conflict_body = json!({
            "error": {
                "code": "SETTINGS_VERSION_CONFLICT",
                "message": "Pengaturan telah diubah oleh pengguna lain",
                "expectedRevision": binding.expected_revision,
                "currentRevision": current_revision,
                "currentSettings": with_revision_field(current_settings.clone(), current_revision),
            }
        });
        *effects_attempted = true;
        complete_claim_in_session(
            db,
            session,
            claim_id,
            claim_token,
            binding,
            409,
            &conflict_body,
            Some(current_revision),
        )
        .await
        .map_err(|_| MutationTxnError::Internal)?;
        return match commit_mongo_transaction_with_unknown_retry(session).await {
            TransactionCommitOutcome::Committed => Ok((
                StatusCode::CONFLICT,
                Json(completed_replay_body(&conflict_body, false)),
            )
                .into_response()),
            TransactionCommitOutcome::Ambiguous => Err(MutationTxnError::CommitUnknown),
            TransactionCommitOutcome::FailedDefinitely => Err(MutationTxnError::Internal),
        };
    }

    let intent = normalize_settings_intent(
        binding.expected_revision,
        normalized_changes,
        &current_settings,
    )
    .map_err(|error| MutationTxnError::Response(policy_error_response(error)))?;

    if intent.requires_step_up && require_trusted_step_up_group(headers, "settings.sensitive").is_err()
    {
        // Should be rare after pre-check; treat as definitive pre-effect denial without claim completion.
        return Err(MutationTxnError::Response(
            (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": {
                        "code": "AUTH_STEP_UP_REQUIRED",
                        "actionGroup": "settings.sensitive"
                    }
                })),
            )
                .into_response(),
        ));
    }

    let mut next_settings = current_settings.clone();
    for (key, value) in &intent.effective_changes {
        next_settings.insert(key.clone(), value.clone());
    }

    let new_revision = if intent.effective_changes.is_empty() {
        current_revision
    } else {
        current_revision + 1
    };

    *effects_attempted = true;

    if !intent.effective_changes.is_empty() {
        for (key, value) in &intent.effective_changes {
            db.collection::<Document>("settings")
                .update_one(
                    doc! { "key": key },
                    UpdateModifications::Document(doc! {
                        "$set": { "key": key, "value": json_to_bson(value) }
                    }),
                )
                .upsert(true)
                .session(&mut *session)
                .await
                .map_err(|_| MutationTxnError::Internal)?;
        }
        // Revision metadata document.
        db.collection::<Document>("settings")
            .update_one(
                doc! { "key": SITE_CONFIG_REVISION_KEY },
                UpdateModifications::Document(doc! {
                    "$set": { "key": SITE_CONFIG_REVISION_KEY, "value": new_revision }
                }),
            )
            .upsert(true)
            .session(&mut *session)
            .await
            .map_err(|_| MutationTxnError::Internal)?;

        let audit_doc = build_settings_audit_document(
            actor,
            headers,
            &current_settings,
            &intent.effective_changes,
            current_revision,
            new_revision,
            &binding.key,
        );
        db.collection::<Document>("adminauditlogs")
            .insert_one(audit_doc)
            .session(&mut *session)
            .await
            .map_err(|_| MutationTxnError::Internal)?;
    }

    let response_body = json!({
        "success": true,
        "replayed": false,
        "revision": new_revision,
        "data": with_revision_field(next_settings, new_revision),
    });

    complete_claim_in_session(
        db,
        session,
        claim_id,
        claim_token,
        binding,
        200,
        &response_body,
        Some(new_revision),
    )
    .await
    .map_err(|_| MutationTxnError::Internal)?;

    match commit_mongo_transaction_with_unknown_retry(session).await {
        TransactionCommitOutcome::Committed => Ok((StatusCode::OK, Json(response_body)).into_response()),
        TransactionCommitOutcome::Ambiguous => Err(MutationTxnError::CommitUnknown),
        TransactionCommitOutcome::FailedDefinitely => Err(MutationTxnError::Internal),
    }
}

async fn load_revision_in_session(
    db: &Database,
    session: &mut ClientSession,
) -> Result<i64, SnapshotError> {
    let document = db
        .collection::<Document>("settings")
        .find_one(doc! { "key": SITE_CONFIG_REVISION_KEY })
        .session(&mut *session)
        .await
        .map_err(|_| SnapshotError::Unavailable)?;
    let Some(document) = document else {
        return Ok(0);
    };
    match document.get("value") {
        Some(Bson::Int32(value)) if *value >= 0 => Ok(i64::from(*value)),
        Some(Bson::Int64(value)) if *value >= 0 => Ok(*value),
        None => Ok(0),
        _ => Err(SnapshotError::Unavailable),
    }
}

fn build_settings_audit_document(
    actor: &AuthenticatedProxyUser,
    headers: &HeaderMap,
    previous: &Map<String, Value>,
    changed: &Map<String, Value>,
    old_revision: i64,
    new_revision: i64,
    idempotency_key: &str,
) -> Document {
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
    let mut metadata = doc! {
        "changedKeys": changed.keys().cloned().collect::<Vec<_>>(),
        "oldRevision": old_revision,
        "newRevision": new_revision,
        "idempotencyKeyFingerprint": key_fingerprint,
        "changes": json_to_bson(&Value::Object(changes)),
    };
    if let Some(trace_id) = headers
        .get("x-trace-id")
        .or_else(|| headers.get("x-webtopup-gateway-correlation-id"))
        .and_then(|value| value.to_str().ok())
    {
        metadata.insert("traceId", trace_id);
    }
    let sanitized = sanitize_audit_document(&metadata);
    let now = DateTime::now();
    doc! {
        "actor": actor.id,
        "actorName": &actor.email,
        "actorEmail": &actor.email,
        "actorRole": &actor.role,
        "action": "update",
        "resource": "Settings",
        "method": "PUT",
        "path": "/v2/settings/admin/update",
        "statusCode": 200_i32,
        "summary": format!(
            "Updated settings r{}→r{}: {}",
            old_revision,
            new_revision,
            changed.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
        "metadata": sanitized,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    }
}

pub async fn probe_site_config_transactions(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<(), Response> {
    let mut session = client
        .start_session()
        .await
        .map_err(|_| settings_transactions_unavailable())?;
    if let Err(error) = session.start_transaction().await {
        if is_transaction_capability_error(&error) {
            return Err(settings_transactions_unavailable());
        }
        return Err(internal_error());
    }
    // Read-only probe: load revision metadata inside the transaction, then abort.
    let result = client
        .database(db_name)
        .collection::<Document>("settings")
        .find_one(doc! { "key": SITE_CONFIG_REVISION_KEY })
        .session(&mut session)
        .await;
    let _ = session.abort_transaction().await;
    match result {
        Ok(_) => Ok(()),
        Err(error) if is_transaction_capability_error(&error) => {
            Err(settings_transactions_unavailable())
        }
        Err(_) => Err(internal_error()),
    }
}

fn is_transaction_capability_error(error: &mongodb::error::Error) -> bool {
    let text = format!("{error:?}").to_lowercase();
    text.contains("transaction numbers are only allowed")
        || text.contains("illegal operation")
        || text.contains("transactions are not supported")
        || text.contains("transaction is not supported")
}

fn settings_transactions_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "message": "Mutasi Site Config membutuhkan transaksi database",
            "error": {
                "code": "SETTINGS_TRANSACTIONS_UNAVAILABLE",
                "message": "Mutasi Site Config membutuhkan transaksi database"
            }
        })),
    )
        .into_response()
}

fn settings_commit_unknown() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "message": "Status penyimpanan belum dapat dipastikan. Periksa revisi terbaru dan log audit sebelum mencoba tindakan baru.",
            "error": {
                "code": "SETTINGS_COMMIT_UNKNOWN",
                "message": "Status penyimpanan belum dapat dipastikan"
            }
        })),
    )
        .into_response()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_contract_admin_update_uses_execute_site_config_mutation() {
        let source = include_str!("../settings.rs");
        assert!(source.contains("execute_site_config_mutation"));
        assert!(!source.contains("write_settings_audit_log(client, db_name, actor"));
    }
}
