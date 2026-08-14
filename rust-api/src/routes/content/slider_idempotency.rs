//! Permanent, fenced slider idempotency claims.
//!
//! Claims are durable coordination records, not an execution engine.  This module owns the
//! binding, lease/generation fences, recovery identifiers, and bounded frozen results that a
//! later mutation service can use.  In particular, it never invokes a mutation closure while
//! investigating an ambiguous commit.

use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{
        FindOneOptions, IndexOptions, InsertOneOptions, ReadConcern, UpdateModifications,
        UpdateOptions, WriteConcern,
    },
    ClientSession, Database, IndexModel,
};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::Value;

use super::{
    slider_policy::{
        canonical_slider_claim_digest as policy_claim_digest,
        canonical_slider_claim_input as policy_claim_input, SliderAction,
        SLIDER_MUTATION_CONTRACT,
    },
    slider_types::PublicSliderItem,
};

pub const SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION: &str = "slideridempotencyclaims";
pub const SLIDER_CLAIM_KEY_INDEX: &str = "slider_claim_key_unique";
pub const SLIDER_CLAIM_STATE_INDEX: &str = "slider_claim_state_lease";
pub const SLIDER_CLAIM_COMMIT_UNKNOWN_INDEX: &str = "slider_claim_commit_unknown";

pub const SLIDER_CLAIM_STATE_IN_PROGRESS: &str = "in_progress";
pub const SLIDER_CLAIM_STATE_RETRYABLE: &str = "retryable";
pub const SLIDER_CLAIM_STATE_COMPLETED: &str = "completed";
pub const SLIDER_CLAIM_LEASE_SECONDS: i64 = 5 * 60;
pub const SLIDER_FROZEN_RESPONSE_MAX_BYTES: usize = 256 * 1024;

pub fn slider_idempotency_index_models() -> Vec<IndexModel> {
    vec![
        IndexModel::builder()
            .keys(doc! { "key": 1 })
            .options(
                IndexOptions::builder()
                    .name(SLIDER_CLAIM_KEY_INDEX.to_string())
                    .unique(true)
                    .build(),
            )
            .build(),
        IndexModel::builder()
            .keys(doc! { "state": 1, "leaseExpiresAt": 1 })
            .options(
                IndexOptions::builder()
                    .name(SLIDER_CLAIM_STATE_INDEX.to_string())
                    .build(),
            )
            .build(),
        IndexModel::builder()
            .keys(doc! { "commitUnknown": 1, "transactionStartedAt": 1 })
            .options(
                IndexOptions::builder()
                    .name(SLIDER_CLAIM_COMMIT_UNKNOWN_INDEX.to_string())
                    .build(),
            )
            .build(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliderClaimBinding {
    pub key: String,
    pub contract_version: String,
    pub operator_id: ObjectId,
    pub action: String,
    pub target_id: Option<ObjectId>,
    pub expected_revision: i64,
    pub payload_digest: String,
}

impl SliderClaimBinding {
    pub fn canonical_input(&self, normalized_payload: &Value) -> Value {
        canonical_slider_claim_input(self, normalized_payload)
    }

    pub fn canonical_digest(&self, normalized_payload: &Value) -> String {
        canonical_slider_claim_digest(&self.canonical_input(normalized_payload))
    }

    fn target_bson(&self) -> Bson {
        self.target_id.map(Bson::ObjectId).unwrap_or(Bson::Null)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SliderClaimBegin {
    Started {
        claim_id: ObjectId,
        claim_token: String,
        lease_generation: u64,
    },
    Completed {
        status: u16,
        body: Value,
        result_revision: Option<i64>,
    },
    Conflict,
    InProgress,
    CommitUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderClaimError {
    IndexesNotReady,
    Storage,
    InvalidKey,
    ResponseTooLarge,
    Fenced,
    RecoveryIdentifiersImmutable,
}

impl SliderClaimError {
    pub fn code(self) -> &'static str {
        match self {
            Self::IndexesNotReady => "SLIDER_INDEX_UNAVAILABLE",
            Self::Storage => "SLIDER_CLAIM_STORAGE_FAILED",
            Self::InvalidKey => "IDEMPOTENCY_KEY_INVALID",
            Self::ResponseTooLarge => "SLIDER_RESPONSE_TOO_LARGE",
            Self::Fenced => "SLIDER_CLAIM_FENCE_LOST",
            Self::RecoveryIdentifiersImmutable => "SLIDER_RECOVERY_IDENTIFIERS_IMMUTABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliderRecoveryIdentifiers {
    pub candidate_slider_id: Option<ObjectId>,
    pub audit_event_id: ObjectId,
    pub candidate_result_revision: i64,
}

impl SliderRecoveryIdentifiers {
    pub fn for_action(
        action: SliderAction,
        target_id: Option<ObjectId>,
        expected_revision: i64,
    ) -> Self {
        Self {
            candidate_slider_id: (action == SliderAction::Create).then(ObjectId::new),
            audit_event_id: ObjectId::new(),
            candidate_result_revision: expected_revision.saturating_add(1),
        }
        .with_target_for_non_create(action, target_id)
    }

    fn with_target_for_non_create(mut self, action: SliderAction, target_id: Option<ObjectId>) -> Self {
        if action != SliderAction::Create {
            self.candidate_slider_id = target_id;
        }
        self
    }
}

/// Preallocate all identifiers before the durable transaction-start fence.
pub fn preallocate_slider_recovery_ids(
    action: SliderAction,
    target_id: Option<ObjectId>,
    expected_revision: i64,
) -> SliderRecoveryIdentifiers {
    SliderRecoveryIdentifiers::for_action(action, target_id, expected_revision)
}

/// String-action adapter useful at request boundaries that have not parsed `SliderAction` yet.
pub fn preallocate_recovery_identifiers(
    action: &str,
    target_id: Option<ObjectId>,
    expected_revision: i64,
) -> SliderRecoveryIdentifiers {
    let parsed = match action {
        "create" => SliderAction::Create,
        "update" => SliderAction::Update,
        "archive" => SliderAction::Archive,
        "restore" => SliderAction::Restore,
        "reorder" => SliderAction::Reorder,
        _ => SliderAction::Update,
    };
    preallocate_slider_recovery_ids(parsed, target_id, expected_revision)
}

#[derive(Debug, Clone, PartialEq)]
pub enum SliderCommitRecovery {
    Completed {
        status: u16,
        body: Value,
        result_revision: Option<i64>,
    },
    CommitUnknown,
}

/// Bounded evidence supplied by a recovery coordinator.  This is deliberately data-only: no
/// closure or callback is present, so proving a commit cannot execute the mutation again.
#[derive(Debug, Clone, Default)]
pub struct SliderRecoveryEvidence {
    pub claim: Option<Document>,
    pub domain: Option<Document>,
    pub audit: Option<Document>,
    pub current_revision: Option<i64>,
    pub frozen_response: Option<Value>,
    pub response_status: Option<u16>,
    pub claim_id: Option<ObjectId>,
    pub claim_token: Option<String>,
    pub lease_generation: Option<u64>,
    pub recovery_ids: Option<SliderRecoveryIdentifiers>,
}

pub fn canonical_slider_claim_input(
    binding: &SliderClaimBinding,
    normalized_payload: &Value,
) -> Value {
    policy_claim_input(
        &binding.contract_version,
        binding.operator_id,
        action_from_binding(binding),
        binding.target_id,
        binding.expected_revision,
        normalized_payload,
    )
}

pub fn canonical_slider_claim_digest(input: &Value) -> String {
    policy_claim_digest(input)
}

fn action_from_binding(binding: &SliderClaimBinding) -> SliderAction {
    match binding.action.as_str() {
        "create" => SliderAction::Create,
        "archive" => SliderAction::Archive,
        "restore" => SliderAction::Restore,
        "reorder" => SliderAction::Reorder,
        _ => SliderAction::Update,
    }
}

pub fn normalize_slider_idempotency_key(raw: &str) -> Result<String, SliderClaimError> {
    let key = raw.trim();
    if !(8..=128).contains(&key.len())
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(SliderClaimError::InvalidKey);
    }
    Ok(key.to_string())
}

pub fn normalize_slider_claim_binding(
    binding: &SliderClaimBinding,
) -> Result<SliderClaimBinding, SliderClaimError> {
    Ok(SliderClaimBinding {
        key: normalize_slider_idempotency_key(&binding.key)?,
        ..binding.clone()
    })
}

pub fn recovery_read_concern() -> ReadConcern {
    ReadConcern::majority()
}

pub fn generate_slider_claim_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

pub fn slider_claim_lease_expires_at(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis() + SLIDER_CLAIM_LEASE_SECONDS * 1000)
}

pub fn claim_binding_differs(left: &SliderClaimBinding, right: &SliderClaimBinding) -> bool {
    left != right
}

pub fn claim_binding_matches(existing: &Document, binding: &SliderClaimBinding) -> bool {
    existing.get_str("key").ok() == Some(binding.key.as_str())
        && existing.get_str("contractVersion").ok() == Some(binding.contract_version.as_str())
        && existing.get_object_id("operatorId").ok() == Some(binding.operator_id)
        && existing.get_str("action").ok() == Some(binding.action.as_str())
        && existing.get("targetId").is_some_and(|target| target == &binding.target_bson())
        && bson_i64(existing, "expectedRevision") == Some(binding.expected_revision)
        && existing.get_str("payloadDigest").ok() == Some(binding.payload_digest.as_str())
}

pub fn can_reclaim_slider_claim(existing: &Document, now: DateTime) -> bool {
    let state = existing.get_str("state").unwrap_or_default();
    if !matches!(state, SLIDER_CLAIM_STATE_IN_PROGRESS | SLIDER_CLAIM_STATE_RETRYABLE)
        || existing.get_bool("commitUnknown").unwrap_or(false)
        || existing.contains_key("transactionStartedAt")
        || existing.contains_key("responseBodyJson")
    {
        return false;
    }
    match existing.get_datetime("leaseExpiresAt") {
        Ok(expires) => expires.timestamp_millis() <= now.timestamp_millis(),
        Err(_) => state == SLIDER_CLAIM_STATE_RETRYABLE,
    }
}

pub fn frozen_slider_response(body: &Value) -> Result<String, SliderClaimError> {
    let mut frozen = body.clone();
    if let Some(object) = frozen.as_object_mut() {
        object.insert("replayed".to_string(), Value::Bool(false));
    }
    let encoded = serde_json::to_string(&frozen).map_err(|_| SliderClaimError::Storage)?;
    if encoded.len() > SLIDER_FROZEN_RESPONSE_MAX_BYTES {
        return Err(SliderClaimError::ResponseTooLarge);
    }
    Ok(encoded)
}

pub fn replay_slider_response(body: &Value) -> Value {
    let mut replay = body.clone();
    if let Some(object) = replay.as_object_mut() {
        object.insert("replayed".to_string(), Value::Bool(true));
    }
    replay
}

pub fn recovery_identifiers_update(ids: &SliderRecoveryIdentifiers) -> Document {
    let mut set = doc! {
        "auditEventId": ids.audit_event_id,
        "candidateResultRevision": ids.candidate_result_revision,
        "recoveryIdentifiersStored": true,
    };
    if let Some(candidate) = ids.candidate_slider_id {
        set.insert("candidateSliderId", candidate);
    }
    doc! { "$set": set }
}

pub fn recovery_identifiers_immutable_filter(binding: &SliderClaimBinding) -> Document {
    doc! {
        "key": &binding.key,
        "contractVersion": &binding.contract_version,
        "operatorId": binding.operator_id,
        "action": &binding.action,
        "targetId": binding.target_bson(),
        "expectedRevision": binding.expected_revision,
        "payloadDigest": &binding.payload_digest,
        "recoveryIdentifiersStored": { "$ne": true },
        "transactionStartedAt": { "$exists": false },
        "commitUnknown": { "$ne": true },
        "responseBodyJson": { "$exists": false },
    }
}

fn recovery_identifier_filter(ids: &SliderRecoveryIdentifiers) -> Document {
    let mut filter = doc! {
        "auditEventId": ids.audit_event_id,
        "candidateResultRevision": ids.candidate_result_revision,
        "recoveryIdentifiersStored": true,
    };
    if let Some(candidate) = ids.candidate_slider_id {
        filter.insert("candidateSliderId", candidate);
    } else {
        filter.insert("candidateSliderId", doc! { "$exists": false });
    }
    filter
}

pub fn slider_claim_fence_filter(
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
) -> Document {
    doc! {
        "_id": claim_id,
        "claimToken": claim_token,
        "key": &binding.key,
        "contractVersion": &binding.contract_version,
        "operatorId": binding.operator_id,
        "action": &binding.action,
        "targetId": binding.target_bson(),
        "expectedRevision": binding.expected_revision,
        "payloadDigest": &binding.payload_digest,
        "leaseGeneration": lease_generation as i64,
    }
}

/// Build the complete write-side fence predicate. Every identity and recovery field is matched
/// inside the transaction so a stale executor cannot perform a domain/reference/revision/audit
/// write after a lease takeover or claim completion.
pub fn slider_claim_fence_filter_with_recovery(
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
    identifiers: &SliderRecoveryIdentifiers,
) -> Document {
    let mut filter = slider_claim_fence_filter(claim_id, claim_token, binding, lease_generation);
    filter.extend(doc! {
        "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
        "commitUnknown": { "$ne": true },
        "transactionStartedAt": transaction_started_at,
        "responseBodyJson": { "$exists": false },
    });
    filter.extend(recovery_identifier_filter(identifiers));
    filter
}

/// Revalidate the durable claim fence using the same MongoDB session as the mutation writes.
/// A missing row is a fence loss, never permission to continue or to reclaim/re-execute.
pub async fn verify_slider_claim_fence_in_session(
    db: &Database,
    session: &mut ClientSession,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
    identifiers: &SliderRecoveryIdentifiers,
) -> Result<(), SliderClaimError> {
    let filter = slider_claim_fence_filter_with_recovery(
        claim_id,
        claim_token,
        binding,
        lease_generation,
        transaction_started_at,
        identifiers,
    );
    let claim = db
        .collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .find_one(filter)
        .session(&mut *session)
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    if claim.is_some() {
        Ok(())
    } else {
        Err(SliderClaimError::Fenced)
    }
}

pub fn commit_unknown_filter(
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
) -> Document {
    let mut filter = slider_claim_fence_filter(claim_id, claim_token, binding, lease_generation);
    filter.extend(doc! {
        "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
        "commitUnknown": { "$ne": true },
        "transactionStartedAt": transaction_started_at,
        "responseBodyJson": { "$exists": false },
    });
    filter
}

pub fn document_matches_commit_unknown(document: &Document, filter: &Document) -> bool {
    if document.get_str("state").ok() != Some(SLIDER_CLAIM_STATE_IN_PROGRESS)
        || document.get_bool("commitUnknown").unwrap_or(false)
        || document.contains_key("responseBodyJson")
    {
        return false;
    }
    exact_filter_fields_match(document, filter)
}

fn exact_filter_fields_match(document: &Document, filter: &Document) -> bool {
    for (key, expected) in filter {
        match expected {
            Bson::Document(condition) if condition.contains_key("$exists") => {
                let exists = document.contains_key(key);
                if condition.get_bool("$exists").unwrap_or(false) != exists {
                    return false;
                }
            }
            Bson::Document(condition) if condition.contains_key("$ne") => {
                if document.get(key) == condition.get("$ne") {
                    return false;
                }
            }
            Bson::Document(condition) if condition.contains_key("$in") => {
                let Some(values) = condition.get_array("$in").ok() else {
                    return false;
                };
                if !values.iter().any(|value| document.get(key) == Some(value)) {
                    return false;
                }
            }
            _ if document.get(key) != Some(expected) => return false,
            _ => {}
        }
    }
    true
}

pub async fn ensure_slider_claim_indexes(db: &Database) -> Result<(), SliderClaimError> {
    db.collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .create_indexes(slider_idempotency_index_models())
        .await
        .map_err(|_| SliderClaimError::IndexesNotReady)?;
    Ok(())
}

pub async fn begin_slider_claim(
    db: &Database,
    binding: &SliderClaimBinding,
) -> Result<SliderClaimBegin, SliderClaimError> {
    let binding = normalize_slider_claim_binding(binding)?;
    let now = DateTime::now();
    let claim_id = ObjectId::new();
    let claim_token = generate_slider_claim_token();
    let document = slider_claim_document(
        claim_id,
        &binding,
        &claim_token,
        1,
        now,
    );
    let claims = db.collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION);
    match claims
        .insert_one(document)
        .with_options(
            InsertOneOptions::builder()
                .write_concern(WriteConcern::majority())
                .build(),
        )
        .await
    {
        Ok(_) => Ok(SliderClaimBegin::Started {
            claim_id,
            claim_token,
            lease_generation: 1,
        }),
        Err(error) if is_duplicate_key_error(&error) => {
            let existing = claims
                .find_one(doc! { "key": &binding.key })
                .await
                .map_err(|_| SliderClaimError::Storage)?
                .ok_or(SliderClaimError::Storage)?;
            classify_existing_claim(&claims, existing, &binding, now).await
        }
        Err(_) => Err(SliderClaimError::Storage),
    }
}

async fn classify_existing_claim(
    claims: &mongodb::Collection<Document>,
    existing: Document,
    binding: &SliderClaimBinding,
    now: DateTime,
) -> Result<SliderClaimBegin, SliderClaimError> {
    if !claim_binding_matches(&existing, binding) {
        return Ok(SliderClaimBegin::Conflict);
    }
    if existing.get_str("state").ok() == Some(SLIDER_CLAIM_STATE_COMPLETED) {
        return completed_begin_from_document(&existing);
    }
    if existing.get_bool("commitUnknown").unwrap_or(false) {
        return Ok(SliderClaimBegin::CommitUnknown);
    }
    if !can_reclaim_slider_claim(&existing, now) {
        return Ok(SliderClaimBegin::InProgress);
    }

    let claim_id = existing
        .get_object_id("_id")
        .map_err(|_| SliderClaimError::Storage)?;
    let previous_token = existing
        .get_str("claimToken")
        .map_err(|_| SliderClaimError::Storage)?;
    let previous_generation = bson_i64(&existing, "leaseGeneration").unwrap_or(0);
    let next_generation = previous_generation.saturating_add(1);
    let next_token = generate_slider_claim_token();
    let filter = {
        let mut filter = slider_claim_fence_filter(
            claim_id,
            previous_token,
            binding,
            previous_generation as u64,
        );
        filter.extend(doc! {
            "state": { "$in": [SLIDER_CLAIM_STATE_IN_PROGRESS, SLIDER_CLAIM_STATE_RETRYABLE] },
            "leaseExpiresAt": { "$lte": now },
            "commitUnknown": { "$ne": true },
            "transactionStartedAt": { "$exists": false },
            "responseBodyJson": { "$exists": false },
        });
        filter
    };
    let mut update = doc! {
        "$set": {
            "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
            "claimToken": &next_token,
            "leaseGeneration": next_generation,
            "claimedAt": now,
            "leaseExpiresAt": slider_claim_lease_expires_at(now),
            "updatedAt": now,
            "commitUnknown": false,
        },
        "$unset": {
            "transactionStartedAt": "",
        },
    };
    // An unset is intentionally explicit: stale pre-transaction claims may be retried, but a
    // fenced claim can never reach this branch because the filter rejects transactionStartedAt.
    let updated = claims
        .update_one(filter, UpdateModifications::Document(std::mem::take(&mut update)))
        .with_options(
            UpdateOptions::builder()
                .write_concern(WriteConcern::majority())
                .build(),
        )
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    if updated.matched_count != 1 {
        return Ok(SliderClaimBegin::InProgress);
    }
    Ok(SliderClaimBegin::Started {
        claim_id,
        claim_token: next_token,
        lease_generation: next_generation as u64,
    })
}

pub async fn store_recovery_identifiers(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    identifiers: &SliderRecoveryIdentifiers,
) -> Result<bool, SliderClaimError> {
    let mut filter = slider_claim_fence_filter(claim_id, claim_token, binding, lease_generation);
    filter.extend(recovery_identifiers_immutable_filter(binding));
    filter.insert("_id", claim_id);
    filter.insert("claimToken", claim_token);
    filter.insert("leaseGeneration", lease_generation as i64);
    let result = db
        .collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .update_one(filter, recovery_identifiers_update(identifiers))
        .with_options(
            UpdateOptions::builder()
                .write_concern(WriteConcern::majority())
                .build(),
        )
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

pub async fn mark_slider_transaction_started(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    identifiers: &SliderRecoveryIdentifiers,
) -> Result<bool, SliderClaimError> {
    let now = DateTime::now();
    let mut filter = slider_claim_fence_filter(claim_id, claim_token, binding, lease_generation);
    filter.extend(doc! {
        "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
        "commitUnknown": { "$ne": true },
        "transactionStartedAt": { "$exists": false },
        "responseBodyJson": { "$exists": false },
    });
    filter.extend(recovery_identifier_filter(identifiers));
    let result = db
        .collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .update_one(
            filter,
            doc! {
                "$set": {
                    "transactionStartedAt": now,
                    "updatedAt": now,
                },
                "$unset": { "leaseExpiresAt": "" },
            },
        )
        .with_options(
            UpdateOptions::builder()
                .write_concern(WriteConcern::majority())
                .build(),
        )
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

pub fn completion_filter(
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
) -> Document {
    let mut filter = slider_claim_fence_filter(claim_id, claim_token, binding, lease_generation);
    filter.extend(doc! {
        "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
        "commitUnknown": { "$ne": true },
        "transactionStartedAt": transaction_started_at,
        "responseBodyJson": { "$exists": false },
    });
    filter
}

pub async fn complete_slider_claim_in_session(
    db: &Database,
    session: &mut ClientSession,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
    response_status: u16,
    response_body: &Value,
    result_revision: i64,
    audit_event_id: ObjectId,
) -> Result<(), SliderClaimError> {
    let body = frozen_slider_response(response_body)?;
    let update = doc! {
        "$set": {
            "state": SLIDER_CLAIM_STATE_COMPLETED,
            "responseStatus": i32::from(response_status),
            "responseBodyJson": body,
            "resultRevision": result_revision,
            "auditEventId": audit_event_id,
            "completedAt": DateTime::now(),
            "updatedAt": DateTime::now(),
            "commitUnknown": false,
        },
        "$unset": { "leaseExpiresAt": "" },
    };
    let result = db
        .collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .update_one(
            completion_filter(
                claim_id,
                claim_token,
                binding,
                lease_generation,
                transaction_started_at,
            ),
            update,
        )
        .session(&mut *session)
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    if result.matched_count != 1 {
        return Err(SliderClaimError::Fenced);
    }
    Ok(())
}

pub async fn mark_slider_commit_unknown_conditionally(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    transaction_started_at: DateTime,
) -> Result<bool, SliderClaimError> {
    let result = db
        .collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION)
        .update_one(
            commit_unknown_filter(
                claim_id,
                claim_token,
                binding,
                lease_generation,
                transaction_started_at,
            ),
            doc! {
                "$set": {
                    "commitUnknown": true,
                    "updatedAt": DateTime::now(),
                },
            },
        )
        .with_options(
            UpdateOptions::builder()
                .write_concern(WriteConcern::majority())
                .build(),
        )
        .await
        .map_err(|_| SliderClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

/// Read bounded evidence and classify an interrupted commit.  Domain/audit evidence can support
/// investigation, but only a matching frozen response is a successful completion proof.
pub fn recover_slider_commit_from_evidence(
    binding: &SliderClaimBinding,
    evidence: &SliderRecoveryEvidence,
) -> SliderCommitRecovery {
    let Some(claim) = evidence.claim.as_ref() else {
        return SliderCommitRecovery::CommitUnknown;
    };
    if !claim_binding_matches(claim, binding)
        || evidence
            .claim_token
            .as_deref()
            .is_some_and(|token| claim.get_str("claimToken").ok() != Some(token))
        || evidence.lease_generation.is_some_and(|generation| {
            bson_i64(claim, "leaseGeneration") != Some(generation as i64)
        })
    {
        return SliderCommitRecovery::CommitUnknown;
    }
    if claim.get_str("state").ok() == Some(SLIDER_CLAIM_STATE_COMPLETED) {
        return match completed_recovery_from_document(claim) {
            SliderCommitRecovery::Completed {
                status,
                body,
                result_revision,
            } => SliderCommitRecovery::Completed {
                status,
                body: replay_slider_response(&body),
                result_revision,
            },
            SliderCommitRecovery::CommitUnknown => SliderCommitRecovery::CommitUnknown,
        };
    }
    // A durable fence plus incomplete proof is permanently ambiguous.  Even a proven absence of
    // domain rows is not permission to execute the same key again.
    SliderCommitRecovery::CommitUnknown
}

/// Mongo read-side recovery primitive. It performs only bounded reads and returns a conservative
/// classification; the caller must not pass a mutation closure here.
pub async fn recover_slider_commit(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SliderClaimBinding,
    lease_generation: u64,
    identifiers: &SliderRecoveryIdentifiers,
) -> Result<SliderCommitRecovery, SliderClaimError> {
    let claims = db.collection::<Document>(SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION);
    let recovery_options = FindOneOptions::builder()
        .read_concern(recovery_read_concern())
        .build();
    let Some(claim) = claims
        .find_one(slider_claim_fence_filter(
            claim_id,
            claim_token,
            binding,
            lease_generation,
        ))
        .with_options(recovery_options.clone())
        .await
        .map_err(|_| SliderClaimError::Storage)?
    else {
        return Ok(SliderCommitRecovery::CommitUnknown);
    };
    let mut evidence = SliderRecoveryEvidence {
        claim: Some(claim),
        claim_id: Some(claim_id),
        claim_token: Some(claim_token.to_string()),
        lease_generation: Some(lease_generation),
        recovery_ids: Some(identifiers.clone()),
        ..Default::default()
    };
    // A completed claim is the primary proof and avoids broad domain scans.
    if let Some(claim) = evidence.claim.as_ref() {
        if claim.get_str("state").ok() == Some(SLIDER_CLAIM_STATE_COMPLETED) {
            return Ok(recover_slider_commit_from_evidence(binding, &evidence));
        }
    }
    // Domain and audit reads are intentionally bounded to the preallocated identities. They are
    // supporting evidence only; without a frozen response the result remains unknown.
    let sliders = db.collection::<Document>("sliders");
    if let Some(candidate) = identifiers.candidate_slider_id {
        evidence.domain = sliders
            .find_one(doc! { "_id": candidate })
            .with_options(recovery_options.clone())
            .await
            .ok()
            .flatten();
    }
    let audits = db.collection::<Document>("slideraudits");
    evidence.audit = audits
        .find_one(doc! { "_id": identifiers.audit_event_id })
        .with_options(recovery_options.clone())
        .await
        .ok()
        .flatten();
    let metadata = db.collection::<Document>("slidermetadata");
    evidence.current_revision = metadata
        .find_one(doc! { "_id": "global" })
        .with_options(recovery_options)
        .await
        .ok()
        .flatten()
        .and_then(|document| bson_i64(&document, "revision"));
    Ok(recover_slider_commit_from_evidence(binding, &evidence))
}

fn slider_claim_document(
    claim_id: ObjectId,
    binding: &SliderClaimBinding,
    token: &str,
    lease_generation: i64,
    now: DateTime,
) -> Document {
    doc! {
        "_id": claim_id,
        "key": &binding.key,
        "contractVersion": &binding.contract_version,
        "operatorId": binding.operator_id,
        "action": &binding.action,
        "targetId": binding.target_bson(),
        "expectedRevision": binding.expected_revision,
        "payloadDigest": &binding.payload_digest,
        "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
        "leaseGeneration": lease_generation,
        "claimToken": token,
        "claimedAt": now,
        "leaseExpiresAt": slider_claim_lease_expires_at(now),
        "commitUnknown": false,
        "createdAt": now,
        "updatedAt": now,
    }
}

fn completed_begin_from_document(document: &Document) -> Result<SliderClaimBegin, SliderClaimError> {
    let completed = completed_recovery_from_document(document);
    let SliderCommitRecovery::Completed {
        status,
        body,
        result_revision,
    } = completed
    else {
        return Ok(SliderClaimBegin::CommitUnknown);
    };
    Ok(SliderClaimBegin::Completed {
        status,
        body: replay_slider_response(&body),
        result_revision,
    })
}

fn completed_recovery_from_document(document: &Document) -> SliderCommitRecovery {
    let Some(raw) = document.get_str("responseBodyJson").ok() else {
        return SliderCommitRecovery::CommitUnknown;
    };
    let Ok(body) = serde_json::from_str::<Value>(raw) else {
        return SliderCommitRecovery::CommitUnknown;
    };
    SliderCommitRecovery::Completed {
        status: bson_i64(document, "responseStatus")
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(200),
        body,
        result_revision: bson_i64(document, "resultRevision"),
    }
}

fn bson_i64(document: &Document, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) if value.is_finite() && value.fract() == 0.0 => Some(*value as i64),
        _ => None,
    }
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    error.to_string().contains("E11000")
}

#[allow(dead_code)]
fn _keep_foundation_types_linked(_: &PublicSliderItem, _: &str) {
    // PublicSliderItem remains a read-only DTO; this function intentionally has no mutation path.
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding() -> SliderClaimBinding {
        SliderClaimBinding {
            key: "slider_test_key_01".to_string(),
            contract_version: SLIDER_MUTATION_CONTRACT.to_string(),
            operator_id: ObjectId::new(),
            action: "update".to_string(),
            target_id: Some(ObjectId::new()),
            expected_revision: 7,
            payload_digest: "digest-1".to_string(),
        }
    }

    fn fixture_claim(extra: Document) -> Document {
        fixture_claim_for(&binding(), extra)
    }

    fn fixture_claim_for(value: &SliderClaimBinding, extra: Document) -> Document {
        let mut claim = doc! {
            "_id": ObjectId::new(),
            "key": &value.key,
            "contractVersion": &value.contract_version,
            "operatorId": value.operator_id,
            "action": &value.action,
            "targetId": value.target_bson(),
            "expectedRevision": value.expected_revision,
            "payloadDigest": &value.payload_digest,
            "state": SLIDER_CLAIM_STATE_IN_PROGRESS,
            "leaseGeneration": 1_i64,
            "claimToken": "token-1",
            "claimedAt": DateTime::now(),
            "leaseExpiresAt": DateTime::from_millis(0),
            "commitUnknown": false,
        };
        for (key, value) in extra {
            claim.insert(key, value);
        }
        claim
    }

    #[test]
    fn normalized_binding_trims_key_before_claim_lookup() {
        let mut value = binding();
        value.key = "  slider_test_key_01  ".to_string();
        let normalized = normalize_slider_claim_binding(&value).unwrap();
        assert_eq!(normalized.key, "slider_test_key_01");
        assert_eq!(normalized.operator_id, value.operator_id);
        assert_eq!(normalized.target_id, value.target_id);
    }

    #[test]
    fn recovery_reads_require_majority_concern() {
        assert_eq!(recovery_read_concern(), ReadConcern::majority());
    }

    #[test]
    fn evidence_recovery_marks_completed_response_as_replayed() {
        let value = binding();
        let claim = fixture_claim_for(&value, doc! {
            "state": SLIDER_CLAIM_STATE_COMPLETED,
            "responseStatus": 200_i32,
            "responseBodyJson": "{\"ok\":true,\"replayed\":false}",
            "resultRevision": 8_i64,
            "transactionStartedAt": DateTime::now(),
        });
        let outcome = recover_slider_commit_from_evidence(
            &value,
            &SliderRecoveryEvidence {
                claim: Some(claim),
                claim_token: Some("token-1".to_string()),
                lease_generation: Some(1),
                ..Default::default()
            },
        );
        let SliderCommitRecovery::Completed { body, .. } = outcome else {
            panic!("expected completed recovery");
        };
        assert_eq!(body["replayed"], true);
    }

    #[test]
    fn claim_indexes_are_permanent_and_exact() {
        let models = slider_idempotency_index_models();
        let key = models
            .iter()
            .find(|model| model.keys == doc! { "key": 1 })
            .unwrap();
        assert_eq!(key.options.as_ref().and_then(|options| options.unique), Some(true));
        assert!(models
            .iter()
            .all(|model| model.options.as_ref().and_then(|options| options.expire_after).is_none()));
        assert!(models.iter().any(|model| model.keys == doc! { "state": 1, "leaseExpiresAt": 1 }));
        assert!(models
            .iter()
            .any(|model| model.keys == doc! { "commitUnknown": 1, "transactionStartedAt": 1 }));
    }

    #[test]
    fn binding_includes_action_target_and_contract_version() {
        let value = binding();
        let base = canonical_slider_claim_input(&value, &json!({"name": "Promo"}));
        let digest = canonical_slider_claim_digest(&base);
        for variant in [
            SliderClaimBinding { action: "archive".into(), ..value.clone() },
            SliderClaimBinding { target_id: None, ..value.clone() },
            SliderClaimBinding { contract_version: "slider-revision-v2".into(), ..value.clone() },
            SliderClaimBinding { payload_digest: "digest-2".into(), ..value.clone() },
        ] {
            assert!(claim_binding_differs(&value, &variant));
            if variant.payload_digest == value.payload_digest {
                assert_ne!(
                    digest,
                    canonical_slider_claim_digest(&canonical_slider_claim_input(&variant, &json!({"name": "Promo"})))
                );
            }
        }
        assert_eq!(base["targetId"], json!(value.target_id.unwrap().to_hex()));
    }

    #[test]
    fn fenced_claim_is_never_reclaimable_even_after_proven_non_commit() {
        let claim = fixture_claim(doc! {
            "transactionStartedAt": DateTime::now(),
            "commitUnknown": false,
        });
        assert!(!can_reclaim_slider_claim(&claim, DateTime::from_millis(i64::MAX)));
    }

    #[test]
    fn recovery_ids_are_immutable_and_create_has_candidate_slider_id() {
        let ids = SliderRecoveryIdentifiers {
            candidate_slider_id: Some(ObjectId::new()),
            audit_event_id: ObjectId::new(),
            candidate_result_revision: 8,
        };
        let update = recovery_identifiers_update(&ids);
        assert_eq!(update.get_document("$set").unwrap().len(), 4);
        let filter = recovery_identifiers_immutable_filter(&binding());
        assert_eq!(filter.get_document("recoveryIdentifiersStored").unwrap().get_bool("$ne"), Ok(true));
        assert!(ids.candidate_slider_id.is_some());
    }

    #[test]
    fn frozen_response_has_exact_256_kib_boundary_and_replay_only_toggles_flag() {
        let boundary = Value::String("x".repeat(SLIDER_FROZEN_RESPONSE_MAX_BYTES - 2));
        assert_eq!(frozen_slider_response(&boundary).unwrap().len(), SLIDER_FROZEN_RESPONSE_MAX_BYTES);
        let body = json!({"data": "x", "replayed": false});
        let replay = replay_slider_response(&body);
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["data"], body["data"]);
        let oversized = Value::String("x".repeat(SLIDER_FROZEN_RESPONSE_MAX_BYTES - 1));
        assert_eq!(frozen_slider_response(&oversized).unwrap_err(), SliderClaimError::ResponseTooLarge);
    }

    #[test]
    fn conditional_commit_unknown_filter_is_fenced_and_excludes_completed_result() {
        let value = binding();
        let filter = commit_unknown_filter(ObjectId::new(), "token-1", &value, 4, DateTime::from_millis(10));
        assert_eq!(filter.get_str("claimToken").unwrap(), "token-1");
        assert_eq!(filter.get_i64("leaseGeneration").unwrap(), 4_i64);
        assert!(filter.get("transactionStartedAt").is_some());
        assert!(filter.get_document("responseBodyJson").is_ok());
        assert!(filter.get("state").is_some());
    }

    #[test]
    fn write_fence_filter_revalidates_every_execution_identity_field() {
        let value = binding();
        let ids = SliderRecoveryIdentifiers {
            candidate_slider_id: Some(ObjectId::new()),
            audit_event_id: ObjectId::new(),
            candidate_result_revision: 8,
        };
        let started_at = DateTime::from_millis(10);
        let filter = slider_claim_fence_filter_with_recovery(
            ObjectId::new(),
            "token-1",
            &value,
            4,
            started_at,
            &ids,
        );
        assert_eq!(filter.get_str("claimToken"), Ok("token-1"));
        assert_eq!(filter.get_i64("leaseGeneration"), Ok(4));
        assert_eq!(filter.get_datetime("transactionStartedAt"), Ok(&started_at));
        assert_eq!(filter.get_object_id("auditEventId"), Ok(ids.audit_event_id));
        assert_eq!(filter.get_i64("candidateResultRevision"), Ok(8));
        assert_eq!(filter.get_object_id("candidateSliderId"), Ok(ids.candidate_slider_id.unwrap()));
        assert_eq!(filter.get_str("state"), Ok(SLIDER_CLAIM_STATE_IN_PROGRESS));
        assert!(filter.get_document("responseBodyJson").is_ok());
        assert!(filter.get_document("commitUnknown").is_ok());
    }

    #[test]
    fn completed_claim_cannot_be_overwritten_by_commit_unknown() {
        let value = binding();
        let mut completed = fixture_claim_for(&value, doc! {
            "state": SLIDER_CLAIM_STATE_COMPLETED,
            "responseBodyJson": "{\"replayed\":false}",
            "transactionStartedAt": DateTime::now(),
        });
        let filter = commit_unknown_filter(
            completed.get_object_id("_id").unwrap(),
            "token-1",
            &value,
            1,
            *completed.get_datetime("transactionStartedAt").unwrap(),
        );
        assert!(!document_matches_commit_unknown(&completed, &filter));
        completed.remove("responseBodyJson");
        completed.insert("state", SLIDER_CLAIM_STATE_IN_PROGRESS);
        assert!(document_matches_commit_unknown(&completed, &filter));
    }

    #[test]
    fn ambiguous_recovery_is_conservative_without_complete_proof() {
        let outcome = recover_slider_commit_from_evidence(&binding(), &SliderRecoveryEvidence::default());
        assert_eq!(outcome, SliderCommitRecovery::CommitUnknown);
    }

    #[test]
    fn unresolved_recovery_stays_unknown_even_with_domain_and_audit_evidence() {
        let value = binding();
        let claim = fixture_claim_for(&value, doc! {
            "transactionStartedAt": DateTime::now(),
        });
        let outcome = recover_slider_commit_from_evidence(
            &value,
            &SliderRecoveryEvidence {
                claim: Some(claim),
                domain: Some(doc! {"_id": ObjectId::new()}),
                audit: Some(doc! {"_id": ObjectId::new()}),
                current_revision: Some(8),
                ..Default::default()
            },
        );
        assert_eq!(outcome, SliderCommitRecovery::CommitUnknown);
    }
}
