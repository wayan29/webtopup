//! Transaction-only create/update orchestration for revisioned sliders.
//!
//! Archive, restore, reorder, and legacy route closure intentionally remain outside this module.

use std::{path::Path, sync::Arc};

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{ReadConcern, UpdateOptions, WriteConcern},
    ClientSession, Database,
};
use serde_json::{json, Value};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, AuthenticatedProxyUser},
    services::{
        audit_sanitize::sanitize_audit_document,
        idempotency::{sha256_hex, commit_mongo_transaction_with_unknown_retry, TransactionCommitOutcome},
        local_fault::consume_slider_response_loss_fault,
        managed_asset_registry::{acquire_slider_reference, release_slider_reference, MANAGED_ASSETS_COLLECTION, RegistryError},
    },
    state::AppState,
};

use super::{
    complete_slider_claim_in_session, begin_slider_claim, canonical_slider_claim_digest,
    effective_requires_step_up,
    mark_slider_commit_unknown_conditionally, mark_slider_step_up_required,
    mark_slider_transaction_started,
    normalize_create, normalize_update, normalize_slider_claim_binding, preallocate_slider_recovery_ids,
    read_slider_transaction_started_at, recover_slider_commit, store_recovery_identifiers,
    verify_slider_claim_fence_in_session,
    SliderAction, SliderClaimBegin, SliderClaimBinding, SliderClaimError, SliderCommitRecovery,
    SliderCreateRequest, SliderSnapshotItem, SliderUpdateRequest, SliderAdminSnapshot,
    SLIDER_MUTATION_CONTRACT, SLIDER_METADATA_COLLECTION, MAX_CURRENT_SLIDERS, MAX_PUBLIC_SLIDERS,
};

const DOMAIN_AUDITS_COLLECTION: &str = "slideraudits";
const SENSITIVE_GROUP: &str = "settings.sensitive";

/// Public transaction entry point consumed by the create and update route adapters.
pub async fn slider_create(
    headers: HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    execute_slider_mutation(state, headers, SliderAction::Create, None, payload).await
}

pub async fn slider_update(
    headers: HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let target = match ObjectId::parse_str(id.trim()) {
        Ok(value) => Some(value),
        Err(_) => return mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"),
    };
    execute_slider_mutation(state, headers, SliderAction::Update, target, payload).await
}

pub async fn execute_slider_mutation(
    state: Arc<AppState>,
    headers: HeaderMap,
    action: SliderAction,
    target: Option<ObjectId>,
    payload: Value,
) -> Response {
    let operator = match require_permission(&headers, &state, "manageSettings").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let key = match headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or(SliderClaimError::InvalidKey)
        .and_then(super::normalize_slider_idempotency_key)
    {
        Ok(key) => key,
        Err(_) => return mutation_error(StatusCode::BAD_REQUEST, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key tidak valid"),
    };
    let readiness = state.slider_mutation_readiness;
    if !readiness.transaction_capable {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_TRANSACTIONS_UNAVAILABLE", "Transaksi slider tidak tersedia");
    }
    if !readiness.exact_indexes_ready {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_INDEX_UNAVAILABLE", "Index slider tidak tersedia");
    }
    if !readiness.registry_ready || !readiness.readiness_clean || !readiness.mutation_ready {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "MANAGED_ASSET_REGISTRY_UNAVAILABLE", "Managed asset registry tidak tersedia");
    }
    let Some(client) = state.mongo_client.as_ref() else {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_TRANSACTIONS_UNAVAILABLE", "Transaksi slider tidak tersedia");
    };
    if !matches!(action, SliderAction::Create | SliderAction::Update) {
        return mutation_error(StatusCode::METHOD_NOT_ALLOWED, "SLIDER_ACTION_NOT_IMPLEMENTED", "Aksi slider belum tersedia");
    }
    let db = client.database(&state.mongo_db);
    if probe_slider_transaction_capability(&db).await.is_err() {
        return transaction_unavailable();
    }

    // Normalize against an initial read solely to construct the claim binding. The authoritative
    // read-only transaction below repeats this work and is the source of truth.
    let initial = match load_initial_state(&db, action, target).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let input = match normalize_input(action, payload.clone(), initial.as_ref(), target) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let canonical_payload = match serde_json::to_value(&input) {
        Ok(value) => value,
        Err(_) => return internal_mutation_error(),
    };
    let binding = SliderClaimBinding {
        key,
        contract_version: SLIDER_MUTATION_CONTRACT.to_string(),
        operator_id: operator.id,
        action: action.as_str().to_string(),
        target_id: target,
        expected_revision: input.expected_revision,
        payload_digest: SliderClaimBinding {
            key: String::new(),
            contract_version: SLIDER_MUTATION_CONTRACT.to_string(),
            operator_id: operator.id,
            action: action.as_str().to_string(),
            target_id: target,
            expected_revision: input.expected_revision,
            payload_digest: String::new(),
        }.canonical_digest(&canonical_payload),
    };
    let binding = match normalize_slider_claim_binding(&binding) {
        Ok(binding) => binding,
        Err(_) => return mutation_error(StatusCode::BAD_REQUEST, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key tidak valid"),
    };

    let claim = match begin_slider_claim(&db, &binding).await {
        Ok(value) => value,
        Err(error) => return claim_error_response(error),
    };
    let (claim_id, claim_token, lease_generation) = match claim {
        SliderClaimBegin::Completed { status, body, .. } => {
            return (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body)).into_response();
        }
        SliderClaimBegin::Conflict => return mutation_error(StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah digunakan untuk payload lain"),
        SliderClaimBegin::InProgress => return mutation_error(StatusCode::CONFLICT, "IDEMPOTENCY_IN_PROGRESS", "Mutasi slider masih diproses"),
        SliderClaimBegin::CommitUnknown => return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"),
        SliderClaimBegin::Started { claim_id, claim_token, lease_generation } => (claim_id, claim_token, lease_generation),
    };

    let preflight = match authoritative_preflight(&db, action, target, &input, initial.as_ref()).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if preflight.requires_step_up {
        if let Err(response) = require_trusted_step_up_group(&headers, SENSITIVE_GROUP) {
            // Keep the permanent claim, but explicitly return it to an immediate pre-transaction
            // retry state. No transaction fence, commitUnknown, or frozen result is written.
            match mark_slider_step_up_required(
                &db,
                claim_id,
                &claim_token,
                &binding,
                lease_generation,
            )
            .await
            {
                Ok(true) => return response,
                Ok(false) => {
                    return mutation_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "SLIDER_CLAIM_FENCE_LOST",
                        "Klaim mutasi slider tidak dapat diamankan",
                    )
                }
                Err(error) => return claim_error_response(error),
            }
        }
    }

    let recovery_ids = preallocate_slider_recovery_ids(action, target, input.expected_revision);
    if !store_recovery_identifiers(&db, claim_id, &claim_token, &binding, lease_generation, &recovery_ids).await.unwrap_or(false) {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_CLAIM_FENCE_LOST", "Klaim mutasi slider tidak dapat diamankan");
    }
    if !mark_slider_transaction_started(&db, claim_id, &claim_token, &binding, lease_generation, &recovery_ids).await.unwrap_or(false) {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_CLAIM_FENCE_LOST", "Klaim mutasi slider tidak dapat diamankan");
    }
    let started_at = match read_slider_transaction_started_at(
        &db,
        claim_id,
        &claim_token,
        &binding,
        lease_generation,
    )
    .await
    {
        Ok(Some(value)) => value,
        Ok(None) | Err(_) => {
            return recover_or_commit_unknown_from_claim(
                &db,
                claim_id,
                &claim_token,
                &binding,
                lease_generation,
                &recovery_ids,
            )
            .await
        }
    };

    let mut session = match client.start_session().await {
        Ok(session) => session,
        Err(_) => return recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await,
    };
    if session.start_transaction().await.is_err() {
        return recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await;
    }
    let result = write_transaction(
        &mut session,
        &db,
        &operator,
        &headers,
        action,
        target,
        &input,
        &binding,
        claim_id,
        &claim_token,
        lease_generation,
        started_at,
        &recovery_ids,
        preflight,
    ).await;
    let (status, body) = match result {
        Ok(value) => value,
        Err(_) => {
            // Once transactionStartedAt is durable, even an acknowledged abort is not a
            // pre-transaction retry signal. Keep the claim permanently conservative.
            let _ = session.abort_transaction().await;
            return recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await;
        }
    };
    match commit_mongo_transaction_with_unknown_retry(&mut session).await {
        TransactionCommitOutcome::Committed => {
            if consume_slider_response_loss_fault().await {
                return recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await;
            }
            (status, Json(body)).into_response()
        }
        TransactionCommitOutcome::Ambiguous | TransactionCommitOutcome::FailedDefinitely => {
            recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await
        }
    }
}

#[derive(Clone)]
struct MutationInput {
    expected_revision: i64,
    name: String,
    image: String,
    link: String,
    status: bool,
}

impl serde::Serialize for MutationInput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        serde_json::json!({"expectedRevision": self.expected_revision, "name": self.name, "image": self.image, "link": self.link, "status": self.status}).serialize(serializer)
    }
}

#[derive(Clone)]
struct Preflight {
    current_revision: i64,
    requires_step_up: bool,
}

async fn load_initial_state(db: &Database, action: SliderAction, target: Option<ObjectId>) -> Result<Option<Document>, Response> {
    if action == SliderAction::Create { return Ok(None); }
    let Some(target) = target else { return Err(mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")); };
    db.collection::<Document>("sliders").find_one(doc! {"_id": target, "lifecycle": {"$ne": "archived"}}).await.map_err(|_| internal_mutation_error())?.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")).map(Some)
}

fn normalize_input(action: SliderAction, payload: Value, current: Option<&Document>, target: Option<ObjectId>) -> Result<MutationInput, Response> {
    match action {
        SliderAction::Create => {
            let request: SliderCreateRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            let normalized = normalize_create(request).map_err(policy_error_response)?;
            Ok(MutationInput { expected_revision: normalized.expected_revision, name: normalized.name, image: normalized.image, link: normalized.link, status: normalized.status })
        }
        SliderAction::Update => {
            let request: SliderUpdateRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            let current = current.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?;
            let snapshot = snapshot_from_document(current, target.ok_or_else(|| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"))?)?;
            let normalized = normalize_update(request, &snapshot).map_err(policy_error_response)?;
            Ok(MutationInput { expected_revision: normalized.expected_revision, name: normalized.name, image: normalized.image, link: normalized.link, status: normalized.status })
        }
        _ => Err(mutation_error(StatusCode::METHOD_NOT_ALLOWED, "SLIDER_ACTION_NOT_IMPLEMENTED", "Aksi slider belum tersedia")),
    }
}

/// Verify that this Mongo deployment can execute a real read-only transaction before any
/// request-derived read, normalization, claim, or mutation work begins.  The transaction is
/// intentionally aborted after session-bound reads; it never creates a collection or writes data.
async fn probe_slider_transaction_capability(db: &Database) -> Result<(), ()> {
    let mut session = db.client().start_session().await.map_err(|_| ())?;
    session
        .start_transaction()
        .read_concern(ReadConcern::snapshot())
        .write_concern(WriteConcern::majority())
        .await
        .map_err(|_| ())?;
    db.collection::<Document>(SLIDER_METADATA_COLLECTION)
        .find_one(doc! { "_id": "global" })
        .session(&mut session)
        .await
        .map_err(|_| ())?;
    db.collection::<Document>("sliders")
        .find_one(doc! { "_id": { "$exists": true } })
        .session(&mut session)
        .await
        .map_err(|_| ())?;
    session.abort_transaction().await.map_err(|_| ())
}

async fn authoritative_preflight(db: &Database, action: SliderAction, target: Option<ObjectId>, input: &MutationInput, _initial: Option<&Document>) -> Result<Preflight, Response> {
    let mut session = db.client().start_session().await.map_err(|_| transaction_unavailable())?;
    session.start_transaction().await.map_err(|_| transaction_unavailable())?;
    let revision = load_revision_in_session(db, &mut session).await.map_err(|_| transaction_unavailable())?;
    let current = if action == SliderAction::Update {
        let target = target.ok_or_else(|| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"))?;
        db.collection::<Document>("sliders").find_one(doc! {"_id": target, "lifecycle": {"$ne": "archived"}}).session(&mut session).await.map_err(|_| transaction_unavailable())?.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?
    } else { Document::new() };
    let before = if action == SliderAction::Update { Some(snapshot_from_document(&current, target.unwrap())?) } else { None };
    let after = snapshot_after(action, target, input, before.as_ref());
    let requires_step_up = effective_requires_step_up(action, before.as_ref(), after.as_ref(), &[], &[]);
    let current_count = db.collection::<Document>("sliders").count_documents(doc! {"lifecycle": {"$ne": "archived"}}).session(&mut session).await.map_err(|_| transaction_unavailable())? as i64;
    let active_count = db.collection::<Document>("sliders").count_documents(doc! {"lifecycle": {"$ne": "archived"}, "status": true}).session(&mut session).await.map_err(|_| transaction_unavailable())? as i64;
    let limit_error = if action == SliderAction::Create && current_count >= MAX_CURRENT_SLIDERS { Some(mutation_error(StatusCode::CONFLICT, "SLIDER_TOTAL_LIMIT_REACHED", "Batas total slider tercapai")) }
        else if (action == SliderAction::Create && input.status && active_count >= MAX_PUBLIC_SLIDERS) || (action == SliderAction::Update && before.as_ref().is_some_and(|value| !value.status) && input.status && active_count >= MAX_PUBLIC_SLIDERS) { Some(mutation_error(StatusCode::CONFLICT, "SLIDER_ACTIVE_LIMIT_REACHED", "Batas slider aktif tercapai")) } else { None };
    let _ = session.abort_transaction().await;
    if revision != input.expected_revision {
        return Ok(Preflight { current_revision: revision, requires_step_up: false });
    }
    if let Some(response) = limit_error { return Err(response); }
    Ok(Preflight { current_revision: revision, requires_step_up })
}

async fn write_transaction(session: &mut ClientSession, db: &Database, operator: &AuthenticatedProxyUser, headers: &HeaderMap, action: SliderAction, target: Option<ObjectId>, input: &MutationInput, binding: &SliderClaimBinding, claim_id: ObjectId, claim_token: &str, generation: u64, started_at: DateTime, ids: &super::SliderRecoveryIdentifiers, preflight: Preflight) -> Result<(StatusCode, Value), Response> {
    // This is the first operation in the write transaction. No domain, reference, metadata,
    // audit, or claim-result write is allowed before the exact same-session fence succeeds.
    verify_slider_claim_fence_in_session(db, session, claim_id, claim_token, binding, generation, started_at, ids)
        .await
        .map_err(claim_error_response)?;
    let revision = load_revision_in_session(db, session).await.map_err(|_| transaction_unavailable())?;
    if revision != input.expected_revision {
        let documents = load_current_documents_in_session(db, session).await.map_err(|_| transaction_unavailable())?;
        let snapshot = super::slider_snapshot::admin_snapshot_from_documents(revision, &documents);
        let body = version_conflict_body(input.expected_revision, revision, snapshot)?;
        complete_slider_claim_in_session(db, session, claim_id, claim_token, binding, generation, started_at, 409, &body, revision, ids.audit_event_id).await.map_err(claim_error_response)?;
        return Ok((StatusCode::CONFLICT, body));
    }
    let current = if action == SliderAction::Update {
        let id = target.unwrap();
        Some(db.collection::<Document>("sliders").find_one(doc! {"_id": id, "lifecycle": {"$ne": "archived"}}).session(&mut *session).await.map_err(|_| transaction_unavailable())?.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?)
    } else { None };
    let before = current.as_ref().map(|value| snapshot_from_document(value, target.unwrap()).unwrap());
    let after = snapshot_after(action, target, input, before.as_ref());
    let sensitivity = effective_requires_step_up(action, before.as_ref(), after.as_ref(), &[], &[]);
    // Recompute and verify the authoritative proof in this same transaction immediately before
    // any asset, domain, revision, or audit write. Preflight is only an early response hint.
    if sensitivity {
        require_trusted_step_up_group(headers, SENSITIVE_GROUP)
            .map_err(|_| mutation_error(StatusCode::FORBIDDEN, "AUTH_STEP_UP_REQUIRED", "Verifikasi ulang diperlukan untuk aksi sensitif"))?;
    }
    if action == SliderAction::Create && input.status { let count = db.collection::<Document>("sliders").count_documents(doc! {"lifecycle":{"$ne":"archived"},"status":true}).session(&mut *session).await.map_err(|_| transaction_unavailable())?; if count >= MAX_PUBLIC_SLIDERS as u64 { return Err(mutation_error(StatusCode::CONFLICT, "SLIDER_ACTIVE_LIMIT_REACHED", "Batas slider aktif tercapai")); } }
    if action == SliderAction::Create { let count = db.collection::<Document>("sliders").count_documents(doc! {"lifecycle":{"$ne":"archived"}}).session(&mut *session).await.map_err(|_| transaction_unavailable())?; if count >= MAX_CURRENT_SLIDERS as u64 { return Err(mutation_error(StatusCode::CONFLICT, "SLIDER_TOTAL_LIMIT_REACHED", "Batas total slider tercapai")); } }
    let slider_id = ids.candidate_slider_id.or(target).ok_or_else(internal_mutation_error)?;
    let mut managed_references_acquired = Vec::new();
    let mut managed_references_released = Vec::new();
    if !is_existing_image(before.as_ref().map(|v| v.image.as_str()), &input.image) {
        ensure_cover_file(&input.image)?;
        let outcome = acquire_slider_reference(session, db, &input.image, slider_id)
            .await
            .map_err(registry_error_response)?;
        managed_references_acquired.push(doc! {
            "assetId": outcome.asset_id,
            "referenceId": outcome.reference_id,
            "path": &input.image,
        });
    }
    if let Some(before) = before.as_ref() {
        if before.image != input.image && is_registered_asset(db, session, &before.image, false).await? {
            let outcome = release_slider_reference(session, db, &before.image, slider_id)
                .await
                .map_err(registry_error_response)?;
            managed_references_released.push(doc! {
                "assetId": outcome.asset_id,
                "referenceId": outcome.reference_id,
                "path": &before.image,
            });
        }
    }
    let now = DateTime::now();
    let slider = if action == SliderAction::Create {
        let order = db.collection::<Document>("sliders").count_documents(doc! {"lifecycle":{"$ne":"archived"}}).session(&mut *session).await.map_err(|_| transaction_unavailable())? as i64;
        let document = doc! {"_id":slider_id,"name":&input.name,"image":&input.image,"link":&input.link,"sortOrder":order,"status":input.status,"lifecycle":"active","createdAt":now,"updatedAt":now,"archivedAt":Bson::Null,"archivedBy":Bson::Null,"__v":0_i64};
        db.collection::<Document>("sliders").insert_one(document.clone()).session(&mut *session).await.map_err(|_| transaction_unavailable())?;
        document
    } else {
        let id = target.unwrap();
        db.collection::<Document>("sliders").update_one(doc! {"_id":id,"lifecycle":{"$ne":"archived"}}, doc! {"$set":{"name":&input.name,"image":&input.image,"link":&input.link,"status":input.status,"lifecycle":"active","updatedAt":now},"$inc":{"__v":1_i64}}).session(&mut *session).await.map_err(|_| transaction_unavailable())?;
        db.collection::<Document>("sliders").find_one(doc! {"_id":id}).session(&mut *session).await.map_err(|_| transaction_unavailable())?.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?
    };
    let next_revision = input.expected_revision.checked_add(1).ok_or_else(internal_mutation_error)?;
    db.collection::<Document>(SLIDER_METADATA_COLLECTION).update_one(doc! {"_id":"global"}, doc! {"$set":{"revision":next_revision,"updatedAt":now,"updatedBy":operator.id},"$setOnInsert":{"_id":"global"}},).with_options(UpdateOptions::builder().upsert(true).build()).session(&mut *session).await.map_err(|_| transaction_unavailable())?;
    let after_snapshot = snapshot_from_document(&slider, slider_id).map_err(|_| internal_mutation_error())?;
    let audit = build_slider_domain_audit_document(
        operator,
        headers,
        action,
        slider_id,
        claim_id,
        ids.audit_event_id,
        input.expected_revision,
        next_revision,
        before.as_ref(),
        &after_snapshot,
        sensitivity,
        &managed_references_acquired,
        &managed_references_released,
        &binding.key,
    );
    db.collection::<Document>(DOMAIN_AUDITS_COLLECTION).insert_one(audit).session(&mut *session).await.map_err(|_| transaction_unavailable())?;
    let body = json!({"message":if action==SliderAction::Create {"Slider created"} else {"Slider updated"},"slider":super::document_to_json(slider),"revision":next_revision,"replayed":false});
    complete_slider_claim_in_session(db, session, claim_id, claim_token, binding, generation, started_at, if action==SliderAction::Create {201} else {200}, &body, next_revision, ids.audit_event_id).await.map_err(claim_error_response)?;
    Ok((if action==SliderAction::Create {StatusCode::CREATED} else {StatusCode::OK}, body))
}

fn version_conflict_body(expected_revision: i64, current_revision: i64, snapshot: SliderAdminSnapshot) -> Result<Value, Response> {
    Ok(json!({
        "error": {
            "code": "SLIDER_VERSION_CONFLICT",
            "message": "Daftar slider telah berubah",
            "expectedRevision": expected_revision,
            "currentRevision": current_revision,
            "currentSnapshot": serde_json::to_value(snapshot).map_err(|_| internal_mutation_error())?,
        },
        "replayed": false,
    }))
}

fn build_slider_domain_audit_document(
    actor: &AuthenticatedProxyUser,
    headers: &HeaderMap,
    action: SliderAction,
    target_id: ObjectId,
    claim_id: ObjectId,
    audit_event_id: ObjectId,
    revision_before: i64,
    revision_after: i64,
    before: Option<&SliderSnapshotItem>,
    after: &SliderSnapshotItem,
    public_impact: bool,
    acquired: &[Document],
    released: &[Document],
    idempotency_key: &str,
) -> Document {
    let correlation = actor.resolve_correlation(headers);
    build_slider_domain_audit_shape(
        actor.id,
        &actor.role,
        correlation.source.as_str(),
        correlation.trace_id.as_deref(),
        action,
        target_id,
        claim_id,
        audit_event_id,
        revision_before,
        revision_after,
        before,
        after,
        public_impact,
        acquired,
        released,
        idempotency_key,
    )
}

/// Construct the complete sanitized domain-audit shape. This pure seam deliberately accepts only
/// normalized snapshots and trusted actor/correlation values; callers never pass raw secrets.
fn build_slider_domain_audit_shape(
    actor_id: ObjectId,
    actor_role: &str,
    correlation_source: &str,
    trace_id: Option<&str>,
    action: SliderAction,
    target_id: ObjectId,
    claim_id: ObjectId,
    audit_event_id: ObjectId,
    revision_before: i64,
    revision_after: i64,
    before: Option<&SliderSnapshotItem>,
    after: &SliderSnapshotItem,
    public_impact: bool,
    acquired: &[Document],
    released: &[Document],
    idempotency_key: &str,
) -> Document {
    let before_doc = before.map(snapshot_document).unwrap_or_default();
    let after_doc = snapshot_document(after);
    let field_names = ["name", "image", "link", "sortOrder", "status", "lifecycle"];
    let changed_fields = field_names
        .iter()
        .filter(|field| before_doc.get(**field) != after_doc.get(**field))
        .map(|field| Bson::String((*field).to_string()))
        .collect::<Vec<_>>();
    let old_order = before.map(|value| value.sort_order);
    let new_order = Some(after.sort_order);
    let ordering_digest = sha256_hex(
        format!("{}:{}", old_order.unwrap_or(-1), new_order.unwrap_or(-1)).as_bytes(),
    );
    let mut correlation = doc! { "source": correlation_source };
    if let Some(trace_id) = trace_id {
        correlation.insert("trace", trace_id);
    }
    let mut audit = doc! {
        "_id": audit_event_id,
        "claimId": claim_id,
        "action": action.as_str(),
        "targetId": target_id,
        "actor": { "id": actor_id, "role": actor_role },
        "actorId": actor_id,
        "actorRole": actor_role,
        "revision": { "before": revision_before, "after": revision_after },
        "revisionBefore": revision_before,
        "revisionAfter": revision_after,
        "normalized": { "before": before_doc.clone(), "after": after_doc.clone() },
        "before": before_doc,
        "after": after_doc,
        "changedFields": Bson::Array(changed_fields),
        "lifecycle": { "before": before.map(|value| value.lifecycle.as_str()).unwrap_or("none"), "after": after.lifecycle.as_str() },
        "status": { "before": before.map(|value| value.status), "after": after.status },
        "publicImpact": public_impact,
        "ordering": { "old": old_order, "new": new_order, "digest": ordering_digest },
        "managedReferences": { "acquired": Bson::Array(acquired.iter().cloned().map(Bson::Document).collect()), "released": Bson::Array(released.iter().cloned().map(Bson::Document).collect()) },
        "idempotencyKeyHash": sha256_hex(idempotency_key.as_bytes()),
        "auditEventId": audit_event_id,
        "claimIdentifier": claim_id,
        "correlation": correlation,
        "result": { "replayed": false, "commitUnknown": false, "evidence": "transaction_committed" },
    };
    audit.insert("auditSource", "rust_domain");
    sanitize_audit_document(&audit)
}

fn snapshot_after(action: SliderAction, target: Option<ObjectId>, input: &MutationInput, before: Option<&SliderSnapshotItem>) -> Option<SliderSnapshotItem> {
    Some(SliderSnapshotItem { id: target.unwrap_or_else(ObjectId::new), name: input.name.clone(), image: input.image.clone(), link: input.link.clone(), sort_order: before.map(|v|v.sort_order).unwrap_or(0), status: input.status, lifecycle: "active".to_string() }).filter(|_| matches!(action, SliderAction::Create | SliderAction::Update))
}

fn snapshot_from_document(document: &Document, id: ObjectId) -> Result<SliderSnapshotItem, Response> {
    Ok(SliderSnapshotItem { id, name: document.get_str("name").unwrap_or_default().to_string(), image: document.get_str("image").unwrap_or_default().to_string(), link: document.get_str("link").unwrap_or_default().to_string(), sort_order: integer(document,"sortOrder").unwrap_or(0), status: document.get_bool("status").unwrap_or(true), lifecycle: document.get_str("lifecycle").unwrap_or("active").to_string() })
}

fn snapshot_document(value: &SliderSnapshotItem) -> Document { doc! {"id":value.id,"name":&value.name,"image":&value.image,"link":&value.link,"sortOrder":value.sort_order,"status":value.status,"lifecycle":&value.lifecycle} }
fn integer(document: &Document, key: &str) -> Option<i64> { match document.get(key) { Some(Bson::Int32(v))=>Some(*v as i64),Some(Bson::Int64(v))=>Some(*v),Some(Bson::Double(v)) if v.is_finite()&&v.fract()==0.0=>Some(*v as i64),_=>None } }
async fn load_revision_in_session(db: &Database, session: &mut ClientSession) -> Result<i64, mongodb::error::Error> { Ok(db.collection::<Document>(SLIDER_METADATA_COLLECTION).find_one(doc!{"_id":"global"}).session(&mut *session).await?.and_then(|d|integer(&d,"revision")).unwrap_or(0)) }

async fn load_current_documents_in_session(db: &Database, session: &mut ClientSession) -> Result<Vec<Document>, mongodb::error::Error> {
    let mut cursor = db.collection::<Document>("sliders")
        .find(doc! { "lifecycle": { "$ne": "archived" } })
        .sort(doc! { "sortOrder": 1, "_id": 1 })
        .session(&mut *session)
        .await?;
    let mut documents = Vec::new();
    while cursor.advance(session).await? {
        documents.push(cursor.deserialize_current()?);
    }
    Ok(documents)
}

async fn recover_or_commit_unknown_from_claim(
    db: &Database,
    claim_id: ObjectId,
    token: &str,
    binding: &SliderClaimBinding,
    generation: u64,
    ids: &super::SliderRecoveryIdentifiers,
) -> Response {
    // Recovery is read-only and bounded. A missing/ambiguous start timestamp cannot prove that
    // the claim was pre-transaction, so this path must never return a retry/fence-loss response.
    for _ in 0..2 {
        match recover_slider_commit(db, claim_id, token, binding, generation, ids).await {
            Ok(SliderCommitRecovery::Completed { status, body, .. }) => {
                return (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body))
                    .into_response();
            }
            Ok(SliderCommitRecovery::CommitUnknown) | Err(_) => {}
        }
    }
    if let Ok(Some(started_at)) = read_slider_transaction_started_at(
        db, claim_id, token, binding, generation,
    )
    .await
    {
        // Conditional fencing prevents a stale recovery worker from changing a completed claim.
        let _ = mark_slider_commit_unknown_conditionally(
            db, claim_id, token, binding, generation, started_at,
        )
        .await;
    }
    mutation_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "SLIDER_COMMIT_UNKNOWN",
        "Status mutasi slider belum dapat dipastikan",
    )
}

async fn recover_or_commit_unknown(
    db: &Database,
    claim_id: ObjectId,
    token: &str,
    binding: &SliderClaimBinding,
    generation: u64,
    started_at: DateTime,
    ids: &super::SliderRecoveryIdentifiers,
) -> Response {
    if let Ok(SliderCommitRecovery::Completed { status, body, .. }) = recover_slider_commit(
        db, claim_id, token, binding, generation, ids,
    )
    .await
    {
        return (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body)).into_response();
    }
    commit_unknown_response(db, claim_id, token, binding, generation, started_at).await
}

fn is_existing_image(before: Option<&str>, image: &str) -> bool { before == Some(image) }
fn ensure_cover_file(image: &str) -> Result<(), Response> { let Some((folder,file))=crate::services::managed_asset_registry::canonical_managed_path(image).ok() else { return Err(registry_error_response(RegistryError::PathInvalid)); }; if folder!="covers" || !Path::new(&crate::routes::uploads::upload_root()).join(folder).join(file).is_file() { return Err(registry_error_response(RegistryError::Unavailable)); } Ok(()) }
async fn is_registered_asset(db:&Database, session:&mut ClientSession, path:&str, _unused:bool)->Result<bool,Response>{ Ok(db.collection::<Document>(MANAGED_ASSETS_COLLECTION).find_one(doc!{"canonicalPath":path,"folder":"covers"}).session(&mut *session).await.map_err(|_|registry_error_response(RegistryError::Storage))?.is_some()) }

async fn commit_unknown_response(db:&Database, claim_id:ObjectId, token:&str, binding:&SliderClaimBinding, generation:u64, started_at:DateTime)->Response { let _=mark_slider_commit_unknown_conditionally(db,claim_id,token,binding,generation,started_at).await; mutation_error(StatusCode::SERVICE_UNAVAILABLE,"SLIDER_COMMIT_UNKNOWN","Status mutasi slider belum dapat dipastikan") }
fn policy_error_response(error: super::SliderPolicyError)->Response { mutation_error(StatusCode::BAD_REQUEST,error.code(),error.message()) }
fn claim_error_response(error: SliderClaimError)->Response { let status=match error {SliderClaimError::InvalidKey=>StatusCode::BAD_REQUEST,SliderClaimError::Fenced|SliderClaimError::IndexesNotReady|SliderClaimError::Storage=>StatusCode::SERVICE_UNAVAILABLE,_=>StatusCode::INTERNAL_SERVER_ERROR}; mutation_error(status,error.code(),"Klaim mutasi slider tidak tersedia") }
fn registry_error_response(error: RegistryError)->Response { mutation_error(StatusCode::SERVICE_UNAVAILABLE,error.code(),"Managed asset registry tidak tersedia") }
fn transaction_unavailable()->Response { mutation_error(StatusCode::SERVICE_UNAVAILABLE,"SLIDER_TRANSACTIONS_UNAVAILABLE","Transaksi slider tidak tersedia") }
fn internal_mutation_error()->Response { mutation_error(StatusCode::INTERNAL_SERVER_ERROR,"SLIDER_MUTATION_FAILED","Mutasi slider gagal") }
fn mutation_error(status:StatusCode,code:&'static str,message:&'static str)->Response {(status,Json(json!({"error":{"code":code,"message":message},"replayed":false}))).into_response()}
pub(crate) fn mutation_error_code_for_test()->&'static str { "SLIDER_TRANSACTIONS_UNAVAILABLE" }
pub(crate) fn transaction_probe_failure_code_for_test()->&'static str { "SLIDER_TRANSACTIONS_UNAVAILABLE" }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slider_transaction_probe_is_before_initial_read_normalization_and_claim() {
        let source = include_str!("slider_mutation.rs");
        let probe = source
            .find("probe_slider_transaction_capability(&db)")
            .expect("mutation must probe Mongo transactions");
        let initial_read = source
            .find("load_initial_state(&db")
            .expect("mutation must retain the initial state seam");
        let normalization = source
            .find("normalize_input(action")
            .expect("mutation must normalize after probing");
        let claim = source
            .find("begin_slider_claim(&db")
            .expect("mutation must claim after probing");
        assert!(probe < initial_read);
        assert!(probe < normalization);
        assert!(probe < claim);
    }

    #[test]
    fn transaction_probe_failure_maps_to_exact_unavailable_error() {
        assert_eq!(transaction_probe_failure_code_for_test(), "SLIDER_TRANSACTIONS_UNAVAILABLE");
        assert_eq!(StatusCode::SERVICE_UNAVAILABLE.as_u16(), 503);
    }

    #[test]
    fn unresolved_start_timestamp_recovery_returns_commit_unknown_not_fence_lost() {
        let source = include_str!("slider_mutation.rs");
        let recovery = source
            .find("async fn recover_or_commit_unknown_from_claim")
            .expect("missing start timestamp must have bounded recovery");
        let recovery_tail = &source[recovery..];
        let end = recovery_tail
            .find("\n}\n\nasync fn recover_or_commit_unknown(")
            .expect("recovery helper boundary changed unexpectedly");
        let helper = &recovery_tail[..end];
        assert!(helper.contains("recover_slider_commit"));
        assert!(helper.contains("read_slider_transaction_started_at"));
        assert!(helper.contains("SLIDER_COMMIT_UNKNOWN"));
        assert!(!helper.contains("SLIDER_CLAIM_FENCE_LOST"));
    }

    #[test]
    fn missing_step_up_proof_checks_claim_transition_before_returning_forbidden() {
        let source = include_str!("slider_mutation.rs");
        let mark = source
            .find("mark_slider_step_up_required(")
            .expect("step-up claim transition must remain explicit");
        let response = source
            .find("return response;")
            .expect("normal missing-proof response must remain available");
        assert!(mark < response);
        let nearby = &source[mark..response];
        assert!(nearby.contains("match"));
        assert!(!nearby.contains("let _ = mark_slider_step_up_required"));
    }

    #[test]
    fn slider_mutation_create_policy_keeps_drafts_non_sensitive() {
        let input=MutationInput{expected_revision:14,name:"Promo".into(),image:"/uploads/covers/1710000000000-deadbeef.webp".into(),link:"/promo".into(),status:false};
        assert!(!effective_requires_step_up(SliderAction::Create,None,snapshot_after(SliderAction::Create,None,&input,None).as_ref(),&[],&[]));
    }
    #[test]
    fn slider_mutation_update_policy_requires_active_field_step_up_but_not_deactivate() {
        let before=SliderSnapshotItem{id:ObjectId::new(),name:"A".into(),image:"/uploads/covers/1710000000000-deadbeef.webp".into(),link:"/a".into(),sort_order:0,status:true,lifecycle:"active".into()};
        let mut input=MutationInput{expected_revision:1,name:"B".into(),image:before.image.clone(),link:before.link.clone(),status:true};
        assert!(effective_requires_step_up(SliderAction::Update,Some(&before),snapshot_after(SliderAction::Update,Some(before.id),&input,Some(&before)).as_ref(),&[],&[]));
        input.status=false; input.name=before.name.clone();
        assert!(!effective_requires_step_up(SliderAction::Update,Some(&before),snapshot_after(SliderAction::Update,Some(before.id),&input,Some(&before)).as_ref(),&[],&[]));
    }

    #[test]
    fn stale_revision_body_contains_latest_admin_snapshot() {
        let latest = super::super::slider_snapshot::admin_snapshot_from_documents(15, &[]);
        let body = version_conflict_body(14, 15, latest).unwrap();
        assert_eq!(body["error"]["code"], "SLIDER_VERSION_CONFLICT");
        assert_eq!(body["error"]["currentRevision"], 15);
        assert_eq!(body["error"]["currentSnapshot"]["revision"], 15);
        assert!(body["error"]["currentSnapshot"]["sliders"].is_array());
        assert!(body["error"]["currentSnapshot"]["limits"].is_object());
    }

    #[test]
    fn slider_domain_audit_shape_contains_required_sanitized_evidence() {
        let id = ObjectId::new();
        let before = SliderSnapshotItem { id, name: "Old".into(), image: "/uploads/covers/1710000000000-deadbeef.webp".into(), link: "/old".into(), sort_order: 2, status: false, lifecycle: "active".into() };
        let after = SliderSnapshotItem { id, name: "New".into(), image: before.image.clone(), link: "/new".into(), sort_order: 3, status: true, lifecycle: "active".into() };
        let audit = build_slider_domain_audit_shape(ObjectId::new(), "admin", "gateway_header", Some("4bf92f3577b34da6a3ce929d0e0e4736"), SliderAction::Update, id, ObjectId::new(), ObjectId::new(), 4, 5, Some(&before), &after, true, &[doc! { "assetId": ObjectId::new() }], &[doc! { "assetId": ObjectId::new() }], "secret-key-value");
        for key in ["action", "targetId", "actorId", "actorRole", "revisionBefore", "revisionAfter", "normalized", "changedFields", "lifecycle", "status", "publicImpact", "ordering", "managedReferences", "idempotencyKeyHash", "auditEventId", "claimIdentifier", "correlation", "result"] {
            assert!(audit.contains_key(key), "missing audit key {key}");
        }
        assert!(!audit.to_string().contains("secret-key-value"));
        assert_eq!(audit.get_str("auditSource"), Ok("rust_domain"));
        assert_eq!(audit.get_document("result").unwrap().get_bool("commitUnknown"), Ok(false));
    }
}
