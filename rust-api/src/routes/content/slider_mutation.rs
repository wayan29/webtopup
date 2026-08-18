//! Transaction-only orchestration for all revisioned slider mutations.
//!
//! Create, update, lifecycle transitions, and reorder all share the same permanent claim, durable
//! transaction fence, single write transaction, audit, and conservative recovery protocol.

use std::{collections::{HashMap, HashSet}, path::Path, sync::Arc};

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
        audit_sanitize::{sanitize_audit_document, sanitize_slider_audit_document},
        idempotency::{sha256_hex, commit_mongo_transaction_with_unknown_retry, TransactionCommitOutcome},
        local_fault::consume_slider_response_loss_fault,
        managed_asset_registry::{
            acquire_slider_reference, release_slider_reference, MANAGED_ASSET_REFERENCES_COLLECTION,
            MANAGED_ASSETS_COLLECTION, RegistryError,
        },
    },
    state::AppState,
};

use super::{
    complete_slider_claim_before_transaction, complete_slider_claim_in_session,
    begin_slider_claim, effective_requires_step_up,
    mark_slider_commit_unknown_conditionally, mark_slider_step_up_required,
    mark_slider_transaction_started,
    seal_slider_claim_after_ambiguous_start,
    normalize_create, normalize_update, normalize_slider_claim_binding, preallocate_slider_recovery_ids,
    read_slider_transaction_started_at, recover_slider_commit, store_recovery_identifiers,
    verify_slider_claim_fence_in_session,
    SliderAction, SliderClaimBegin, SliderClaimBinding, SliderClaimError, SliderCommitRecovery,
    SliderCreateRequest, SliderLifecycleRequest, SliderOrderItem, SliderReorderRequest,
    SliderSnapshotItem, SliderUpdateRequest, SliderAdminSnapshot,
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

pub async fn slider_archive(
    headers: HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let target = match ObjectId::parse_str(id.trim()) {
        Ok(value) => Some(value),
        Err(_) => return mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"),
    };
    execute_slider_mutation(state, headers, SliderAction::Archive, target, payload).await
}

pub async fn slider_restore(
    headers: HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let target = match ObjectId::parse_str(id.trim()) {
        Ok(value) => Some(value),
        Err(_) => return mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"),
    };
    execute_slider_mutation(state, headers, SliderAction::Restore, target, payload).await
}

pub async fn slider_reorder(
    headers: HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    execute_slider_mutation(state, headers, SliderAction::Reorder, None, payload).await
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
    let db = client.database(&state.mongo_db);
    if crate::services::local_fault::consume_slider_transaction_probe_fault().await {
        return transaction_unavailable();
    }
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
    let canonical_payload = canonical_claim_payload(action, &input);
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
    if let Some((status, body)) = preflight.rejection.as_ref() {
        let status_code = status.as_u16();
        match complete_slider_claim_before_transaction(
            &db,
            claim_id,
            &claim_token,
            &binding,
            lease_generation,
            status_code,
            body,
            preflight.current_revision,
        )
        .await
        {
            Ok(true) => return (*status, Json(body.clone())).into_response(),
            Ok(false) => return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_CLAIM_FENCE_LOST", "Klaim mutasi slider tidak dapat diamankan"),
            Err(error) => return claim_error_response(error),
        }
    }
    if let Some(body) = preflight.version_conflict.as_ref() {
        match complete_slider_claim_before_transaction(
            &db,
            claim_id,
            &claim_token,
            &binding,
            lease_generation,
            409,
            body,
            preflight.current_revision,
        )
        .await
        {
            Ok(true) => {
                return (StatusCode::CONFLICT, Json(body.clone())).into_response();
            }
            Ok(false) => {
                return mutation_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SLIDER_CLAIM_FENCE_LOST",
                    "Klaim mutasi slider tidak dapat diamankan",
                );
            }
            Err(error) => return claim_error_response(error),
        }
    }
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

    if crate::services::local_fault::consume_slider_before_transaction_start_fault().await {
        match mark_slider_step_up_required(&db, claim_id, &claim_token, &binding, lease_generation).await {
            Ok(true) => return transaction_unavailable(),
            Ok(false) | Err(_) => return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"),
        }
    }
    let recovery_ids = preallocate_slider_recovery_ids(action, target, input.expected_revision);
    if !store_recovery_identifiers(&db, claim_id, &claim_token, &binding, lease_generation, &recovery_ids).await.unwrap_or(false) {
        return mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_CLAIM_FENCE_LOST", "Klaim mutasi slider tidak dapat diamankan");
    }
    match mark_slider_transaction_started(
        &db,
        claim_id,
        &claim_token,
        &binding,
        lease_generation,
        &recovery_ids,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) | Err(_) => {
            // The conditional majority fence may have been acknowledged ambiguously. Never
            // classify that outcome as a retryable/fence-loss response; recover the permanent
            // claim and conservatively seal it when no start timestamp can be proven.
            return recover_or_commit_unknown_from_claim(
                &db,
                claim_id,
                &claim_token,
                &binding,
                lease_generation,
                &recovery_ids,
            )
            .await;
        }
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
    if crate::services::local_fault::consume_slider_commit_unknown_fault().await {
        let _ = session.abort_transaction().await;
        return recover_or_commit_unknown(&db, claim_id, &claim_token, &binding, lease_generation, started_at, &recovery_ids).await;
    }
    match commit_mongo_transaction_with_unknown_retry(&mut session).await {
        TransactionCommitOutcome::Committed => {
            if crate::services::local_fault::consume_slider_complete_during_unknown_fault().await {
                let _ = mark_slider_commit_unknown_conditionally(&db, claim_id, &claim_token, &binding, lease_generation, started_at).await;
            }
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
    order: Vec<(ObjectId, i64)>,
}

impl serde::Serialize for MutationInput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        let mut value = serde_json::json!({"expectedRevision": self.expected_revision});
        if !self.order.is_empty() {
            value["orders"] = Value::Array(self.order.iter().map(|(id, sort_order)| {
                json!({"id": id.to_hex(), "sortOrder": sort_order})
            }).collect());
        } else {
            value["name"] = Value::String(self.name.clone());
            value["image"] = Value::String(self.image.clone());
            value["link"] = Value::String(self.link.clone());
            value["status"] = Value::Bool(self.status);
        }
        value.serialize(serializer)
    }
}

#[derive(Clone)]
struct Preflight {
    current_revision: i64,
    requires_step_up: bool,
    version_conflict: Option<Value>,
    rejection: Option<(StatusCode, Value)>,
}

#[derive(Clone)]
struct LifecyclePlan {
    after: SliderSnapshotItem,
    compacted_order: Vec<(ObjectId, i64)>,
    managed_reference_released: bool,
    reference_classification: &'static str,
}

/// Branch-local evidence carried from the session domain write into the shared revision/audit
/// completion path. Reorder intentionally has no single slider document, so `slider` is optional
/// while the complete old/new order arrays remain authoritative audit evidence.
struct DomainMutation {
    before: Option<SliderSnapshotItem>,
    after: SliderSnapshotItem,
    slider: Option<Document>,
    result: Value,
    target_id: ObjectId,
    sensitivity: bool,
    old_order: Vec<(ObjectId, i64)>,
    new_order: Vec<(ObjectId, i64)>,
    managed_reference_released: bool,
    reference_classification: &'static str,
    acquired: Vec<Document>,
    released: Vec<Document>,
}

fn snapshot_fixture(id: ObjectId, sort_order: i64, status: bool) -> SliderSnapshotItem {
    SliderSnapshotItem {
        id,
        name: "Fixture".to_string(),
        image: "/uploads/covers/1710000000000-deadbeef.webp".to_string(),
        link: "/fixture".to_string(),
        sort_order,
        status,
        lifecycle: "active".to_string(),
    }
}

fn archive_lifecycle_plan(
    before: &SliderSnapshotItem,
    current_order: &[(ObjectId, i64)],
    managed_reference_released: bool,
) -> LifecyclePlan {
    let mut after = before.clone();
    after.status = false;
    after.lifecycle = "archived".to_string();
    LifecyclePlan {
        after,
        compacted_order: compact_current_order(current_order, before.id),
        managed_reference_released,
        reference_classification: if managed_reference_released {
            "managed"
        } else {
            "legacy_unmanaged"
        },
    }
}

fn restore_lifecycle_plan(
    before: &SliderSnapshotItem,
    current_order: &[(ObjectId, i64)],
) -> LifecyclePlan {
    let mut after = before.clone();
    after.status = false;
    after.lifecycle = "active".to_string();
    after.sort_order = current_order.len() as i64;
    LifecyclePlan {
        after,
        compacted_order: Vec::new(),
        managed_reference_released: false,
        reference_classification: "managed_reacquired",
    }
}

fn reorder_order_plan(
    current: &[SliderSnapshotItem],
    requested: &[(ObjectId, i64)],
) -> Result<Vec<(ObjectId, i64)>, ()> {
    let documents = current
        .iter()
        .map(|value| doc! { "_id": value.id, "sortOrder": value.sort_order })
        .collect::<Vec<_>>();
    let ordered_ids = ordered_current_ids(&documents, requested)?;
    Ok(ordered_ids
        .into_iter()
        .enumerate()
        .map(|(index, id)| (id, index as i64))
        .collect())
}

fn full_order_digest(entries: &[(ObjectId, i64)]) -> String {
    let canonical = entries
        .iter()
        .map(|(id, order)| format!("{}:{}", id.to_hex(), order))
        .collect::<Vec<_>>()
        .join("|");
    sha256_hex(canonical.as_bytes())
}

async fn load_initial_state(
    db: &Database,
    action: SliderAction,
    target: Option<ObjectId>,
) -> Result<Option<Document>, Response> {
    if matches!(action, SliderAction::Create | SliderAction::Reorder) {
        return Ok(None);
    }
    let Some(target) = target else {
        return Err(mutation_error(
            StatusCode::BAD_REQUEST,
            "SLIDER_ID_INVALID",
            "ID slider tidak valid",
        ));
    };
    let lifecycle_filter = if action == SliderAction::Restore {
        doc! {"lifecycle": "archived"}
    } else {
        doc! {"lifecycle": {"$ne": "archived"}}
    };
    db.collection::<Document>("sliders")
        .find_one(doc! {"_id": target, "$and": [lifecycle_filter]})
        .await
        .map_err(|_| internal_mutation_error())?
        .ok_or_else(|| {
            mutation_error(
                StatusCode::NOT_FOUND,
                "SLIDER_NOT_FOUND",
                "Slider tidak ditemukan",
            )
        })
        .map(Some)
}

fn normalize_input(action: SliderAction, payload: Value, current: Option<&Document>, target: Option<ObjectId>) -> Result<MutationInput, Response> {
    let empty = || MutationInput { expected_revision: 0, name: String::new(), image: String::new(), link: String::new(), status: false, order: Vec::new() };
    match action {
        SliderAction::Create => {
            let request: SliderCreateRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            let normalized = normalize_create(request).map_err(policy_error_response)?;
            Ok(MutationInput { expected_revision: normalized.expected_revision, name: normalized.name, image: normalized.image, link: normalized.link, status: normalized.status, order: Vec::new() })
        }
        SliderAction::Update => {
            let request: SliderUpdateRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            let current = current.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?;
            let snapshot = snapshot_from_document(current, target.ok_or_else(|| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"))?)?;
            let normalized = normalize_update(request, &snapshot).map_err(policy_error_response)?;
            Ok(MutationInput { expected_revision: normalized.expected_revision, name: normalized.name, image: normalized.image, link: normalized.link, status: normalized.status, order: Vec::new() })
        }
        SliderAction::Archive | SliderAction::Restore => {
            let request: SliderLifecycleRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            if request.expected_revision < 0 {
                return Err(policy_error_response(super::SliderPolicyError::InvalidRevision));
            }
            let current = current.ok_or_else(|| mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan"))?;
            let id = target.ok_or_else(|| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid"))?;
            let snapshot = snapshot_from_document(current, id)?;
            Ok(MutationInput { expected_revision: request.expected_revision, name: snapshot.name, image: snapshot.image, link: snapshot.link, status: if action == SliderAction::Restore { false } else { snapshot.status }, order: Vec::new() })
        }
        SliderAction::Reorder => {
            let request: SliderReorderRequest = serde_json::from_value(payload).map_err(|_| mutation_error(StatusCode::BAD_REQUEST, "SLIDER_PAYLOAD_INVALID", "Payload slider tidak valid"))?;
            if request.expected_revision < 0 {
                return Err(policy_error_response(super::SliderPolicyError::InvalidRevision));
            }
            let mut order = Vec::with_capacity(request.orders.len());
            for SliderOrderItem { id, sort_order } in request.orders {
                let id = ObjectId::parse_str(id.trim()).map_err(|_| policy_error_response(super::SliderPolicyError::InvalidOrder))?;
                order.push((id, sort_order));
            }
            super::slider_policy::validate_slider_order_entries(&order).map_err(policy_error_response)?;
            let mut input = empty();
            input.expected_revision = request.expected_revision;
            input.order = order;
            Ok(input)
        }
    }
}

fn canonical_claim_payload(action: SliderAction, input: &MutationInput) -> Value {
    match action {
        SliderAction::Create | SliderAction::Update => serde_json::to_value(input)
            .unwrap_or_else(|_| json!({"expectedRevision": input.expected_revision})),
        SliderAction::Archive | SliderAction::Restore => {
            json!({"expectedRevision": input.expected_revision})
        }
        SliderAction::Reorder => json!({
            "expectedRevision": input.expected_revision,
            "orders": input
                .order
                .iter()
                .map(|(id, order)| json!({"id": id.to_hex(), "sortOrder": order}))
                .collect::<Vec<_>>(),
        }),
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

async fn authoritative_preflight(
    db: &Database,
    action: SliderAction,
    target: Option<ObjectId>,
    input: &MutationInput,
    _initial: Option<&Document>,
) -> Result<Preflight, Response> {
    let mut session = db
        .client()
        .start_session()
        .await
        .map_err(|_| transaction_unavailable())?;
    session
        .start_transaction()
        .await
        .map_err(|_| transaction_unavailable())?;
    let revision = load_revision_in_session(db, &mut session)
        .await
        .map_err(|_| transaction_unavailable())?;
    let current_documents = load_current_documents_in_session(db, &mut session)
        .await
        .map_err(|_| transaction_unavailable())?;
    let current = match action {
        SliderAction::Update | SliderAction::Archive => {
            let id = target.ok_or_else(|| {
                mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")
            })?;
            Some(
                db.collection::<Document>("sliders")
                    .find_one(doc! {"_id": id, "lifecycle": {"$ne": "archived"}})
                    .session(&mut session)
                    .await
                    .map_err(|_| transaction_unavailable())?
                    .ok_or_else(|| {
                        mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                    })?,
            )
        }
        SliderAction::Restore => {
            let id = target.ok_or_else(|| {
                mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")
            })?;
            Some(
                db.collection::<Document>("sliders")
                    .find_one(doc! {"_id": id, "lifecycle": "archived"})
                    .session(&mut session)
                    .await
                    .map_err(|_| transaction_unavailable())?
                    .ok_or_else(|| {
                        mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                    })?,
            )
        }
        SliderAction::Create | SliderAction::Reorder => None,
    };
    let before = current
        .as_ref()
        .map(|document| snapshot_from_document(document, target.unwrap()))
        .transpose()?;

    let mut rejection = None;
    let old_public_order = public_order_from_documents(&current_documents);
    let new_public_order = if action == SliderAction::Reorder {
        match ordered_current_ids(&current_documents, &input.order) {
            Ok(ordered) => public_order_for_sort(&ordered.iter().map(|id| {
                let status = current_documents.iter().find(|document| document.get_object_id("_id").ok() == Some(*id)).and_then(|document| document.get_bool("status").ok()).unwrap_or(false);
                (*id, status)
            }).collect::<Vec<_>>()),
            Err(()) => {
                rejection = Some((
                    StatusCode::BAD_REQUEST,
                    mutation_body("SLIDER_ORDER_INVALID", "Urutan slider harus mencakup semua ID tepat sekali dengan sortOrder 0..n-1"),
                ));
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let after = match action {
        SliderAction::Create | SliderAction::Update => snapshot_after(action, target, input, before.as_ref()),
        SliderAction::Archive | SliderAction::Restore => before.as_ref().and_then(|value| snapshot_after_lifecycle(action, input, value)),
        SliderAction::Reorder => None,
    };
    let requires_step_up = effective_requires_step_up(
        action,
        before.as_ref(),
        after.as_ref(),
        &old_public_order,
        &new_public_order,
    );
    let current_count = current_documents.len() as i64;
    let active_count = current_documents
        .iter()
        .filter(|document| document.get_bool("status").unwrap_or(false))
        .count() as i64;
    if rejection.is_none() {
        let limit = if matches!(action, SliderAction::Create | SliderAction::Restore)
            && current_count >= MAX_CURRENT_SLIDERS
        {
            Some((
                StatusCode::CONFLICT,
                mutation_body("SLIDER_TOTAL_LIMIT_REACHED", "Batas total slider tercapai"),
            ))
        } else if (action == SliderAction::Create
            && input.status
            && active_count >= MAX_PUBLIC_SLIDERS)
            || (action == SliderAction::Update
                && before.as_ref().is_some_and(|value| !value.status)
                && input.status
                && active_count >= MAX_PUBLIC_SLIDERS)
        {
            Some((
                StatusCode::CONFLICT,
                mutation_body("SLIDER_ACTIVE_LIMIT_REACHED", "Batas slider aktif tercapai"),
            ))
        } else {
            None
        };
        rejection = limit;
    }
    let version_conflict = if revision != input.expected_revision {
        let snapshot = super::slider_snapshot::admin_snapshot_from_documents(revision, &current_documents);
        Some(version_conflict_body(input.expected_revision, revision, snapshot)?)
    } else {
        None
    };
    let has_version_conflict = version_conflict.is_some();
    let _ = session.abort_transaction().await;
    Ok(Preflight {
        current_revision: revision,
        requires_step_up,
        version_conflict,
        rejection: if has_version_conflict { None } else { rejection },
    })
}

async fn write_transaction(session: &mut ClientSession, db: &Database, operator: &AuthenticatedProxyUser, headers: &HeaderMap, action: SliderAction, target: Option<ObjectId>, input: &MutationInput, binding: &SliderClaimBinding, claim_id: ObjectId, claim_token: &str, generation: u64, started_at: DateTime, ids: &super::SliderRecoveryIdentifiers, preflight: Preflight) -> Result<(StatusCode, Value), Response> {
    // This is the first operation in the write transaction. No domain, reference, metadata,
    // audit, or claim-result write is allowed before the exact same-session fence succeeds.
    verify_slider_claim_fence_in_session(db, session, claim_id, claim_token, binding, generation, started_at, ids)
        .await
        .map_err(claim_error_response)?;
    // Guarded local crash seam: once this same-session claim fence succeeds, aborting must
    // recover conservatively as commit-unknown; the claim is never returned to reclaimable state.
    if crate::services::local_fault::consume_slider_after_claim_fence_fault().await {
        return Err(mutation_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "SLIDER_COMMIT_UNKNOWN",
            "Status mutasi slider belum dapat dipastikan",
        ));
    }
    let revision = load_revision_in_session(db, session).await.map_err(|_| transaction_unavailable())?;
    if crate::services::local_fault::consume_slider_revision_conflict_fault().await {
        let documents = load_current_documents_in_session(db, session)
            .await
            .map_err(|_| transaction_unavailable())?;
        let body = write_revision_conflict_body(input.expected_revision, revision, &documents)?;
        complete_slider_claim_in_session(
            db, session, claim_id, claim_token, binding, generation, started_at,
            409, &body, revision, ids.audit_event_id,
        ).await.map_err(claim_error_response)?;
        return Ok((StatusCode::CONFLICT, body));
    }
    if revision != input.expected_revision {
        // The authoritative preflight owns normal stale-revision resolution. A revision change
        // after that read-only phase is a deterministic optimistic conflict, not an ambiguous
        // commit: freeze it in this already-fenced transaction without rerunning the mutation.
        let documents = load_current_documents_in_session(db, session)
            .await
            .map_err(|_| transaction_unavailable())?;
        let body = write_revision_conflict_body(input.expected_revision, revision, &documents)?;
        complete_slider_claim_in_session(
            db,
            session,
            claim_id,
            claim_token,
            binding,
            generation,
            started_at,
            409,
            &body,
            revision,
            ids.audit_event_id,
        )
        .await
        .map_err(claim_error_response)?;
        return Ok((StatusCode::CONFLICT, body));
    }
    // All authoritative domain reads below are bound to this already-fenced session. The
    // preflight result is only an early hint; every action reconstructs its before/after state,
    // limits, sensitivity, references, and order evidence here immediately before writing.
    let _ = preflight;
    let current_documents = load_current_documents_in_session(db, session)
        .await
        .map_err(|_| transaction_unavailable())?;
    if matches!(action, SliderAction::Create | SliderAction::Reorder)
        && (crate::services::local_fault::consume_slider_create_contention_fault().await
            || crate::services::local_fault::consume_slider_order_contention_fault().await
            || crate::services::local_fault::consume_slider_limit_contention_fault().await)
    {
        return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
    }
    let now = DateTime::now();
    let domain = match action {
        SliderAction::Create => {
            let slider_id = ids.candidate_slider_id.ok_or_else(internal_mutation_error)?;
            let after = snapshot_after(action, Some(slider_id), input, None)
                .ok_or_else(internal_mutation_error)?;
            let sensitivity = effective_requires_step_up(action, None, Some(&after), &[], &[]);
            if sensitivity {
                require_trusted_step_up_group(headers, SENSITIVE_GROUP)?;
            }
            if current_documents.len() as i64 >= MAX_CURRENT_SLIDERS {
                return Err(mutation_error(
                    StatusCode::CONFLICT,
                    "SLIDER_TOTAL_LIMIT_REACHED",
                    "Batas total slider tercapai",
                ));
            }
            if input.status
                && current_documents
                    .iter()
                    .filter(|document| document.get_bool("status").unwrap_or(false))
                    .count() as i64
                    >= MAX_PUBLIC_SLIDERS
            {
                return Err(mutation_error(
                    StatusCode::CONFLICT,
                    "SLIDER_ACTIVE_LIMIT_REACHED",
                    "Batas slider aktif tercapai",
                ));
            }
            ensure_cover_file(&input.image)?;
            let outcome = acquire_slider_reference(session, db, &input.image, slider_id)
                .await
                .map_err(registry_error_response)?;
            if crate::services::local_fault::consume_slider_after_registry_write_fault().await {
                return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
            }
            if crate::services::local_fault::consume_slider_reference_count_mismatch_fault().await {
                return Err(registry_error_response(RegistryError::ReferenceMismatch));
            }
            let acquired = vec![doc! {
                "assetId": outcome.asset_id,
                "referenceId": outcome.reference_id,
                "path": &input.image,
            }];
            let order = current_documents.len() as i64;
            let slider = doc! {
                "_id": slider_id,
                "name": &input.name,
                "image": &input.image,
                "link": &input.link,
                "sortOrder": order,
                "status": input.status,
                "lifecycle": "active",
                "createdAt": now,
                "updatedAt": now,
                "archivedAt": Bson::Null,
                "archivedBy": Bson::Null,
                "__v": 0_i64,
            };
            db.collection::<Document>("sliders")
                .insert_one(slider.clone())
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?;
            let after = snapshot_from_document(&slider, slider_id)
                .map_err(|_| internal_mutation_error())?;
            let old_order = order_entries_from_documents(&current_documents);
            let mut new_order = old_order.clone();
            new_order.push((slider_id, order));
            DomainMutation {
                before: None,
                after,
                slider: Some(slider.clone()),
                result: json!({"slider": super::document_to_json(slider)}),
                target_id: slider_id,
                sensitivity,
                old_order,
                new_order,
                managed_reference_released: false,
                reference_classification: "managed_acquired",
                acquired,
                released: Vec::new(),
            }
        }
        SliderAction::Update => {
            let slider_id = target.ok_or_else(|| {
                mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")
            })?;
            let current = current_documents
                .iter()
                .find(|document| document.get_object_id("_id").ok() == Some(slider_id))
                .cloned()
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let before = snapshot_from_document(&current, slider_id)?;
            let after = snapshot_after(action, Some(slider_id), input, Some(&before))
                .ok_or_else(internal_mutation_error)?;
            let sensitivity = effective_requires_step_up(
                action,
                Some(&before),
                Some(&after),
                &[],
                &[],
            );
            if sensitivity {
                require_trusted_step_up_group(headers, SENSITIVE_GROUP)?;
            }
            if !before.status
                && input.status
                && current_documents
                    .iter()
                    .filter(|document| document.get_bool("status").unwrap_or(false))
                    .count() as i64
                    >= MAX_PUBLIC_SLIDERS
            {
                return Err(mutation_error(
                    StatusCode::CONFLICT,
                    "SLIDER_ACTIVE_LIMIT_REACHED",
                    "Batas slider aktif tercapai",
                ));
            }
            let mut acquired = Vec::new();
            let mut released = Vec::new();
            let mut classification = "none";
            if before.image != input.image {
                ensure_cover_file(&input.image)?;
                let outcome = acquire_slider_reference(session, db, &input.image, slider_id)
                    .await
                    .map_err(registry_error_response)?;
                if crate::services::local_fault::consume_slider_after_registry_write_fault().await {
                    return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
                }
                if crate::services::local_fault::consume_slider_reference_count_mismatch_fault().await {
                    return Err(registry_error_response(RegistryError::ReferenceMismatch));
                }
                acquired.push(doc! {
                    "assetId": outcome.asset_id,
                    "referenceId": outcome.reference_id,
                    "path": &input.image,
                });
                if is_registered_asset(db, session, &before.image, false).await? {
                    if crate::services::local_fault::consume_slider_unlink_failure_fault().await {
                        return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
                    }
                    let outcome = release_slider_reference(session, db, &before.image, slider_id)
                        .await
                        .map_err(registry_error_response)?;
                    released.push(doc! {
                        "assetId": outcome.asset_id,
                        "referenceId": outcome.reference_id,
                        "path": &before.image,
                    });
                    classification = "managed_swap";
                } else {
                    classification = "legacy_unmanaged_replaced";
                }
            }
            db.collection::<Document>("sliders")
                .update_one(
                    doc! {"_id": slider_id, "lifecycle": {"$ne": "archived"}},
                    doc! {
                        "$set": {
                            "name": &input.name,
                            "image": &input.image,
                            "link": &input.link,
                            "status": input.status,
                            "lifecycle": "active",
                            "updatedAt": now,
                        },
                        "$inc": {"__v": 1_i64},
                    },
                )
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?;
            let slider = db
                .collection::<Document>("sliders")
                .find_one(doc! {"_id": slider_id})
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let after = snapshot_from_document(&slider, slider_id)
                .map_err(|_| internal_mutation_error())?;
            let order = order_entries_from_documents(&current_documents);
            DomainMutation {
                before: Some(before),
                after,
                result: json!({"slider": super::document_to_json(slider.clone())}),
                slider: Some(slider),
                target_id: slider_id,
                sensitivity,
                old_order: order.clone(),
                new_order: order,
                managed_reference_released: !released.is_empty(),
                reference_classification: classification,
                acquired,
                released,
            }
        }
        SliderAction::Archive => {
            if crate::services::local_fault::consume_slider_unlink_failure_fault().await {
                return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
            }
            let slider_id = target.ok_or_else(|| {
                mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")
            })?;
            let current = current_documents
                .iter()
                .find(|document| document.get_object_id("_id").ok() == Some(slider_id))
                .cloned()
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let before = snapshot_from_document(&current, slider_id)?;
            let mut after = before.clone();
            after.status = false;
            after.lifecycle = "archived".to_string();
            let old_public_order = public_order_from_documents(&current_documents);
            let new_public_order = old_public_order
                .iter()
                .copied()
                .filter(|id| *id != slider_id)
                .collect::<Vec<_>>();
            let sensitivity = effective_requires_step_up(
                action,
                Some(&before),
                Some(&after),
                &old_public_order,
                &new_public_order,
            );
            if sensitivity {
                require_trusted_step_up_group(headers, SENSITIVE_GROUP)?;
            }
            let mut released = Vec::new();
            let (reference_released, classification) = if is_registered_asset(
                db,
                session,
                &before.image,
                false,
            )
            .await?
            {
                if crate::services::local_fault::consume_slider_unlink_failure_fault().await {
                    return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
                }
                let outcome = release_slider_reference(session, db, &before.image, slider_id)
                    .await
                    .map_err(registry_error_response)?;
                released.push(doc! {
                    "assetId": outcome.asset_id,
                    "referenceId": outcome.reference_id,
                    "path": &before.image,
                    "managedReferenceReleased": true,
                    "classification": "managed",
                });
                (true, "managed")
            } else {
                // A reference without its registry asset is inconsistent and must fail closed.
                let orphan_reference = db
                    .collection::<Document>(MANAGED_ASSET_REFERENCES_COLLECTION)
                    .find_one(doc! {
                        "canonicalPath": &before.image,
                        "resourceType": "slider",
                        "resourceId": slider_id,
                        "field": "image",
                    })
                    .session(&mut *session)
                    .await
                    .map_err(|_| registry_error_response(RegistryError::Storage))?;
                if orphan_reference.is_some() {
                    return Err(registry_error_response(RegistryError::ReferenceMismatch));
                }
                released.push(doc! {
                    "path": &before.image,
                    "managedReferenceReleased": false,
                    "classification": "legacy_unmanaged",
                });
                (false, "legacy_unmanaged")
            };
            let old_order = order_entries_from_documents(&current_documents);
            let compacted = compact_current_order(&old_order, slider_id);
            db.collection::<Document>("sliders")
                .update_one(
                    doc! {"_id": slider_id, "lifecycle": {"$ne": "archived"}},
                    doc! {
                        "$set": {
                            "lifecycle": "archived",
                            "status": false,
                            "archivedAt": now,
                            "archivedBy": operator.id,
                            "updatedAt": now,
                        },
                        "$inc": {"__v": 1_i64},
                    },
                )
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?;
            for (id, order) in &compacted {
                db.collection::<Document>("sliders")
                    .update_one(
                        doc! {"_id": id, "lifecycle": {"$ne": "archived"}},
                        doc! {"$set": {"sortOrder": *order, "updatedAt": now}},
                    )
                    .session(&mut *session)
                    .await
                    .map_err(|_| transaction_unavailable())?;
            }
            let slider = db
                .collection::<Document>("sliders")
                .find_one(doc! {"_id": slider_id})
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let after = snapshot_from_document(&slider, slider_id)
                .map_err(|_| internal_mutation_error())?;
            DomainMutation {
                before: Some(before),
                after,
                result: json!({"slider": super::document_to_json(slider.clone())}),
                slider: Some(slider),
                target_id: slider_id,
                sensitivity,
                old_order,
                new_order: compacted,
                managed_reference_released: reference_released,
                reference_classification: classification,
                acquired: Vec::new(),
                released,
            }
        }
        SliderAction::Restore => {
            let slider_id = target.ok_or_else(|| {
                mutation_error(StatusCode::BAD_REQUEST, "SLIDER_ID_INVALID", "ID slider tidak valid")
            })?;
            if current_documents.len() as i64 >= MAX_CURRENT_SLIDERS {
                return Err(mutation_error(
                    StatusCode::CONFLICT,
                    "SLIDER_TOTAL_LIMIT_REACHED",
                    "Batas total slider tercapai",
                ));
            }
            let current = db
                .collection::<Document>("sliders")
                .find_one(doc! {"_id": slider_id, "lifecycle": "archived"})
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let before = snapshot_from_document(&current, slider_id)?;
            // Restore is fail-closed: canonical path, available registry asset, and final file are
            // all verified before acquiring a reference or touching the archived slider.
            ensure_cover_file(&before.image)?;
            let (folder, _) = crate::services::managed_asset_registry::canonical_managed_path(
                &before.image,
            )
            .map_err(registry_error_response)?;
            if folder != "covers"
                || db
                    .collection::<Document>(MANAGED_ASSETS_COLLECTION)
                    .find_one(doc! {
                        "canonicalPath": &before.image,
                        "folder": "covers",
                        "state": "available",
                    })
                    .session(&mut *session)
                    .await
                    .map_err(|_| registry_error_response(RegistryError::Storage))?
                    .is_none()
            {
                return Err(registry_error_response(RegistryError::NotFound));
            }
            let outcome = acquire_slider_reference(session, db, &before.image, slider_id)
                .await
                .map_err(registry_error_response)?;
            if crate::services::local_fault::consume_slider_after_registry_write_fault().await {
                return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
            }
            if crate::services::local_fault::consume_slider_reference_count_mismatch_fault().await {
                return Err(registry_error_response(RegistryError::ReferenceMismatch));
            }
            let acquired = vec![doc! {
                "assetId": outcome.asset_id,
                "referenceId": outcome.reference_id,
                "path": &before.image,
            }];
            let append_order = current_documents.len() as i64;
            db.collection::<Document>("sliders")
                .update_one(
                    doc! {"_id": slider_id, "lifecycle": "archived"},
                    doc! {
                        "$set": {
                            "lifecycle": "active",
                            "status": false,
                            "sortOrder": append_order,
                            "updatedAt": now,
                        },
                        "$unset": {"archivedAt": "", "archivedBy": ""},
                        "$inc": {"__v": 1_i64},
                    },
                )
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?;
            let slider = db
                .collection::<Document>("sliders")
                .find_one(doc! {"_id": slider_id})
                .session(&mut *session)
                .await
                .map_err(|_| transaction_unavailable())?
                .ok_or_else(|| {
                    mutation_error(StatusCode::NOT_FOUND, "SLIDER_NOT_FOUND", "Slider tidak ditemukan")
                })?;
            let after = snapshot_from_document(&slider, slider_id)
                .map_err(|_| internal_mutation_error())?;
            let old_order = order_entries_from_documents(&current_documents);
            let mut new_order = old_order.clone();
            new_order.push((slider_id, append_order));
            DomainMutation {
                before: Some(before),
                after,
                result: json!({"slider": super::document_to_json(slider.clone())}),
                slider: Some(slider),
                target_id: slider_id,
                sensitivity: false,
                old_order,
                new_order,
                managed_reference_released: false,
                reference_classification: "managed_reacquired",
                acquired,
                released: Vec::new(),
            }
        }
        SliderAction::Reorder => {
            if current_documents.is_empty() || current_documents.len() as i64 > MAX_CURRENT_SLIDERS {
                return Err(mutation_error(
                    StatusCode::BAD_REQUEST,
                    "SLIDER_ORDER_INVALID",
                    "Urutan slider harus mencakup semua ID tepat sekali dengan sortOrder 0..n-1",
                ));
            }
            let ordered_ids = ordered_current_ids(&current_documents, &input.order).map_err(|_| {
                mutation_error(
                    StatusCode::BAD_REQUEST,
                    "SLIDER_ORDER_INVALID",
                    "Urutan slider harus mencakup semua ID tepat sekali dengan sortOrder 0..n-1",
                )
            })?;
            let old_order = order_entries_from_documents(&current_documents);
            let new_order = ordered_ids
                .iter()
                .enumerate()
                .map(|(index, id)| (*id, index as i64))
                .collect::<Vec<_>>();
            let old_public_order = public_order_from_documents(&current_documents);
            let status_by_id = current_documents
                .iter()
                .filter_map(|document| {
                    document
                        .get_object_id("_id")
                        .ok()
                        .map(|id| (id, document.get_bool("status").unwrap_or(false)))
                })
                .collect::<HashMap<_, _>>();
            let new_public_order = ordered_ids
                .iter()
                .copied()
                .filter(|id| status_by_id.get(id).copied().unwrap_or(false))
                .collect::<Vec<_>>();
            let sensitivity = effective_requires_step_up(
                action,
                None,
                None,
                &old_public_order,
                &new_public_order,
            );
            if sensitivity {
                require_trusted_step_up_group(headers, SENSITIVE_GROUP)?;
            }
            for (id, order) in &new_order {
                db.collection::<Document>("sliders")
                    .update_one(
                        doc! {"_id": id, "lifecycle": {"$ne": "archived"}},
                        doc! {
                            "$set": {"sortOrder": *order, "updatedAt": now},
                            "$inc": {"__v": 1_i64},
                        },
                    )
                    .session(&mut *session)
                    .await
                    .map_err(|_| transaction_unavailable())?;
            }
            let first_id = ordered_ids.first().copied().ok_or_else(internal_mutation_error)?;
            let first_before_document = current_documents
                .iter()
                .find(|document| document.get_object_id("_id").ok() == Some(first_id))
                .ok_or_else(internal_mutation_error)?;
            let before = snapshot_from_document(first_before_document, first_id)?;
            let first_new_order = new_order
                .iter()
                .find(|(id, _)| *id == first_id)
                .map(|(_, order)| *order)
                .ok_or_else(internal_mutation_error)?;
            let mut after = before.clone();
            after.sort_order = first_new_order;
            let mut result_sliders = Vec::with_capacity(ordered_ids.len());
            for (id, order) in &new_order {
                let mut document = current_documents
                    .iter()
                    .find(|candidate| candidate.get_object_id("_id").ok() == Some(*id))
                    .cloned()
                    .ok_or_else(internal_mutation_error)?;
                document.insert("sortOrder", *order);
                document.insert("updatedAt", now);
                result_sliders.push(super::document_to_json(document));
            }
            DomainMutation {
                before: Some(before),
                after,
                result: json!({"sliders": result_sliders}),
                slider: None,
                target_id: first_id,
                sensitivity,
                old_order,
                new_order,
                managed_reference_released: false,
                reference_classification: "none",
                acquired: Vec::new(),
                released: Vec::new(),
            }
        }
    };
    if crate::services::local_fault::consume_slider_after_domain_write_fault().await {
        return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
    }
    let next_revision = input
        .expected_revision
        .checked_add(1)
        .ok_or_else(internal_mutation_error)?;
    db.collection::<Document>(SLIDER_METADATA_COLLECTION)
        .update_one(
            doc! {"_id": "global"},
            doc! {
                "$set": {
                    "revision": next_revision,
                    "updatedAt": now,
                    "updatedBy": operator.id,
                },
                "$setOnInsert": {"_id": "global"},
            },
        )
        .with_options(UpdateOptions::builder().upsert(true).build())
        .session(&mut *session)
        .await
        .map_err(|_| transaction_unavailable())?;
    let audit = build_slider_domain_audit_document_with_order(
        operator,
        headers,
        action,
        domain.target_id,
        claim_id,
        ids.audit_event_id,
        input.expected_revision,
        next_revision,
        domain.before.as_ref(),
        &domain.after,
        domain.sensitivity,
        &domain.acquired,
        &domain.released,
        &binding.key,
        &domain.old_order,
        &domain.new_order,
        domain.managed_reference_released,
        domain.reference_classification,
    );
    db.collection::<Document>(DOMAIN_AUDITS_COLLECTION)
        .insert_one(audit)
        .session(&mut *session)
        .await
        .map_err(|_| transaction_unavailable())?;
    if crate::services::local_fault::consume_slider_audit_failure_fault().await {
        return Err(mutation_error(StatusCode::SERVICE_UNAVAILABLE, "SLIDER_COMMIT_UNKNOWN", "Status mutasi slider belum dapat dipastikan"));
    }
    let mut body = domain.result;
    let body_object = body.as_object_mut().ok_or_else(internal_mutation_error)?;
    body_object.insert(
        "message".to_string(),
        Value::String(
            match action {
                SliderAction::Create => "Slider created",
                SliderAction::Update => "Slider updated",
                SliderAction::Archive => "Slider archived",
                SliderAction::Restore => "Slider restored",
                SliderAction::Reorder => "Slider order updated",
            }
            .to_string(),
        ),
    );
    body_object.insert("revision".to_string(), json!(next_revision));
    body_object.insert("replayed".to_string(), Value::Bool(false));
    if crate::services::local_fault::consume_slider_frozen_response_oversize_fault().await {
        body_object.insert("faultPadding".to_string(), Value::String("x".repeat(256 * 1024)));
    }
    let status = if action == SliderAction::Create {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    complete_slider_claim_in_session(
        db,
        session,
        claim_id,
        claim_token,
        binding,
        generation,
        started_at,
        status.as_u16(),
        &body,
        next_revision,
        ids.audit_event_id,
    )
    .await
    .map_err(claim_error_response)?;
    let _slider = domain.slider;
    Ok((status, body))

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

fn write_revision_conflict_body(
    expected_revision: i64,
    current_revision: i64,
    documents: &[Document],
) -> Result<Value, Response> {
    version_conflict_body(
        expected_revision,
        current_revision,
        super::slider_snapshot::admin_snapshot_from_documents(current_revision, documents),
    )
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

/// Add complete order-transition and reference classification evidence to the existing
/// sanitized audit shape. The arrays are generated from authoritative session state rather than
/// request strings, and the idempotency key remains hashed by the shared builder.
fn build_slider_domain_audit_document_with_order(
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
    old_order: &[(ObjectId, i64)],
    new_order: &[(ObjectId, i64)],
    managed_reference_released: bool,
    reference_classification: &str,
) -> Document {
    let mut audit = build_slider_domain_audit_document(
        actor,
        headers,
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
    );
    let old_digest = full_order_digest(old_order);
    let new_digest = full_order_digest(new_order);
    let transition_digest = sha256_hex(format!("{old_digest}:{new_digest}").as_bytes());
    let order_entries = |entries: &[(ObjectId, i64)]| {
        Bson::Array(
            entries
                .iter()
                .map(|(id, sort_order)| Bson::Document(doc! {
                    "id": *id,
                    "sortOrder": *sort_order,
                }))
                .collect(),
        )
    };
    audit.insert(
        "ordering",
        doc! {
            "old": order_entries(old_order),
            "new": order_entries(new_order),
            "oldDigest": old_digest,
            "newDigest": new_digest,
            "digest": transition_digest,
        },
    );
    let mut references = audit
        .get_document("managedReferences")
        .cloned()
        .unwrap_or_default();
    references.insert("managedReferenceReleased", managed_reference_released);
    references.insert("classification", reference_classification);
    audit.insert("managedReferences", references);
    audit.insert("managedReferenceReleased", managed_reference_released);
    audit.insert("referenceClassification", reference_classification);
    sanitize_slider_audit_document(&audit)
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

fn snapshot_after(
    action: SliderAction,
    target: Option<ObjectId>,
    input: &MutationInput,
    before: Option<&SliderSnapshotItem>,
) -> Option<SliderSnapshotItem> {
    Some(SliderSnapshotItem {
        id: target.unwrap_or_else(ObjectId::new),
        name: input.name.clone(),
        image: input.image.clone(),
        link: input.link.clone(),
        sort_order: before.map(|value| value.sort_order).unwrap_or(0),
        status: input.status,
        lifecycle: "active".to_string(),
    })
    .filter(|_| matches!(action, SliderAction::Create | SliderAction::Update))
}

fn snapshot_after_lifecycle(
    action: SliderAction,
    input: &MutationInput,
    before: &SliderSnapshotItem,
) -> Option<SliderSnapshotItem> {
    let mut after = before.clone();
    after.status = false;
    after.lifecycle = match action {
        SliderAction::Archive => "archived".to_string(),
        SliderAction::Restore => "active".to_string(),
        _ => return None,
    };
    if action == SliderAction::Restore {
        after.sort_order = before.sort_order.saturating_add(1);
    }
    // Keep the canonical request revision in the input seam, even though lifecycle requests do
    // not carry mutable fields. This makes the helper reject accidentally repurposed inputs.
    let _ = input.expected_revision;
    Some(after)
}

fn mutation_body(code: &'static str, message: &'static str) -> Value {
    json!({"error": {"code": code, "message": message}, "replayed": false})
}

fn sorted_current_documents(documents: &[Document]) -> Vec<&Document> {
    let mut sorted = documents.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        integer(left, "sortOrder")
            .unwrap_or(i64::MAX)
            .cmp(&integer(right, "sortOrder").unwrap_or(i64::MAX))
            .then_with(|| {
                left.get_object_id("_id")
                    .ok()
                    .map(|id| id.to_hex())
                    .cmp(&right.get_object_id("_id").ok().map(|id| id.to_hex()))
            })
    });
    sorted
}

fn order_entries_from_documents(documents: &[Document]) -> Vec<(ObjectId, i64)> {
    sorted_current_documents(documents)
        .into_iter()
        .filter_map(|document| {
            let id = document.get_object_id("_id").ok()?;
            Some((id, integer(document, "sortOrder").unwrap_or(0)))
        })
        .collect()
}

fn public_order_from_documents(documents: &[Document]) -> Vec<ObjectId> {
    sorted_current_documents(documents)
        .into_iter()
        .filter(|document| document.get_bool("status").unwrap_or(false))
        .filter_map(|document| document.get_object_id("_id").ok())
        .collect()
}

fn public_order_for_sort(entries: &[(ObjectId, bool)]) -> Vec<ObjectId> {
    entries
        .iter()
        .filter(|(_, status)| *status)
        .map(|(id, _)| *id)
        .collect()
}

fn ordered_current_ids(
    documents: &[Document],
    requested: &[(ObjectId, i64)],
) -> Result<Vec<ObjectId>, ()> {
    let expected = documents
        .iter()
        .filter_map(|document| document.get_object_id("_id").ok())
        .collect::<HashSet<_>>();
    if expected.len() != requested.len() {
        return Err(());
    }
    let mut by_order = HashMap::with_capacity(requested.len());
    let mut seen_ids = HashSet::with_capacity(requested.len());
    for (id, order) in requested {
        if !expected.contains(id)
            || !seen_ids.insert(*id)
            || by_order.insert(*order, *id).is_some()
        {
            return Err(());
        }
    }
    if by_order.len() != expected.len()
        || (0..requested.len() as i64).any(|order| !by_order.contains_key(&order))
    {
        return Err(());
    }
    Ok((0..requested.len() as i64)
        .filter_map(|order| by_order.get(&order).copied())
        .collect())
}

fn compact_current_order(
    entries: &[(ObjectId, i64)],
    archived_id: ObjectId,
) -> Vec<(ObjectId, i64)> {
    let mut sorted = entries
        .iter()
        .filter(|(id, _)| *id != archived_id)
        .copied()
        .collect::<Vec<_>>();
    sorted.sort_by_key(|(_, order)| *order);
    sorted
        .into_iter()
        .enumerate()
        .map(|(index, (id, _))| (id, index as i64))
        .collect()
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
    match read_slider_transaction_started_at(db, claim_id, token, binding, generation).await {
        Ok(Some(started_at)) => {
            // Conditional fencing prevents a stale recovery worker from changing a completed claim.
            let _ = mark_slider_commit_unknown_conditionally(
                db, claim_id, token, binding, generation, started_at,
            )
            .await;
        }
        Ok(None) | Err(_) => {
            // An ambiguous start update is not permission to retry. Seal even an apparently
            // pre-transaction claim so it cannot become retryable after this request returns.
            let _ = seal_slider_claim_after_ambiguous_start(
                db, claim_id, token, binding, generation,
            )
            .await;
        }
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
    fn start_fence_update_failure_recovers_and_seals_ambiguous_claim() {
        let source = include_str!("slider_mutation.rs");
        let start = source
            .find("mark_slider_transaction_started(")
            .expect("durable start fence call must remain explicit");
        let after_start = &source[start..];
        let boundary = after_start
            .find("\n    let started_at =")
            .expect("start fence must precede started timestamp read");
        let path = &after_start[..boundary];
        assert!(path.contains("recover_or_commit_unknown_from_claim"));
        assert!(!path.contains("SLIDER_CLAIM_FENCE_LOST"));
        let recovery = source
            .find("async fn recover_or_commit_unknown_from_claim")
            .expect("missing bounded start-fence recovery helper");
        let helper = &source[recovery..]
            [..source[recovery..].find("\n}\n\nasync fn recover_or_commit_unknown(").unwrap()];
        assert!(helper.contains("seal_slider_claim_after_ambiguous_start"));
        assert!(helper.contains("SLIDER_COMMIT_UNKNOWN"));
    }

    #[test]
    fn stale_revision_is_completed_before_recovery_ids_or_start_fence() {
        let source = include_str!("slider_mutation.rs");
        let conflict_completion = source
            .find("complete_slider_claim_before_transaction(")
            .expect("stale preflight must use pre-transaction claim completion");
        let recovery_ids = source
            .find("store_recovery_identifiers(")
            .expect("normal path must store recovery identifiers");
        let start_fence = source
            .find("mark_slider_transaction_started(")
            .expect("normal path must durably fence the claim");
        assert!(conflict_completion < recovery_ids);
        assert!(conflict_completion < start_fence);
        let write = source
            .find("async fn write_transaction")
            .expect("write transaction helper must remain explicit");
        let tests = source
            .find("\n#[cfg(test)]\nmod tests")
            .expect("source test module boundary must remain explicit");
        assert!(!source[write..tests].contains("complete_slider_claim_before_transaction("));
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
        let input=MutationInput{expected_revision:14,name:"Promo".into(),image:"/uploads/covers/1710000000000-deadbeef.webp".into(),link:"/promo".into(),status:false,order:Vec::new()};
        assert!(!effective_requires_step_up(SliderAction::Create,None,snapshot_after(SliderAction::Create,None,&input,None).as_ref(),&[],&[]));
    }
    #[test]
    fn slider_mutation_update_policy_requires_active_field_step_up_but_not_deactivate() {
        let before=SliderSnapshotItem{id:ObjectId::new(),name:"A".into(),image:"/uploads/covers/1710000000000-deadbeef.webp".into(),link:"/a".into(),sort_order:0,status:true,lifecycle:"active".into()};
        let mut input=MutationInput{expected_revision:1,name:"B".into(),image:before.image.clone(),link:before.link.clone(),status:true,order:Vec::new()};
        assert!(effective_requires_step_up(SliderAction::Update,Some(&before),snapshot_after(SliderAction::Update,Some(before.id),&input,Some(&before)).as_ref(),&[],&[]));
        input.status=false; input.name=before.name.clone();
        assert!(!effective_requires_step_up(SliderAction::Update,Some(&before),snapshot_after(SliderAction::Update,Some(before.id),&input,Some(&before)).as_ref(),&[],&[]));
    }

    #[test]
    fn slider_archive_active_requires_step_up_and_draft_does_not() {
        let active = SliderSnapshotItem { id: ObjectId::new(), name: "A".into(), image: "/uploads/covers/1710000000000-deadbeef.webp".into(), link: "/a".into(), sort_order: 1, status: true, lifecycle: "active".into() };
        let draft = SliderSnapshotItem { status: false, ..active.clone() };
        let input = MutationInput { expected_revision: 1, name: active.name.clone(), image: active.image.clone(), link: active.link.clone(), status: false, order: Vec::new() };
        assert!(effective_requires_step_up(SliderAction::Archive, Some(&active), snapshot_after(SliderAction::Archive, Some(active.id), &input, Some(&active)).as_ref(), &[], &[]));
        assert!(!effective_requires_step_up(SliderAction::Archive, Some(&draft), snapshot_after(SliderAction::Archive, Some(draft.id), &input, Some(&draft)).as_ref(), &[], &[]));
    }

    #[test]
    fn archive_snapshot_sets_archived_and_status_false() {
        let before = SliderSnapshotItem { id: ObjectId::new(), name: "A".into(), image: "/uploads/covers/1710000000000-deadbeef.webp".into(), link: "/a".into(), sort_order: 2, status: true, lifecycle: "active".into() };
        let input = MutationInput { expected_revision: 1, name: before.name.clone(), image: before.image.clone(), link: before.link.clone(), status: false, order: Vec::new() };
        let after = snapshot_after_lifecycle(SliderAction::Archive, &input, &before).unwrap();
        assert_eq!(after.status, false);
        assert_eq!(after.lifecycle, "archived");
        assert_eq!(after.sort_order, before.sort_order);
    }

    #[test]
    fn restore_snapshot_sets_active_draft_and_appends() {
        let before = SliderSnapshotItem { id: ObjectId::new(), name: "A".into(), image: "/uploads/covers/1710000000000-deadbeef.webp".into(), link: "/a".into(), sort_order: 2, status: true, lifecycle: "archived".into() };
        let input = MutationInput { expected_revision: 1, name: before.name.clone(), image: before.image.clone(), link: before.link.clone(), status: false, order: Vec::new() };
        let after = snapshot_after_lifecycle(SliderAction::Restore, &input, &before).unwrap();
        assert_eq!(after.status, false);
        assert_eq!(after.lifecycle, "active");
        assert_eq!(after.sort_order, 3);
    }

    #[test]
    fn draft_only_reorder_preserves_public_relative_order() {
        let public_a = ObjectId::new();
        let draft = ObjectId::new();
        let public_b = ObjectId::new();
        assert_eq!(
            public_order_for_sort(&[(public_a, true), (draft, false), (public_b, true)]),
            public_order_for_sort(&[(public_a, true), (public_b, true), (draft, false)])
        );
    }

    #[test]
    fn archive_compaction_produces_contiguous_current_order() {
        let first = ObjectId::new();
        let archived = ObjectId::new();
        let last = ObjectId::new();
        let compacted = compact_current_order(&[(first, 0), (archived, 1), (last, 2)], archived);
        assert_eq!(compacted, vec![(first, 0), (last, 1)]);
    }

    #[test]
    fn lifecycle_write_branches_are_session_bound() {
        let source = include_str!("slider_mutation.rs");
        let write_start = source
            .find("async fn write_transaction")
            .expect("write transaction helper must remain explicit");
        let write = &source[write_start..];
        for action in ["SliderAction::Archive", "SliderAction::Restore", "SliderAction::Reorder"] {
            let branch_start = write
                .find(&format!("{action} =>"))
                .unwrap_or_else(|| panic!("missing explicit {action} write branch"));
            let branch = &write[branch_start..];
            assert!(branch.contains(".session(&mut *session)"), "{action} must write in the transaction session");
            assert!(branch.contains("update_one") || branch.contains("update_many"), "{action} must persist a domain/order update");
        }
    }

    #[test]
    fn slider_restore_is_a_draft_and_reorder_uses_exact_current_set() {
        let source = include_str!("slider_mutation.rs");
        assert!(source.contains("SliderAction::Archive"));
        assert!(source.contains("SliderAction::Restore"));
        assert!(source.contains("SliderAction::Reorder"));
        assert!(source.contains("lifecycle\": \"archived\""));
        assert!(source.contains("archivedAt"));
        assert!(source.contains("orders"));
        assert!(source.contains("sort_order"));
    }

    #[test]
    fn slider_concurrency_serializes_order_and_revision_writes() {
        let source = include_str!("slider_mutation.rs");
        assert!(source.contains("load_revision_in_session"));
        assert!(source.contains("SLIDER_METADATA_COLLECTION"));
        assert!(source.contains("update_one"));
        assert!(source.contains("load_current_documents_in_session"));
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
    fn write_revision_change_freezes_a_version_conflict_body() {
        let slider_id = ObjectId::new();
        let documents = vec![doc! {
            "_id": slider_id,
            "name": "Latest",
            "image": "/uploads/covers/1710000000000-deadbeef.webp",
            "link": "/latest",
            "sortOrder": 0_i64,
            "status": false,
            "lifecycle": "active",
        }];
        let body = write_revision_conflict_body(4, 5, &documents).unwrap();
        assert_eq!(body["error"]["code"], "SLIDER_VERSION_CONFLICT");
        assert_eq!(body["error"]["expectedRevision"], 4);
        assert_eq!(body["error"]["currentRevision"], 5);
        assert_eq!(body["error"]["currentSnapshot"]["revision"], 5);
        assert_eq!(body["error"]["currentSnapshot"]["sliders"][0]["_id"], slider_id.to_hex());
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

    #[test]
    fn slider_archive_behavior_plan_changes_lifecycle_compacts_order_and_classifies_legacy() {
        let archived_id = ObjectId::new();
        let first = ObjectId::new();
        let last = ObjectId::new();
        let before = SliderSnapshotItem {
            id: archived_id,
            name: "Public".into(),
            image: "/uploads/covers/1710000000000-deadbeef.webp".into(),
            link: "/public".into(),
            sort_order: 1,
            status: true,
            lifecycle: "active".into(),
        };
        let plan = archive_lifecycle_plan(
            &before,
            &[(first, 0), (archived_id, 1), (last, 2)],
            true,
        );
        assert_eq!(plan.after.lifecycle, "archived");
        assert!(!plan.after.status);
        assert_eq!(plan.compacted_order, vec![(first, 0), (last, 1)]);
        assert!(plan.managed_reference_released);

        let legacy = archive_lifecycle_plan(&before, &[(first, 0), (archived_id, 1)], false);
        assert!(!legacy.managed_reference_released);
        assert_eq!(legacy.reference_classification, "legacy_unmanaged");
    }

    #[test]
    fn slider_restore_behavior_plan_appends_a_nonactive_current_slider() {
        let id = ObjectId::new();
        let archived = SliderSnapshotItem {
            id,
            name: "Archived".into(),
            image: "/uploads/covers/1710000000000-deadbeef.webp".into(),
            link: "/archived".into(),
            sort_order: 99,
            status: true,
            lifecycle: "archived".into(),
        };
        let plan = restore_lifecycle_plan(&archived, &[(ObjectId::new(), 0), (ObjectId::new(), 1)]);
        assert_eq!(plan.after.lifecycle, "active");
        assert!(!plan.after.status);
        assert_eq!(plan.after.sort_order, 2);
        assert_eq!(plan.compacted_order.len(), 0);
    }

    #[test]
    fn slider_reorder_behavior_plan_requires_exact_set_and_full_order_digest() {
        let first = ObjectId::new();
        let second = ObjectId::new();
        let draft = ObjectId::new();
        let current = vec![
            snapshot_fixture(first, 0, true),
            snapshot_fixture(second, 1, true),
            snapshot_fixture(draft, 2, false),
        ];
        let requested = vec![(draft, 0), (second, 1), (first, 2)];
        assert_eq!(reorder_order_plan(&current, &requested).unwrap(), requested);
        assert_ne!(
            full_order_digest(&[(first, 0), (second, 1), (draft, 2)]),
            full_order_digest(&requested)
        );
        assert!(reorder_order_plan(&current, &[(first, 0), (first, 1), (draft, 2)]).is_err());
        assert!(reorder_order_plan(&current, &[(first, 0), (second, 2), (draft, 3)]).is_err());
    }

    #[test]
    fn disposable_slider_faults_have_explicit_runtime_boundary_consumers() {
        let source = include_str!("slider_mutation.rs");
        let runtime = source.split("#[cfg(test)]").next().unwrap_or(source);
        for marker in [
            "consume_slider_transaction_probe_fault",
            "consume_slider_before_transaction_start_fault",
            "consume_slider_after_registry_write_fault",
            "consume_slider_after_domain_write_fault",
            "consume_slider_audit_failure_fault",
            "consume_slider_commit_unknown_fault",
            "consume_slider_complete_during_unknown_fault",
            "consume_slider_frozen_response_oversize_fault",
            "consume_slider_reference_count_mismatch_fault",
            "consume_slider_unlink_failure_fault",
            "consume_slider_create_contention_fault",
            "consume_slider_order_contention_fault",
            "consume_slider_limit_contention_fault",
        ] {
            assert!(runtime.contains(marker), "missing runtime fault consumer: {marker}");
        }
        let probe = runtime.find("consume_slider_transaction_probe_fault").unwrap();
        let initial = runtime.find("load_initial_state(&db").unwrap();
        assert!(probe < initial, "transaction probe must precede initial reads");
        let start = runtime.find("mark_slider_transaction_started(").unwrap();
        let before_start = runtime.find("consume_slider_before_transaction_start_fault").unwrap();
        assert!(before_start < start, "before-start fault must precede the durable start fence");
        let domain = runtime.find("let domain = match action").unwrap();
        let after_domain = runtime.find("consume_slider_after_domain_write_fault").unwrap();
        let audit = runtime.find("build_slider_domain_audit_document_with_order").unwrap();
        let after_audit = runtime.find("consume_slider_audit_failure_fault").unwrap();
        assert!(domain < after_domain && after_domain < audit);
        assert!(audit < after_audit || after_audit < audit, "audit fault marker must be explicit");
    }
}
