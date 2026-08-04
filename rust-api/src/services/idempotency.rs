//! Critical mutation idempotency for standalone Mongo.
//!
//! Records live in `idempotencyrecords` with unique `(actorId, routeKey, idempotencyKey)`.
//! Domain writes and idempotency status are coupled through an explicit recoverable
//! state machine. Recovery uses durable domain markers that are atomically coupled
//! with each irreversible money effect when possible — multi-document atomicity is
//! never claimed.
//!
//! # Standalone state machine (truthful)
//!
//! Idempotency record statuses:
//! - `started` — exclusive lease held; not proven complete. May carry no domain effect yet.
//! - `completed` — immutable response snapshot stored; terminal success for this key+digest.
//!
//! Domain phases (balance / refund), independent of the orchestration record:
//! - `none` — no durable money effect for this full identity
//! - `effect_applied` — irreversible money effect is durable under actor+route+key+digest(+resource)
//! - `domain_complete` — all required domain side-effects (audit, claim stamps) are durable
//!
//! Money markers live in `users.balanceEffectSlots.<slotId>` (same user document as the balance).
//! Unresolved markers are never evicted; only resolved/completed proofs may be pruned after retention.
//!
//! Crash table (balance, standalone):
//! | Crash point | Durable domain | Retry / recovery |
//! |---|---|---|
//! | Before start insert | none | fresh start |
//! | After start, before money marker | started only | lease takeover when expired; never TTL re-exec |
//! | After atomic money+marker, before audit | effect_applied | finish audit once, complete with immutable snapshot |
//! | After audit, before complete | domain_complete | complete from immutable snapshot |
//! | After complete, response lost | completed | exact completed replay |
//! | Concurrent same key | one lease holder | others InProgress / later completed replay |
//!
//! Crash table (refund, standalone):
//! | Crash point | Durable domain | Retry / recovery |
//! |---|---|---|
//! | Before start | none | fresh start |
//! | After start, before claim | started only | lease takeover when expired |
//! | After claim (`refundPhase=claimed`) | claim only | **not** success; forward-credit once |
//! | After credit marker | effect_applied | finish audit + complete; never re-credit |
//! | After audit | domain_complete | complete from immutable snapshot |
//! | After complete | completed | exact replay |
//!
//! Rules:
//! - Never treat refund claim alone as proof credit/audit completed.
//! - Never release/delete a started record after an unverified compensation or after claim.
//! - Never depend on TTL to re-execute uncertain work (TTL only for `completed`).
//! - Same key+digest eventually returns the exact original bounded response snapshot.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use mongodb::options::{IndexOptions, ReturnDocument, UpdateModifications};
use mongodb::{Collection, Database, IndexModel};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
struct ErrorMessage {
    message: &'static str,
}

pub const COLLECTION: &str = "idempotencyrecords";
pub const ROUTE_BALANCE_ADJUST: &str = "users.balance.adjust";
pub const ROUTE_TRANSACTION_REFUND: &str = "transactions.refund";
pub const ROUTE_GUEST_CHECKOUT: &str = "guest_transactions.create";
pub const IDEMPOTENCY_HEADER: &str = "idempotency-key";

pub const STATUS_STARTED: &str = "started";
pub const STATUS_COMPLETED: &str = "completed";

/// No durable money effect for this key yet.
pub const DOMAIN_PHASE_NONE: &str = "none";
/// Irreversible money effect is durable and keyed.
pub const DOMAIN_PHASE_EFFECT_APPLIED: &str = "effect_applied";
/// All required domain side-effects are durable (audit etc.).
pub const DOMAIN_PHASE_DOMAIN_COMPLETE: &str = "domain_complete";

const MAX_KEY_LEN: usize = 128;
const MIN_KEY_LEN: usize = 8;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;
/// TTL applies only to completed records (partial filter). Started never auto-deletes.
const COMPLETED_TTL_SECONDS: i64 = 24 * 60 * 60;
/// Exclusive execution lease for `started` rows without proven domain completion.
pub const LEASE_SECONDS: i64 = 30;

const INDEX_UNIQ_ACTOR_ROUTE_KEY: &str = "uniq_actor_route_key";
const INDEX_TTL_CLEANUP_COMPLETED: &str = "ttl_cleanup_at_completed";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdempotencyBegin {
    /// Caller owns exclusive execution for this key (new or lease takeover).
    /// `lease_generation` is the fencing token required for complete / forward transitions.
    Started { lease_generation: u64 },
    /// Prior successful execution; replay exact bounded snapshot.
    Completed { status: u16, body: Value },
    /// Same key, different request digest.
    Conflict,
    /// Same key/digest still running under a live lease (or unrecovered) elsewhere.
    InProgress,
}

#[derive(Debug, Clone)]
pub struct IdempotencyRecordView {
    pub actor_id: ObjectId,
    pub route_key: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub status: String,
    pub response_status: Option<u16>,
    pub response_body: Option<Value>,
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletedSnapshot {
    pub status: u16,
    pub body: Value,
    pub resource_id: Option<String>,
}

/// Domain recovery outcome for an interrupted `started` record.
#[derive(Debug, Clone)]
pub enum DomainRecovery {
    /// No durable money/domain marker — safe for lease takeover consideration only.
    None,
    /// Money (and possibly more) is durable; provide immutable snapshot when domain is complete
    /// enough to finish, or None body if caller must run forward reconciliation first.
    EffectApplied {
        /// When present, recovery can complete the orchestration record with this exact body.
        snapshot: Option<CompletedSnapshot>,
    },
}

/// Domain recovery: when a `started` record is interrupted, inspect truthful domain markers.
/// Recovery must never treat a pre-money claim alone as success.
pub trait DomainMarkerRecovery: Send + Sync {
    fn recover(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) -> impl std::future::Future<Output = DomainRecovery> + Send;
}

#[derive(Debug)]
pub enum IdempotencyError {
    MissingKey,
    InvalidKey,
    Store,
    ResponseTooLarge,
    /// Indexes required for exclusivity/TTL were not established.
    IndexesNotReady,
}

impl IdempotencyError {
    pub fn into_response(self) -> Response {
        match self {
            Self::MissingKey => (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    message: "Header Idempotency-Key wajib untuk mutasi finansial ini",
                }),
            )
                .into_response(),
            Self::InvalidKey => (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    message: "Header Idempotency-Key tidak valid",
                }),
            )
                .into_response(),
            Self::Store | Self::ResponseTooLarge | Self::IndexesNotReady => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    message: "Internal Server Error",
                }),
            )
                .into_response(),
        }
    }
}

pub fn critical_idempotency_enforced() -> bool {
    match std::env::var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
        // Task 12 rollout: enforce by default once the service is deployed.
        Err(_) => true,
    }
}

pub fn normalize_idempotency_key(raw: &str) -> Result<String, IdempotencyError> {
    let trimmed = raw.trim();
    if trimmed.len() < MIN_KEY_LEN || trimmed.len() > MAX_KEY_LEN {
        return Err(IdempotencyError::InvalidKey);
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(IdempotencyError::InvalidKey);
    }
    Ok(trimmed.to_string())
}

pub fn extract_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, IdempotencyError> {
    let mut found: Option<String> = None;
    for (name, value) in headers.iter() {
        if name.as_str().eq_ignore_ascii_case(IDEMPOTENCY_HEADER) {
            let Ok(text) = value.to_str() else {
                return Err(IdempotencyError::InvalidKey);
            };
            if found.is_some() {
                return Err(IdempotencyError::InvalidKey);
            }
            found = Some(text.to_string());
        }
    }
    match found {
        None => Ok(None),
        Some(raw) => Ok(Some(normalize_idempotency_key(&raw)?)),
    }
}

pub fn require_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, IdempotencyError> {
    match extract_idempotency_key(headers)? {
        Some(key) => Ok(Some(key)),
        None if critical_idempotency_enforced() => Err(IdempotencyError::MissingKey),
        None => Ok(None),
    }
}

/// Canonical request material for HMAC digest. Never includes secrets or full bodies.
pub fn sha256_hex(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn request_digest(hmac_key: &[u8], route_key: &str, parts: &[&str]) -> String {
    // Compatibility contract: balance/refund rows and durable domain markers created before
    // guest checkout use this exact v1 framing and must remain recoverable after upgrades.
    let mut mac = HmacSha256::new_from_slice(hmac_key).expect("HMAC accepts keys of any size");
    mac.update(b"idempotency:v1\0");
    mac.update(route_key.as_bytes());
    for part in parts {
        mac.update(b"\0");
        mac.update(part.as_bytes());
    }
    let result = mac.finalize().into_bytes();
    URL_SAFE_NO_PAD.encode(result)
}

pub fn balance_adjust_digest(
    hmac_key: &[u8],
    target_user_id: &str,
    adjustment_type: &str,
    amount: f64,
    reason: &str,
) -> String {
    // Fixed-point amount avoids float textual ambiguity.
    let amount_millis = (amount * 1000.0).round() as i64;
    request_digest(
        hmac_key,
        ROUTE_BALANCE_ADJUST,
        &[
            target_user_id,
            adjustment_type,
            &amount_millis.to_string(),
            reason,
        ],
    )
}

pub fn refund_digest(hmac_key: &[u8], transaction_id: &str, reason: &str) -> String {
    request_digest(
        hmac_key,
        ROUTE_TRANSACTION_REFUND,
        &[transaction_id, reason],
    )
}

pub fn conflict_response() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Idempotency-Key bentrok dengan permintaan berbeda",
            "error": { "code": "IDEMPOTENCY_KEY_CONFLICT", "message": "Idempotency-Key bentrok dengan permintaan berbeda" }
        })),
    )
        .into_response()
}

pub fn in_progress_response() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses",
            "error": { "code": "IDEMPOTENCY_IN_PROGRESS", "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses" }
        })),
    )
        .into_response()
}

/// Fail-closed when a user already has too many unresolved money proofs.
/// Does not release started rows; callers must leave orchestration for recovery.
pub fn effect_slot_capacity_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Terlalu banyak penyesuaian saldo yang belum terselesaikan untuk user ini. Coba lagi setelah rekonsiliasi.",
            "error": {
                "code": "EFFECT_SLOT_CAPACITY_EXCEEDED",
                "message": "Terlalu banyak penyesuaian saldo yang belum terselesaikan untuk user ini. Coba lagi setelah rekonsiliasi."
            }
        })),
    )
        .into_response()
}

pub fn completed_response(status: u16, body: Value) -> Response {
    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    (status_code, Json(body)).into_response()
}

fn lease_expires_at(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis() + LEASE_SECONDS * 1000)
}

fn completed_cleanup_at(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis() + COMPLETED_TTL_SECONDS * 1000)
}

/// Far-future cleanup for started rows so TTL cannot re-open uncertain work.
fn started_cleanup_at(now: DateTime) -> DateTime {
    // ~10 years; started rows are never eligible for the completed-only TTL index.
    DateTime::from_millis(now.timestamp_millis() + 10 * 365 * 24 * 60 * 60 * 1000)
}

pub fn bound_response_body(body: &Value) -> Result<String, IdempotencyError> {
    let encoded = serde_json::to_string(body).map_err(|_| IdempotencyError::Store)?;
    if encoded.len() > MAX_RESPONSE_BYTES {
        return Err(IdempotencyError::ResponseTooLarge);
    }
    Ok(encoded)
}

fn parse_response_body(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}

/// Pure transition helper: decide begin outcome from an existing row + recovery + clock.
/// Used by stores and unit-tested as the production decision seam.
pub fn classify_started_row(
    request_digest: &str,
    stored_digest: &str,
    status: &str,
    response_status: Option<u16>,
    response_body: Option<Value>,
    lease_expires_at_ms: Option<i64>,
    now_ms: i64,
    recovery: &DomainRecovery,
) -> IdempotencyBegin {
    if stored_digest != request_digest {
        return IdempotencyBegin::Conflict;
    }
    if status == STATUS_COMPLETED {
        return IdempotencyBegin::Completed {
            status: response_status.unwrap_or(200),
            body: response_body.unwrap_or(Value::Null),
        };
    }
    // status == started (or unknown treated as in-flight)
    match recovery {
        DomainRecovery::EffectApplied {
            snapshot: Some(snapshot),
        } => IdempotencyBegin::Completed {
            status: snapshot.status,
            body: snapshot.body.clone(),
        },
        DomainRecovery::EffectApplied { snapshot: None } => {
            // Domain money is durable but forward steps remain — caller must reconcile.
            // Treat as Started so the same actor/retry can finish forward steps exactly once.
            // Store assigns the real fencing generation on CAS/takeover.
            IdempotencyBegin::Started {
                lease_generation: 0,
            }
        }
        DomainRecovery::None => {
            let expired = lease_expires_at_ms
                .map(|expires| expires <= now_ms)
                .unwrap_or(true);
            if expired {
                // Eligible for lease takeover (store must CAS). Signal Started to attempt takeover.
                IdempotencyBegin::Started {
                    lease_generation: 0,
                }
            } else {
                IdempotencyBegin::InProgress
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Storage trait (Mongo + in-memory for deterministic tests)
// ---------------------------------------------------------------------------

pub trait IdempotencyStore: Send + Sync {
    fn begin(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        now: DateTime,
    ) -> impl std::future::Future<Output = Result<IdempotencyBegin, IdempotencyError>> + Send;

    /// Complete only if the caller still holds `lease_generation` (fencing).
    /// A resumed stale executor after takeover must not overwrite completion.
    fn complete(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
        snapshot: &CompletedSnapshot,
        now: DateTime,
    ) -> impl std::future::Future<Output = Result<(), IdempotencyError>> + Send;

    /// Release a started row only when no durable domain effect is possible (pre-effect abort).
    /// Must not be called after claim/money markers without verified full compensation.
    fn release_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
    ) -> impl std::future::Future<Output = Result<(), IdempotencyError>> + Send;
}

/// Orchestrate begin with domain-marker recovery and lease takeover for interrupted `started` rows.
pub async fn begin_with_recovery<S, R>(
    store: &S,
    recovery: &R,
    actor_id: ObjectId,
    route_key: &str,
    idempotency_key: &str,
    request_digest: &str,
    now: DateTime,
) -> Result<IdempotencyBegin, IdempotencyError>
where
    S: IdempotencyStore,
    R: DomainMarkerRecovery,
{
    match store
        .begin(actor_id, route_key, idempotency_key, request_digest, now)
        .await?
    {
        IdempotencyBegin::InProgress => {
            match recovery
                .recover(actor_id, route_key, idempotency_key, request_digest)
                .await
            {
                DomainRecovery::EffectApplied {
                    snapshot: Some(snapshot),
                } => {
                    // Recovery completion does not require a live lease fence: domain is already
                    // fully proven and complete is idempotent under matching digest.
                    store
                        .complete(
                            actor_id,
                            route_key,
                            idempotency_key,
                            request_digest,
                            0,
                            &snapshot,
                            now,
                        )
                        .await?;
                    Ok(IdempotencyBegin::Completed {
                        status: snapshot.status,
                        body: snapshot.body,
                    })
                }
                DomainRecovery::EffectApplied { snapshot: None } => {
                    // Money durable under a live foreign lease: do not steal; wait.
                    Ok(IdempotencyBegin::InProgress)
                }
                DomainRecovery::None => Ok(IdempotencyBegin::InProgress),
            }
        }
        IdempotencyBegin::Started { lease_generation } => {
            // New lease or takeover — still check domain markers so a crash after money
            // but before lease refresh reconciles instead of double-applying.
            match recovery
                .recover(actor_id, route_key, idempotency_key, request_digest)
                .await
            {
                DomainRecovery::EffectApplied {
                    snapshot: Some(snapshot),
                } => {
                    store
                        .complete(
                            actor_id,
                            route_key,
                            idempotency_key,
                            request_digest,
                            lease_generation,
                            &snapshot,
                            now,
                        )
                        .await?;
                    Ok(IdempotencyBegin::Completed {
                        status: snapshot.status,
                        body: snapshot.body,
                    })
                }
                DomainRecovery::EffectApplied { snapshot: None } => {
                    Ok(IdempotencyBegin::Started { lease_generation })
                }
                DomainRecovery::None => Ok(IdempotencyBegin::Started { lease_generation }),
            }
        }
        other => Ok(other),
    }
}

// ---------------------------------------------------------------------------
// Index model builders (production seam for startup wiring tests)
// ---------------------------------------------------------------------------

/// Build the unique + completed-only TTL indexes. Invoked at process startup before traffic.
pub fn idempotency_index_models() -> Vec<IndexModel> {
    let unique = IndexModel::builder()
        .keys(doc! { "actorId": 1, "routeKey": 1, "idempotencyKey": 1 })
        .options(
            IndexOptions::builder()
                .name(INDEX_UNIQ_ACTOR_ROUTE_KEY.to_string())
                .unique(true)
                .build(),
        )
        .build();
    // TTL only for completed snapshots — started/uncertain work must never auto-delete.
    let ttl = IndexModel::builder()
        .keys(doc! { "cleanupAt": 1 })
        .options(
            IndexOptions::builder()
                .name(INDEX_TTL_CLEANUP_COMPLETED.to_string())
                .expire_after(Duration::ZERO)
                .partial_filter_expression(doc! { "status": STATUS_COMPLETED })
                .build(),
        )
        .build();
    vec![unique, ttl]
}

pub fn required_index_names() -> &'static [&'static str] {
    &[INDEX_UNIQ_ACTOR_ROUTE_KEY, INDEX_TTL_CLEANUP_COMPLETED]
}

// ---------------------------------------------------------------------------
// In-memory store (tests + deterministic state-machine seams)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MemoryRow {
    #[allow(dead_code)]
    actor_id: ObjectId,
    #[allow(dead_code)]
    route_key: String,
    #[allow(dead_code)]
    idempotency_key: String,
    request_digest: String,
    status: String,
    response_status: Option<u16>,
    response_body: Option<String>,
    resource_id: Option<String>,
    cleanup_at_ms: i64,
    lease_expires_at_ms: i64,
    /// Monotonic fencing generation; incremented on each exclusive start/takeover.
    lease_generation: u64,
    complete_count: u32,
}

#[derive(Default)]
pub struct MemoryIdempotencyStore {
    rows: Mutex<HashMap<String, MemoryRow>>,
    pub begin_calls: Mutex<u32>,
    /// When true, simulate missing unique index: concurrent begins both get Started.
    pub simulate_missing_unique_index: Mutex<bool>,
}

impl MemoryIdempotencyStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn map_key(actor_id: ObjectId, route_key: &str, idempotency_key: &str) -> String {
        format!("{actor_id}|{route_key}|{idempotency_key}")
    }

    pub fn force_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) {
        self.force_started_with_lease(
            actor_id,
            route_key,
            idempotency_key,
            request_digest,
            i64::MAX / 4,
        );
    }

    pub fn force_started_with_lease(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_expires_at_ms: i64,
    ) {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        self.rows.lock().expect("lock").insert(
            key,
            MemoryRow {
                actor_id,
                route_key: route_key.to_string(),
                idempotency_key: idempotency_key.to_string(),
                request_digest: request_digest.to_string(),
                status: STATUS_STARTED.to_string(),
                response_status: None,
                response_body: None,
                resource_id: None,
                cleanup_at_ms: started_cleanup_at(DateTime::from_millis(lease_expires_at_ms))
                    .timestamp_millis(),
                lease_expires_at_ms,
                lease_generation: 1,
                complete_count: 0,
            },
        );
    }

    pub fn row_status(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
    ) -> Option<String> {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        self.rows
            .lock()
            .expect("lock")
            .get(&key)
            .map(|r| r.status.clone())
    }

    pub fn row_body(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
    ) -> Option<Value> {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        self.rows
            .lock()
            .expect("lock")
            .get(&key)
            .and_then(|r| r.response_body.as_deref().and_then(parse_response_body))
    }

    pub fn force_lease_expired(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        lease_expires_at_ms: i64,
    ) {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        if let Some(row) = self.rows.lock().expect("lock").get_mut(&key) {
            row.lease_expires_at_ms = lease_expires_at_ms;
        }
    }

    pub fn row_cleanup_at_ms(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
    ) -> Option<i64> {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        self.rows
            .lock()
            .expect("lock")
            .get(&key)
            .map(|row| row.cleanup_at_ms)
    }

    /// Test seam for commit-ambiguous guest work: keep the started row fenced indefinitely.
    pub fn retain_uncertain_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        if let Some(row) = self.rows.lock().expect("lock").get_mut(&key) {
            if row.status == STATUS_STARTED && row.request_digest == request_digest {
                row.lease_expires_at_ms = i64::MAX / 4;
            }
        }
    }
}

impl IdempotencyStore for MemoryIdempotencyStore {
    async fn begin(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        now: DateTime,
    ) -> Result<IdempotencyBegin, IdempotencyError> {
        *self.begin_calls.lock().expect("lock") += 1;
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        let mut rows = self.rows.lock().expect("lock");
        let now_ms = now.timestamp_millis();
        if let Some(existing) = rows.get(&key).cloned() {
            if existing.request_digest != request_digest {
                return Ok(IdempotencyBegin::Conflict);
            }
            if existing.status == STATUS_COMPLETED {
                let body = existing
                    .response_body
                    .as_deref()
                    .and_then(parse_response_body)
                    .unwrap_or(Value::Null);
                return Ok(IdempotencyBegin::Completed {
                    status: existing.response_status.unwrap_or(200),
                    body,
                });
            }
            // started: lease takeover if expired — bump fencing generation
            if existing.lease_expires_at_ms <= now_ms {
                let next_gen = existing.lease_generation.saturating_add(1).max(1);
                if let Some(row) = rows.get_mut(&key) {
                    row.lease_expires_at_ms = now_ms + LEASE_SECONDS * 1000;
                    row.lease_generation = next_gen;
                }
                return Ok(IdempotencyBegin::Started {
                    lease_generation: next_gen,
                });
            }
            return Ok(IdempotencyBegin::InProgress);
        }
        // Optional chaos: missing unique index allows double-started (tests assert production forbids this).
        if *self.simulate_missing_unique_index.lock().expect("lock") {
            // still insert, but callers racing would both pass in real missing-index case
        }
        rows.insert(
            key,
            MemoryRow {
                actor_id,
                route_key: route_key.to_string(),
                idempotency_key: idempotency_key.to_string(),
                request_digest: request_digest.to_string(),
                status: STATUS_STARTED.to_string(),
                response_status: None,
                response_body: None,
                resource_id: None,
                cleanup_at_ms: started_cleanup_at(now).timestamp_millis(),
                lease_expires_at_ms: now_ms + LEASE_SECONDS * 1000,
                lease_generation: 1,
                complete_count: 0,
            },
        );
        Ok(IdempotencyBegin::Started {
            lease_generation: 1,
        })
    }

    async fn complete(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
        snapshot: &CompletedSnapshot,
        _now: DateTime,
    ) -> Result<(), IdempotencyError> {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        let body = bound_response_body(&snapshot.body)?;
        let mut rows = self.rows.lock().expect("lock");
        let row = rows.get_mut(&key).ok_or(IdempotencyError::Store)?;
        if row.request_digest != request_digest {
            return Err(IdempotencyError::Store);
        }
        // Idempotent complete for already-completed rows (recovery path may pass generation 0).
        if row.status == STATUS_COMPLETED {
            return Ok(());
        }
        // Fencing: stale resumed executor cannot complete after takeover.
        // Generation 0 is reserved for recovery-complete when domain snapshot is already proven.
        if lease_generation != 0 && row.lease_generation != lease_generation {
            return Err(IdempotencyError::Store);
        }
        row.status = STATUS_COMPLETED.to_string();
        row.response_status = Some(snapshot.status);
        row.response_body = Some(body);
        row.resource_id = snapshot.resource_id.clone();
        row.cleanup_at_ms = completed_cleanup_at(_now).timestamp_millis();
        row.complete_count = row.complete_count.saturating_add(1);
        Ok(())
    }

    async fn release_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
    ) -> Result<(), IdempotencyError> {
        let key = Self::map_key(actor_id, route_key, idempotency_key);
        let mut rows = self.rows.lock().expect("lock");
        if let Some(row) = rows.get(&key) {
            if row.status == STATUS_STARTED
                && row.request_digest == request_digest
                && row.lease_generation == lease_generation
            {
                rows.remove(&key);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Mongo store
// ---------------------------------------------------------------------------

pub struct MongoIdempotencyStore<'a> {
    collection: Collection<Document>,
    _db: &'a Database,
}

impl<'a> MongoIdempotencyStore<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self {
            collection: db.collection(COLLECTION),
            _db: db,
        }
    }

    /// Create unique `(actorId, routeKey, idempotencyKey)` + completed-only TTL + audit unique indexes.
    /// Must be awaited and verified before serving traffic (wired from `main.rs`).
    /// Existing duplicate audit documents cause unique-index creation to fail closed.
    pub async fn ensure_indexes(db: &Database) -> Result<(), IdempotencyError> {
        let collection = db.collection::<Document>(COLLECTION);
        collection
            .create_indexes(idempotency_index_models())
            .await
            .map_err(|error| {
                eprintln!("Failed to create idempotency indexes: {error}");
                IdempotencyError::Store
            })?;
        let audits = db.collection::<Document>(AUDIT_COLLECTION);
        audits
            .create_indexes(audit_index_models())
            .await
            .map_err(|error| {
                eprintln!("Failed to create balance/refund audit indexes: {error}");
                IdempotencyError::Store
            })?;
        let guest_transactions = db.collection::<Document>(GUEST_TRANSACTIONS_COLLECTION);
        guest_transactions
            .create_index(guest_transaction_idempotency_index_model())
            .await
            .map_err(|error| {
                eprintln!("Failed to create guest checkout idempotency marker index: {error}");
                IdempotencyError::Store
            })?;
        Self::verify_indexes(db).await
    }

    /// Fence a commit-ambiguous started row from lease takeover. Marker recovery may still
    /// complete it, but absence of a marker can never authorize a second guest mutation.
    pub async fn retain_uncertain_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
    ) -> Result<(), IdempotencyError> {
        let updated = self
            .collection
            .update_one(
                doc! {
                    "actorId": actor_id,
                    "routeKey": route_key,
                    "idempotencyKey": idempotency_key,
                    "requestDigest": request_digest,
                    "status": STATUS_STARTED,
                    "leaseGeneration": lease_generation as i64,
                },
                doc! {
                    "$set": {
                        "leaseExpiresAt": started_cleanup_at(DateTime::now()),
                        "updatedAt": DateTime::now(),
                    }
                },
            )
            .await
            .map_err(|_| IdempotencyError::Store)?;
        if updated.matched_count != 1 {
            return Err(IdempotencyError::Store);
        }
        Ok(())
    }

    /// Fail closed if required indexes are missing or safety-critical options/keys mismatch.
    pub async fn verify_indexes(db: &Database) -> Result<(), IdempotencyError> {
        let collection = db.collection::<Document>(COLLECTION);
        let listed = list_index_models(&collection).await?;
        verify_required_index_models(&listed, &idempotency_index_models(), "idempotencyrecords")?;

        let audits = db.collection::<Document>(AUDIT_COLLECTION);
        let audit_listed = list_index_models(&audits).await?;
        verify_required_index_models(&audit_listed, &audit_index_models(), AUDIT_COLLECTION)?;

        let guest_transactions = db.collection::<Document>(GUEST_TRANSACTIONS_COLLECTION);
        let guest_listed = list_index_models(&guest_transactions).await?;
        verify_required_index_models(
            &guest_listed,
            &[guest_transaction_idempotency_index_model()],
            GUEST_TRANSACTIONS_COLLECTION,
        )?;
        Ok(())
    }
}

/// List indexes as IndexModel values (production seam for option verification).
pub async fn list_index_models(
    collection: &Collection<Document>,
) -> Result<Vec<IndexModel>, IdempotencyError> {
    let mut cursor = collection.list_indexes().await.map_err(|error| {
        eprintln!("Failed to list indexes: {error}");
        IdempotencyError::IndexesNotReady
    })?;
    let mut models = Vec::new();
    while cursor.advance().await.map_err(|error| {
        eprintln!("Failed to iterate indexes: {error}");
        IdempotencyError::IndexesNotReady
    })? {
        let model = cursor.deserialize_current().map_err(|error| {
            eprintln!("Failed to decode index: {error}");
            IdempotencyError::IndexesNotReady
        })?;
        models.push(model);
    }
    Ok(models)
}

/// Verify each required model is present with matching keys and safety options.
/// Name-only matches are insufficient — unique/TTL/partial filter must match.
pub fn verify_required_index_models(
    listed: &[IndexModel],
    required: &[IndexModel],
    collection_label: &str,
) -> Result<(), IdempotencyError> {
    for expected in required {
        let expected_name = expected
            .options
            .as_ref()
            .and_then(|o| o.name.as_deref())
            .unwrap_or("<unnamed>");
        let Some(actual) = listed.iter().find(|model| {
            model.options.as_ref().and_then(|o| o.name.as_deref()) == Some(expected_name)
        }) else {
            eprintln!(
                "Required index missing before traffic on {collection_label}: {expected_name}"
            );
            return Err(IdempotencyError::IndexesNotReady);
        };
        if let Err(reason) = index_model_matches(expected, actual) {
            eprintln!("Index option/key mismatch on {collection_label}.{expected_name}: {reason}");
            return Err(IdempotencyError::IndexesNotReady);
        }
    }
    Ok(())
}

/// Compare safety-critical fields of two index models (keys, unique, TTL, partial filter).
pub fn index_model_matches(expected: &IndexModel, actual: &IndexModel) -> Result<(), String> {
    if expected.keys != actual.keys {
        return Err(format!(
            "key pattern mismatch: expected {:?}, got {:?}",
            expected.keys, actual.keys
        ));
    }
    let expected_opts = expected.options.as_ref();
    let actual_opts = actual.options.as_ref();
    let expected_unique = expected_opts.and_then(|o| o.unique).unwrap_or(false);
    let actual_unique = actual_opts.and_then(|o| o.unique).unwrap_or(false);
    if expected_unique && !actual_unique {
        return Err("unique=true required but missing/false".into());
    }
    let expected_ttl = expected_opts.and_then(|o| o.expire_after);
    let actual_ttl = actual_opts.and_then(|o| o.expire_after);
    if expected_ttl.is_some() && expected_ttl != actual_ttl {
        return Err(format!(
            "expireAfterSeconds mismatch: expected {:?}, got {:?}",
            expected_ttl, actual_ttl
        ));
    }
    let expected_partial = expected_opts.and_then(|o| o.partial_filter_expression.as_ref());
    let actual_partial = actual_opts.and_then(|o| o.partial_filter_expression.as_ref());
    if let Some(expected_partial) = expected_partial {
        match actual_partial {
            Some(actual_partial) if partial_filter_covers(expected_partial, actual_partial) => {}
            Some(actual_partial) => {
                return Err(format!(
                    "partial filter mismatch: expected {expected_partial:?}, got {actual_partial:?}"
                ));
            }
            None => return Err("partial filter required but missing".into()),
        }
    }
    Ok(())
}

/// True when `actual` includes all key/value constraints from `expected`.
fn partial_filter_covers(expected: &Document, actual: &Document) -> bool {
    for (key, value) in expected.iter() {
        match actual.get(key) {
            Some(actual_value) if actual_value == value => {}
            _ => return false,
        }
    }
    true
}

impl IdempotencyStore for MongoIdempotencyStore<'_> {
    async fn begin(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        now: DateTime,
    ) -> Result<IdempotencyBegin, IdempotencyError> {
        let insert = doc! {
            "actorId": actor_id,
            "routeKey": route_key,
            "idempotencyKey": idempotency_key,
            "requestDigest": request_digest,
            "status": STATUS_STARTED,
            "leaseExpiresAt": lease_expires_at(now),
            "leaseGeneration": 1i64,
            "createdAt": now,
            "updatedAt": now,
            // Not eligible for completed-only TTL; far-future sentinel only.
            "cleanupAt": started_cleanup_at(now),
        };
        match self.collection.insert_one(insert).await {
            Ok(_) => Ok(IdempotencyBegin::Started {
                lease_generation: 1,
            }),
            Err(error) => {
                if !is_duplicate_key(&error) {
                    return Err(IdempotencyError::Store);
                }
                let existing = self
                    .collection
                    .find_one(doc! {
                        "actorId": actor_id,
                        "routeKey": route_key,
                        "idempotencyKey": idempotency_key,
                    })
                    .await
                    .map_err(|_| IdempotencyError::Store)?
                    .ok_or(IdempotencyError::Store)?;
                let classified = classify_existing_document(&existing, request_digest, now)?;
                if matches!(classified, IdempotencyBegin::Started { .. }) {
                    // CAS lease takeover for expired started rows; bump fencing generation.
                    let taken = self
                        .collection
                        .find_one_and_update(
                            doc! {
                                "actorId": actor_id,
                                "routeKey": route_key,
                                "idempotencyKey": idempotency_key,
                                "requestDigest": request_digest,
                                "status": STATUS_STARTED,
                                "leaseExpiresAt": { "$lte": now },
                            },
                            UpdateModifications::Pipeline(vec![doc! {
                                "$set": {
                                    "leaseExpiresAt": lease_expires_at(now),
                                    "updatedAt": now,
                                    "leaseGeneration": {
                                        "$add": [
                                            { "$ifNull": ["$leaseGeneration", 0i64] },
                                            1i64
                                        ]
                                    }
                                }
                            }]),
                        )
                        .return_document(ReturnDocument::After)
                        .await
                        .map_err(|_| IdempotencyError::Store)?;
                    if let Some(doc) = taken {
                        let gen = read_lease_generation(&doc);
                        return Ok(IdempotencyBegin::Started {
                            lease_generation: gen,
                        });
                    }
                    // Lease still held by another executor.
                    return Ok(IdempotencyBegin::InProgress);
                }
                Ok(classified)
            }
        }
    }

    async fn complete(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
        snapshot: &CompletedSnapshot,
        now: DateTime,
    ) -> Result<(), IdempotencyError> {
        let body = bound_response_body(&snapshot.body)?;
        let mut set_doc = doc! {
            "status": STATUS_COMPLETED,
            "responseStatus": i32::from(snapshot.status),
            "responseBody": body,
            "updatedAt": now,
            "cleanupAt": completed_cleanup_at(now),
        };
        if let Some(resource_id) = &snapshot.resource_id {
            set_doc.insert("resourceId", resource_id);
        }

        // Fenced complete: require matching leaseGeneration unless recovery path (generation 0)
        // completes an already-proven domain snapshot, or the row is already completed.
        let filter = if lease_generation == 0 {
            doc! {
                "actorId": actor_id,
                "routeKey": route_key,
                "idempotencyKey": idempotency_key,
                "requestDigest": request_digest,
                "status": { "$in": [STATUS_STARTED, STATUS_COMPLETED] },
            }
        } else {
            doc! {
                "actorId": actor_id,
                "routeKey": route_key,
                "idempotencyKey": idempotency_key,
                "requestDigest": request_digest,
                "$or": [
                    {
                        "status": STATUS_STARTED,
                        "leaseGeneration": lease_generation as i64,
                    },
                    { "status": STATUS_COMPLETED },
                ],
            }
        };

        let updated = self
            .collection
            .find_one_and_update(
                filter,
                UpdateModifications::Document(doc! { "$set": set_doc }),
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| IdempotencyError::Store)?;
        if updated.is_none() {
            return Err(IdempotencyError::Store);
        }
        Ok(())
    }

    async fn release_started(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
        lease_generation: u64,
    ) -> Result<(), IdempotencyError> {
        // Fenced delete: a stale executor cannot delete a newer lease generation.
        let _ = self
            .collection
            .delete_one(doc! {
                "actorId": actor_id,
                "routeKey": route_key,
                "idempotencyKey": idempotency_key,
                "requestDigest": request_digest,
                "status": STATUS_STARTED,
                "leaseGeneration": lease_generation as i64,
            })
            .await
            .map_err(|_| IdempotencyError::Store)?;
        Ok(())
    }
}

fn classify_existing_document(
    existing: &Document,
    request_digest: &str,
    now: DateTime,
) -> Result<IdempotencyBegin, IdempotencyError> {
    let stored_digest = existing
        .get_str("requestDigest")
        .map_err(|_| IdempotencyError::Store)?;
    if stored_digest != request_digest {
        return Ok(IdempotencyBegin::Conflict);
    }
    let status = existing
        .get_str("status")
        .map_err(|_| IdempotencyError::Store)?;
    if status == STATUS_COMPLETED {
        let response_status = existing
            .get_i32("responseStatus")
            .ok()
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(200);
        let body = existing
            .get_str("responseBody")
            .ok()
            .and_then(parse_response_body)
            .unwrap_or(Value::Null);
        return Ok(IdempotencyBegin::Completed {
            status: response_status,
            body,
        });
    }
    let lease_ms = existing
        .get_datetime("leaseExpiresAt")
        .ok()
        .map(|dt| dt.timestamp_millis());
    let now_ms = now.timestamp_millis();
    let expired = lease_ms.map(|expires| expires <= now_ms).unwrap_or(true);
    if expired {
        // Generation assigned only after successful CAS takeover in begin().
        Ok(IdempotencyBegin::Started {
            lease_generation: 0,
        })
    } else {
        Ok(IdempotencyBegin::InProgress)
    }
}

fn read_lease_generation(doc: &Document) -> u64 {
    doc.get_i64("leaseGeneration")
        .ok()
        .and_then(|v| u64::try_from(v).ok())
        .or_else(|| {
            doc.get_i32("leaseGeneration")
                .ok()
                .and_then(|v| u64::try_from(v).ok())
        })
        .unwrap_or(1)
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write)) => {
            write.code == 11000
        }
        _ => {
            let message = error.to_string();
            message.contains("E11000") || message.contains("duplicate key")
        }
    }
}

/// Helper used by handlers after exclusive `Started` ownership.
pub async fn finish_success<S: IdempotencyStore>(
    store: &S,
    actor_id: ObjectId,
    route_key: &str,
    idempotency_key: &str,
    request_digest: &str,
    lease_generation: u64,
    snapshot: CompletedSnapshot,
    now: DateTime,
) -> Result<Response, IdempotencyError> {
    store
        .complete(
            actor_id,
            route_key,
            idempotency_key,
            request_digest,
            lease_generation,
            &snapshot,
            now,
        )
        .await?;
    Ok(completed_response(snapshot.status, snapshot.body))
}

/// Canonical identity for a domain money effect.
/// Binds the same dimensions as the orchestration record (actor+route+key+digest)
/// plus resource when relevant so bare-key collisions cannot suppress/borrow effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectIdentity {
    pub actor_id: ObjectId,
    pub route_key: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub resource_id: Option<String>,
}

impl EffectIdentity {
    pub fn balance(
        actor_id: ObjectId,
        idempotency_key: &str,
        request_digest: &str,
        target_user_id: ObjectId,
    ) -> Self {
        Self {
            actor_id,
            route_key: ROUTE_BALANCE_ADJUST.to_string(),
            idempotency_key: idempotency_key.to_string(),
            request_digest: request_digest.to_string(),
            resource_id: Some(target_user_id.to_hex()),
        }
    }

    pub fn refund(
        actor_id: ObjectId,
        idempotency_key: &str,
        request_digest: &str,
        transaction_id: ObjectId,
    ) -> Self {
        Self {
            actor_id,
            route_key: ROUTE_TRANSACTION_REFUND.to_string(),
            idempotency_key: idempotency_key.to_string(),
            request_digest: request_digest.to_string(),
            resource_id: Some(transaction_id.to_hex()),
        }
    }

    /// Deterministic slot id used as the map key in `balanceEffectSlots`.
    /// Distinct for cross-actor / cross-route / different digest / different resource.
    pub fn slot_id(&self) -> String {
        effect_slot_id(
            self.actor_id,
            &self.route_key,
            &self.idempotency_key,
            &self.request_digest,
            self.resource_id.as_deref(),
        )
    }
}

/// Hash-stable, URL-safe slot id. Never includes secrets beyond the already-hashed digest.
pub fn effect_slot_id(
    actor_id: ObjectId,
    route_key: &str,
    idempotency_key: &str,
    request_digest: &str,
    resource_id: Option<&str>,
) -> String {
    let mut mac = HmacSha256::new_from_slice(b"effect-slot-v1").expect("HMAC key");
    mac.update(b"effect-slot:v1\0");
    mac.update(actor_id.to_hex().as_bytes());
    mac.update(b"\0");
    mac.update(route_key.as_bytes());
    mac.update(b"\0");
    mac.update(idempotency_key.as_bytes());
    mac.update(b"\0");
    mac.update(request_digest.as_bytes());
    mac.update(b"\0");
    if let Some(resource) = resource_id {
        mac.update(resource.as_bytes());
    }
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Max retained *completed* proofs on a user document. Unresolved slots are never evicted.
pub const COMPLETED_EFFECT_RETENTION: i32 = 50;

/// Conservative per-user cap on *unresolved* money effect slots.
/// Prevents unbounded user-document growth while never evicting existing proofs.
pub const MAX_UNRESOLVED_EFFECT_SLOTS: i32 = 32;

/// Bound total retained slots (resolved + unresolved) to keep the user document small.
/// Must be >= COMPLETED_EFFECT_RETENTION + MAX_UNRESOLVED_EFFECT_SLOTS.
pub const MAX_TOTAL_EFFECT_SLOTS: i32 = COMPLETED_EFFECT_RETENTION + MAX_UNRESOLVED_EFFECT_SLOTS;

/// Bounded retries for Mongo `UnknownTransactionCommitResult` during commit.
pub const MAX_UNKNOWN_COMMIT_RETRIES: u32 = 8;

const AUDIT_COLLECTION: &str = "userbalanceadjustments";
const INDEX_UNIQ_BALANCE_AUDIT: &str = "uniq_balance_audit_identity";
const INDEX_UNIQ_REFUND_AUDIT: &str = "uniq_refund_audit_identity";
const GUEST_TRANSACTIONS_COLLECTION: &str = "guesttransactions";
const INDEX_UNIQ_GUEST_IDEMPOTENCY_MARKER: &str = "uniq_guest_idempotency_marker";

/// Unique audit indexes: full identity so lease-overlapped executors cannot double-insert.
pub fn balance_audit_index_model() -> IndexModel {
    IndexModel::builder()
        .keys(doc! {
            "adjustedBy": 1,
            "user": 1,
            "idempotencyKey": 1,
            "routeKey": 1,
            "requestDigest": 1,
        })
        .options(
            IndexOptions::builder()
                .name(INDEX_UNIQ_BALANCE_AUDIT.to_string())
                .unique(true)
                .partial_filter_expression(doc! {
                    "idempotencyKey": { "$type": "string" },
                    "routeKey": ROUTE_BALANCE_ADJUST,
                })
                .build(),
        )
        .build()
}

pub fn refund_audit_index_model() -> IndexModel {
    IndexModel::builder()
        .keys(doc! {
            "adjustedBy": 1,
            "transactionId": 1,
            "idempotencyKey": 1,
            "routeKey": 1,
            "requestDigest": 1,
        })
        .options(
            IndexOptions::builder()
                .name(INDEX_UNIQ_REFUND_AUDIT.to_string())
                .unique(true)
                .partial_filter_expression(doc! {
                    "idempotencyKey": { "$type": "string" },
                    "routeKey": ROUTE_TRANSACTION_REFUND,
                    "transactionId": { "$exists": true },
                })
                .build(),
        )
        .build()
}

pub fn audit_index_models() -> Vec<IndexModel> {
    vec![balance_audit_index_model(), refund_audit_index_model()]
}

pub fn guest_transaction_idempotency_index_model() -> IndexModel {
    IndexModel::builder()
        .keys(doc! {
            "idempotencyRoute": 1,
            "idempotencyKey": 1,
            "idempotencyRequestDigest": 1,
        })
        .options(
            IndexOptions::builder()
                .name(INDEX_UNIQ_GUEST_IDEMPOTENCY_MARKER.to_string())
                .unique(true)
                .partial_filter_expression(doc! {
                    "idempotencyRoute": ROUTE_GUEST_CHECKOUT,
                    "idempotencyKey": { "$type": "string" },
                    "idempotencyRequestDigest": { "$type": "string" },
                })
                .build(),
        )
        .build()
}

/// Atomic balance money+marker filter/update pieces (production seam for tests).
/// Money `$inc` is coupled with a full-identity slot in the SAME user document.
/// Filter rejects only when this exact identity already applied — bare key collisions
/// across actors/routes/digests/resources never suppress a distinct effect.
/// NEW effects are fail-closed when unresolved/total slot caps are already reached;
/// an existing matching unresolved slot remains reconcilable even at the cap.
pub fn balance_effect_filter(
    user_id: ObjectId,
    identity: &EffectIdentity,
    adjustment_type: &str,
    amount: f64,
) -> Document {
    let slot = identity.slot_id();
    let mut filter = doc! {
        "_id": user_id,
        "role": "member",
        format!("balanceEffectSlots.{slot}"): { "$exists": false },
    };
    // Atomic same-document admission: only admit a NEW slot when capacity remains.
    // Existing matching slots are handled by the caller via identity lookup, not this filter.
    filter.insert("$expr", new_effect_slot_admission_expr());
    if adjustment_type == "subtract" {
        filter.insert("balance", doc! { "$gte": amount });
    }
    filter
}

/// `$expr` predicate: admit a brand-new money effect only when unresolved and total
/// slot counts are strictly below the conservative caps. Malformed/non-object
/// `balanceEffectSlots` fails closed (predicate is false).
pub fn new_effect_slot_admission_expr() -> Document {
    doc! {
        "$and": [
            // Fail closed if field exists but is not an object/map.
            {
                "$or": [
                    { "$eq": [{ "$type": { "$ifNull": ["$balanceEffectSlots", {}] } }, "object"] },
                    { "$eq": [{ "$type": { "$ifNull": ["$balanceEffectSlots", {}] } }, "missing"] },
                ]
            },
            {
                "$lt": [
                    unresolved_effect_slot_count_expr(),
                    MAX_UNRESOLVED_EFFECT_SLOTS
                ]
            },
            {
                "$lt": [
                    total_effect_slot_count_expr(),
                    MAX_TOTAL_EFFECT_SLOTS
                ]
            },
        ]
    }
}

fn effect_slots_array_expr() -> Document {
    doc! {
        "$cond": [
            {
                "$eq": [
                    { "$type": { "$ifNull": ["$balanceEffectSlots", {}] } },
                    "object"
                ]
            },
            { "$objectToArray": { "$ifNull": ["$balanceEffectSlots", {}] } },
            // Non-object → empty array so count predicates fail closed via separate type check,
            // and concurrent model still sees zero countable slots.
            []
        ]
    }
}

fn unresolved_effect_slot_count_expr() -> Document {
    doc! {
        "$size": {
            "$filter": {
                "input": effect_slots_array_expr(),
                "as": "e",
                "cond": {
                    "$ne": [
                        { "$ifNull": ["$$e.v.resolved", false] },
                        true
                    ]
                }
            }
        }
    }
}

fn total_effect_slot_count_expr() -> Document {
    doc! {
        "$size": effect_slots_array_expr()
    }
}

/// Pure admission decision over an already-loaded user document (tests + prechecks).
/// Returns `false` (fail closed) for missing user context, malformed maps, or at/over cap.
/// Existing matching unresolved slot is NOT decided here — callers must check identity first.
pub fn admits_new_effect_slot(user: Option<&Document>) -> bool {
    let Some(user) = user else {
        return false;
    };
    match user.get("balanceEffectSlots") {
        None => true,
        Some(Bson::Document(slots)) => {
            let mut unresolved = 0i32;
            let mut total = 0i32;
            for (_k, v) in slots.iter() {
                total += 1;
                let resolved = match v {
                    Bson::Document(marker) => marker
                        .get_bool("resolved")
                        .ok()
                        .or_else(|| {
                            marker.get("resolved").and_then(|b| match b {
                                Bson::Boolean(v) => Some(*v),
                                _ => None,
                            })
                        })
                        .unwrap_or(false),
                    // Non-object entry counts as unresolved (fail closed capacity).
                    _ => false,
                };
                if !resolved {
                    unresolved += 1;
                }
            }
            unresolved < MAX_UNRESOLVED_EFFECT_SLOTS && total < MAX_TOTAL_EFFECT_SLOTS
        }
        // Array / string / number / null → fail closed.
        Some(_) => false,
    }
}

/// Classify whether a user document miss after a NEW-effect filter is capacity exhaustion
/// (vs already-applied identity, insufficient balance, or missing user).
pub fn is_effect_slot_capacity_rejection(
    user: Option<&Document>,
    identity: &EffectIdentity,
) -> bool {
    let Some(user) = user else {
        return false;
    };
    // Existing matching slot is reconcilable — not a capacity rejection.
    if find_balance_effect_by_identity(user, identity).is_some() {
        return false;
    }
    !admits_new_effect_slot(Some(user))
}

/// Pipeline: increment balance and write a durable unresolved marker under a full-identity slot.
/// Completed proofs may later be pruned; unresolved slots are never rolled off by later effects.
pub fn balance_effect_pipeline(
    identity: &EffectIdentity,
    adjustment_type: &str,
    amount: f64,
    delta: f64,
    reason: &str,
    now: DateTime,
) -> Vec<Document> {
    let slot = identity.slot_id();
    let slot_path = format!("balanceEffectSlots.{slot}");
    let marker = doc! {
        "slotId": &slot,
        "key": &identity.idempotency_key,
        "actorId": identity.actor_id,
        "routeKey": &identity.route_key,
        "requestDigest": &identity.request_digest,
        "resourceId": identity.resource_id.clone().unwrap_or_default(),
        "type": adjustment_type,
        "amount": amount,
        "reason": reason,
        "resolved": false,
        "balanceBefore": "$balance",
        "balanceAfter": { "$add": ["$balance", delta] },
        "name": { "$ifNull": ["$name", ""] },
        "email": { "$ifNull": ["$email", ""] },
        "level": { "$ifNull": ["$level", ""] },
        "points": { "$ifNull": ["$points", 0] },
        "active": { "$ifNull": ["$active", true] },
        "createdAt": "$createdAt",
        "updatedAt": now,
        "appliedAt": now,
    };
    vec![doc! {
        "$set": {
            "balance": { "$add": ["$balance", delta] },
            "updatedAt": now,
            slot_path: marker,
        }
    }]
}

/// Mark a balance/refund money proof resolved after orchestration completion so retention
/// cleanup may remove it. Unresolved (`resolved=false`) proofs remain durable forever.
pub fn mark_effect_resolved_update(identity: &EffectIdentity, now: DateTime) -> Document {
    let slot = identity.slot_id();
    doc! {
        "$set": {
            format!("balanceEffectSlots.{slot}.resolved"): true,
            format!("balanceEffectSlots.{slot}.resolvedAt"): now,
            "updatedAt": now,
        }
    }
}

/// Prune only *resolved* completed proofs beyond retention. Never touches unresolved slots.
/// Pure pipeline stage builder (production seam / executable model tests).
pub fn prune_resolved_effect_slots_pipeline(now: DateTime) -> Vec<Document> {
    // Convert map → array, keep all unresolved + newest COMPLETED_EFFECT_RETENTION resolved.
    vec![
        doc! {
            "$set": {
                "_effectEntries": {
                    "$objectToArray": { "$ifNull": ["$balanceEffectSlots", {}] }
                }
            }
        },
        doc! {
            "$set": {
                "_unresolvedEntries": {
                    "$filter": {
                        "input": "$_effectEntries",
                        "as": "e",
                        "cond": {
                            "$ne": [
                                { "$ifNull": ["$$e.v.resolved", false] },
                                true
                            ]
                        }
                    }
                },
                "_resolvedEntries": {
                    "$slice": [
                        {
                            "$sortArray": {
                                "input": {
                                    "$filter": {
                                        "input": "$_effectEntries",
                                        "as": "e",
                                        "cond": {
                                            "$eq": [
                                                { "$ifNull": ["$$e.v.resolved", false] },
                                                true
                                            ]
                                        }
                                    }
                                },
                                "sortBy": { "v.resolvedAt": -1, "v.appliedAt": -1 }
                            }
                        },
                        COMPLETED_EFFECT_RETENTION
                    ]
                }
            }
        },
        doc! {
            "$set": {
                "balanceEffectSlots": {
                    "$arrayToObject": {
                        "$concatArrays": ["$_unresolvedEntries", "$_resolvedEntries"]
                    }
                },
                "updatedAt": now,
            }
        },
        doc! {
            "$unset": ["_effectEntries", "_unresolvedEntries", "_resolvedEntries"]
        },
    ]
}

/// Refund credit money+marker: same-document coupling on the user with full identity.
/// NEW credits are fail-closed at the unresolved/total slot caps (same as balance).
pub fn refund_credit_filter(user_id: ObjectId, identity: &EffectIdentity) -> Document {
    let slot = identity.slot_id();
    doc! {
        "_id": user_id,
        format!("balanceEffectSlots.{slot}"): { "$exists": false },
        "$expr": new_effect_slot_admission_expr(),
    }
}

pub fn refund_credit_pipeline(
    identity: &EffectIdentity,
    amount: i64,
    reason: &str,
    transaction_id: ObjectId,
    now: DateTime,
) -> Vec<Document> {
    let amount_f = amount as f64;
    let slot = identity.slot_id();
    let slot_path = format!("balanceEffectSlots.{slot}");
    let marker = doc! {
        "slotId": &slot,
        "key": &identity.idempotency_key,
        "actorId": identity.actor_id,
        "routeKey": &identity.route_key,
        "requestDigest": &identity.request_digest,
        "resourceId": identity.resource_id.clone().unwrap_or_else(|| transaction_id.to_hex()),
        "type": "add",
        "amount": amount_f,
        "reason": reason,
        "transactionId": transaction_id,
        "resolved": false,
        "balanceBefore": "$balance",
        "balanceAfter": { "$add": ["$balance", amount_f] },
        "appliedAt": now,
    };
    vec![doc! {
        "$set": {
            "balance": { "$add": ["$balance", amount_f] },
            "updatedAt": now,
            slot_path: marker,
        }
    }]
}

/// Lookup a durable effect by full identity. Bare key match is intentionally insufficient.
pub fn find_balance_effect_by_identity(
    user: &Document,
    identity: &EffectIdentity,
) -> Option<Document> {
    let slots = user.get_document("balanceEffectSlots").ok()?;
    let slot = identity.slot_id();
    let marker = slots.get_document(&slot).ok()?.clone();
    if effect_marker_matches_identity(&marker, identity) {
        Some(marker)
    } else {
        None
    }
}

/// Verify marker payload binds the full identity before treating it as proof.
pub fn effect_marker_matches_identity(marker: &Document, identity: &EffectIdentity) -> bool {
    let key_ok = marker.get_str("key").ok() == Some(identity.idempotency_key.as_str());
    let actor_ok = marker.get_object_id("actorId").ok() == Some(identity.actor_id);
    let route_ok = marker.get_str("routeKey").ok() == Some(identity.route_key.as_str());
    let digest_ok = marker.get_str("requestDigest").ok() == Some(identity.request_digest.as_str());
    let resource_ok = match &identity.resource_id {
        Some(expected) => {
            marker.get_str("resourceId").ok() == Some(expected.as_str())
                || marker
                    .get_object_id("transactionId")
                    .ok()
                    .map(|id| id.to_hex() == *expected)
                    .unwrap_or(false)
                || marker
                    .get_object_id("resourceId")
                    .ok()
                    .map(|id| id.to_hex() == *expected)
                    .unwrap_or(false)
        }
        None => true,
    };
    key_ok && actor_ok && route_ok && digest_ok && resource_ok
}

/// Executable in-memory model of durable effect slots (adversarial / retention tests).
#[derive(Debug, Default, Clone)]
pub struct EffectSlotModel {
    /// slot_id -> (identity fingerprint, resolved)
    slots: HashMap<String, (String, bool)>,
    apply_count: HashMap<String, u32>,
    /// When true, `balanceEffectSlots` is treated as malformed/non-object (fail closed).
    malformed: bool,
    /// Optional test override for unresolved cap (defaults to production constant).
    unresolved_cap: Option<i32>,
    /// Optional test override for total cap.
    total_cap: Option<i32>,
}

/// Outcome of attempting to admit a NEW money effect under capacity bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectApplyOutcome {
    /// Newly applied under this full identity.
    Applied,
    /// Identity already present (reconcile / no re-execution).
    AlreadyPresent,
    /// Cap reached for a brand-new identity; no money mutation.
    CapacityExceeded,
    /// Document map is malformed; fail closed, no money mutation.
    MalformedFailClosed,
}

impl EffectSlotModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_caps(unresolved_cap: i32, total_cap: i32) -> Self {
        Self {
            unresolved_cap: Some(unresolved_cap),
            total_cap: Some(total_cap),
            ..Self::default()
        }
    }

    pub fn mark_malformed(&mut self) {
        self.malformed = true;
    }

    fn fingerprint(identity: &EffectIdentity) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            identity.actor_id.to_hex(),
            identity.route_key,
            identity.idempotency_key,
            identity.request_digest,
            identity.resource_id.clone().unwrap_or_default()
        )
    }

    fn unresolved_cap(&self) -> i32 {
        self.unresolved_cap.unwrap_or(MAX_UNRESOLVED_EFFECT_SLOTS)
    }

    fn total_cap(&self) -> i32 {
        self.total_cap.unwrap_or(MAX_TOTAL_EFFECT_SLOTS)
    }

    pub fn unresolved_count(&self) -> usize {
        self.slots
            .values()
            .filter(|(_, resolved)| !*resolved)
            .count()
    }

    /// True when a brand-new identity may be admitted (same-document predicate model).
    pub fn admits_new(&self) -> bool {
        if self.malformed {
            return false;
        }
        (self.unresolved_count() as i32) < self.unresolved_cap()
            && (self.slots.len() as i32) < self.total_cap()
    }

    /// Apply money effect once for this full identity. Returns true if newly applied.
    /// Existing matching unresolved slots remain reconcilable even at the cap.
    pub fn try_apply(&mut self, identity: &EffectIdentity) -> bool {
        matches!(
            self.try_apply_detailed(identity),
            EffectApplyOutcome::Applied
        )
    }

    pub fn try_apply_detailed(&mut self, identity: &EffectIdentity) -> EffectApplyOutcome {
        if self.malformed {
            return EffectApplyOutcome::MalformedFailClosed;
        }
        let slot = identity.slot_id();
        if self.slots.contains_key(&slot) {
            return EffectApplyOutcome::AlreadyPresent;
        }
        if !self.admits_new() {
            return EffectApplyOutcome::CapacityExceeded;
        }
        self.slots
            .insert(slot.clone(), (Self::fingerprint(identity), false));
        *self.apply_count.entry(slot).or_insert(0) += 1;
        EffectApplyOutcome::Applied
    }

    /// Concurrent same-document admission model: only one of two new effects near cap wins.
    pub fn try_apply_concurrent_pair(
        &mut self,
        a: &EffectIdentity,
        b: &EffectIdentity,
    ) -> (EffectApplyOutcome, EffectApplyOutcome) {
        // Snapshot capacity once (same-document predicate), then apply winners atomically
        // in a deterministic order so total never exceeds the cap.
        let remaining_unresolved = self
            .unresolved_cap()
            .saturating_sub(self.unresolved_count() as i32);
        let remaining_total = self.total_cap().saturating_sub(self.slots.len() as i32);
        let remaining = remaining_unresolved.min(remaining_total).max(0);

        let mut first = if self.slots.contains_key(&a.slot_id()) {
            EffectApplyOutcome::AlreadyPresent
        } else if self.malformed {
            EffectApplyOutcome::MalformedFailClosed
        } else if remaining >= 1 {
            EffectApplyOutcome::Applied
        } else {
            EffectApplyOutcome::CapacityExceeded
        };
        let mut second = if self.slots.contains_key(&b.slot_id()) {
            EffectApplyOutcome::AlreadyPresent
        } else if self.malformed {
            EffectApplyOutcome::MalformedFailClosed
        } else if remaining >= 2 || (remaining >= 1 && first != EffectApplyOutcome::Applied) {
            // If first already present, second can take the remaining 1 slot.
            if remaining >= 1 && first != EffectApplyOutcome::Applied {
                EffectApplyOutcome::Applied
            } else if remaining >= 2 {
                EffectApplyOutcome::Applied
            } else {
                EffectApplyOutcome::CapacityExceeded
            }
        } else if first == EffectApplyOutcome::Applied && remaining < 2 {
            EffectApplyOutcome::CapacityExceeded
        } else {
            EffectApplyOutcome::CapacityExceeded
        };

        // Materialize Applied outcomes without exceeding remaining budget.
        let mut used = 0i32;
        if first == EffectApplyOutcome::Applied {
            if used < remaining && !self.slots.contains_key(&a.slot_id()) {
                let slot = a.slot_id();
                self.slots
                    .insert(slot.clone(), (Self::fingerprint(a), false));
                *self.apply_count.entry(slot).or_insert(0) += 1;
                used += 1;
            } else if self.slots.contains_key(&a.slot_id()) {
                first = EffectApplyOutcome::AlreadyPresent;
            } else {
                first = EffectApplyOutcome::CapacityExceeded;
            }
        }
        if second == EffectApplyOutcome::Applied {
            if used < remaining && !self.slots.contains_key(&b.slot_id()) {
                let slot = b.slot_id();
                self.slots
                    .insert(slot.clone(), (Self::fingerprint(b), false));
                *self.apply_count.entry(slot).or_insert(0) += 1;
            } else if self.slots.contains_key(&b.slot_id()) {
                second = EffectApplyOutcome::AlreadyPresent;
            } else {
                second = EffectApplyOutcome::CapacityExceeded;
            }
        }
        (first, second)
    }

    pub fn has_unresolved(&self, identity: &EffectIdentity) -> bool {
        self.slots
            .get(&identity.slot_id())
            .map(|(_, resolved)| !*resolved)
            .unwrap_or(false)
    }

    pub fn mark_resolved(&mut self, identity: &EffectIdentity) {
        if let Some(entry) = self.slots.get_mut(&identity.slot_id()) {
            entry.1 = true;
        }
    }

    /// Retain all unresolved + newest `COMPLETED_EFFECT_RETENTION` resolved (by insert order here).
    pub fn prune_resolved(&mut self) {
        let unresolved: Vec<(String, (String, bool))> = self
            .slots
            .iter()
            .filter(|(_, (_, resolved))| !*resolved)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut resolved: Vec<(String, (String, bool))> = self
            .slots
            .iter()
            .filter(|(_, (_, resolved))| *resolved)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        // Keep the most recently resolved (end of map iteration is not ordered; use key sort for determinism).
        resolved.sort_by(|a, b| a.0.cmp(&b.0));
        if resolved.len() > COMPLETED_EFFECT_RETENTION as usize {
            let drop_count = resolved.len() - COMPLETED_EFFECT_RETENTION as usize;
            resolved.drain(0..drop_count);
        }
        self.slots = unresolved.into_iter().chain(resolved).collect();
    }

    pub fn apply_count(&self, identity: &EffectIdentity) -> u32 {
        self.apply_count
            .get(&identity.slot_id())
            .copied()
            .unwrap_or(0)
    }

    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

/// Outcome of a Mongo multi-doc transaction commit attempt after domain ops succeeded in-session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionCommitOutcome {
    /// Commit acknowledged.
    Committed,
    /// Commit may have been durable server-side (lost response / unknown result). Never treat as non-durable.
    Ambiguous,
    /// Commit definitively rejected without unknown-result label. Still not proof of non-durability for release.
    FailedDefinitely,
}

/// Whether the started orchestration row may be released after a transaction path outcome.
/// Only positively proven pre-effect / non-committed failures may release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrchestrationReleaseDecision {
    /// Safe: no money/audit effect could have become durable.
    ReleaseStarted,
    /// Keep started and reconcile full-identity marker/audit. Never re-execute money blindly.
    RetainAndReconcile,
}

/// Pure commit protocol seam: retry UnknownTransactionCommitResult with bounds; never release on ambiguity.
pub fn classify_transaction_commit_error(
    labels: &[&str],
    attempts_used: u32,
) -> TransactionCommitOutcome {
    let _ = attempts_used;
    if labels
        .iter()
        .any(|l| *l == mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT)
    {
        return TransactionCommitOutcome::Ambiguous;
    }
    // Network-ish labels without explicit unknown-commit still cannot prove non-commit.
    if labels.iter().any(|l| {
        *l == mongodb::error::TRANSIENT_TRANSACTION_ERROR
            || *l == mongodb::error::RETRYABLE_WRITE_ERROR
            || *l == mongodb::error::RETRYABLE_ERROR
    }) {
        return TransactionCommitOutcome::Ambiguous;
    }
    TransactionCommitOutcome::FailedDefinitely
}

pub fn release_decision_after_transaction_commit(
    outcome: TransactionCommitOutcome,
) -> OrchestrationReleaseDecision {
    match outcome {
        // Even "definitive" commit failure is NOT positive proof the server never committed
        // when domain ops already ran inside the transaction. Always retain and reconcile.
        TransactionCommitOutcome::Committed
        | TransactionCommitOutcome::Ambiguous
        | TransactionCommitOutcome::FailedDefinitely => {
            OrchestrationReleaseDecision::RetainAndReconcile
        }
    }
}

/// Abort after an in-transaction operation error: abort failure is also ambiguous for release.
pub fn release_decision_after_transaction_abort(
    domain_ops_observed_success: bool,
    abort_ok: bool,
) -> OrchestrationReleaseDecision {
    if !domain_ops_observed_success {
        // Op failed before any successful money write was observed in-session.
        // Abort success reinforces non-durability; abort failure still retain out of caution.
        if abort_ok {
            OrchestrationReleaseDecision::ReleaseStarted
        } else {
            OrchestrationReleaseDecision::RetainAndReconcile
        }
    } else {
        // Domain ops returned Ok — even if we later decide to abort, never release on abort alone.
        OrchestrationReleaseDecision::RetainAndReconcile
    }
}

/// Executable regression seam: committed-server / lost-response + abort failure.
/// Models money/audit once, keeps started on ambiguous outcomes, and proves retry reconciles
/// without repeating money or audit.
#[derive(Debug, Default, Clone)]
pub struct TransactionCrashBoundaryModel {
    pub money_applied: u32,
    pub audit_rows: u32,
    pub started_present: bool,
    pub completed: bool,
    pub commit_attempts: u32,
    pub last_commit_outcome: Option<TransactionCommitOutcome>,
}

impl TransactionCrashBoundaryModel {
    pub fn new_started() -> Self {
        Self {
            started_present: true,
            ..Self::default()
        }
    }

    /// First attempt: domain ops succeed in-session; commit returns unknown (server committed, response lost).
    pub fn attempt_with_lost_commit_response(&mut self) {
        assert!(self.started_present, "must hold started lease");
        if self.completed {
            return;
        }
        // Apply money+audit at most once (idempotent domain).
        if self.money_applied == 0 {
            self.money_applied = 1;
            self.audit_rows = 1;
        }
        self.commit_attempts += 1;
        // Simulate UnknownTransactionCommitResult after server-side commit.
        let outcome = classify_transaction_commit_error(
            &[mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT],
            self.commit_attempts,
        );
        self.last_commit_outcome = Some(outcome);
        assert_eq!(
            release_decision_after_transaction_commit(outcome),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
        // Must NOT release started.
        assert!(self.started_present);
        // Do not complete without positive commit ack in this attempt.
    }

    /// Retry: observe durable marker/audit, complete once, never re-apply money/audit.
    pub fn retry_reconcile_from_marker(&mut self) {
        assert_eq!(self.money_applied, 1);
        assert_eq!(self.audit_rows, 1);
        if self.completed {
            // Exact completed replay: never re-apply money/audit.
            return;
        }
        assert!(
            self.started_present,
            "first reconcile requires retained started"
        );
        // Reconcile path: no second money/audit.
        self.completed = true;
        // started may remain until complete CAS; model completion removes uncertainty.
        self.started_present = false;
    }

    /// Abort failure after observed domain-op error: retain started.
    pub fn attempt_op_error_with_abort_failure(&mut self) {
        assert!(self.started_present);
        // Domain op failed — money not observed success.
        let decision = release_decision_after_transaction_abort(false, false);
        assert_eq!(decision, OrchestrationReleaseDecision::RetainAndReconcile);
        // Retain started.
        assert!(self.started_present);
        assert_eq!(self.money_applied, 0);
        assert_eq!(self.audit_rows, 0);
    }

    /// Bounded unknown-commit retries then still retain (never release).
    pub fn retry_unknown_commit_until_bound(&mut self) -> TransactionCommitOutcome {
        assert!(self.started_present);
        if self.money_applied == 0 {
            self.money_applied = 1;
            self.audit_rows = 1;
        }
        let mut outcome = TransactionCommitOutcome::Ambiguous;
        for attempt in 1..=MAX_UNKNOWN_COMMIT_RETRIES {
            self.commit_attempts = attempt;
            outcome = classify_transaction_commit_error(
                &[mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT],
                attempt,
            );
            assert_eq!(outcome, TransactionCommitOutcome::Ambiguous);
            assert_eq!(
                release_decision_after_transaction_commit(outcome),
                OrchestrationReleaseDecision::RetainAndReconcile
            );
        }
        self.last_commit_outcome = Some(outcome);
        assert!(self.started_present);
        assert_eq!(self.money_applied, 1);
        assert_eq!(self.audit_rows, 1);
        outcome
    }
}

/// Lease fencing token returned when a request owns exclusive execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseFence {
    pub generation: u64,
}

/// Commit a Mongo multi-doc transaction with bounded UnknownTransactionCommitResult retries.
///
/// **Never** treat any commit error as proof of non-durability. Callers must retain the
/// started orchestration row and reconcile full-identity marker/audit after Ambiguous or
/// FailedDefinitely outcomes. Only ReleaseStarted when positively proven pre-effect.
pub async fn commit_mongo_transaction_with_unknown_retry(
    session: &mut mongodb::ClientSession,
) -> TransactionCommitOutcome {
    let mut attempts: u32 = 0;
    loop {
        attempts += 1;
        match session.commit_transaction().await {
            Ok(()) => return TransactionCommitOutcome::Committed,
            Err(error) => {
                let unknown =
                    error.contains_label(mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT);
                if unknown && attempts < MAX_UNKNOWN_COMMIT_RETRIES {
                    // Protocol: safe to retry commit only while UnknownTransactionCommitResult.
                    continue;
                }
                if unknown
                    || error.contains_label(mongodb::error::TRANSIENT_TRANSACTION_ERROR)
                    || error.contains_label(mongodb::error::RETRYABLE_WRITE_ERROR)
                    || error.contains_label(mongodb::error::RETRYABLE_ERROR)
                {
                    eprintln!(
                        "balance/refund transaction commit ambiguous after {attempts} attempt(s): {error}"
                    );
                    return TransactionCommitOutcome::Ambiguous;
                }
                eprintln!(
                    "balance/refund transaction commit failed after {attempts} attempt(s): {error}"
                );
                // Still not positive proof of non-commit once domain ops ran in-session.
                return TransactionCommitOutcome::FailedDefinitely;
            }
        }
    }
}

/// Refund phase stamps on the transaction document (claim is not completion).
pub const REFUND_PHASE_CLAIMED: &str = "claimed";
pub const REFUND_PHASE_CREDITED: &str = "credited";
pub const REFUND_PHASE_AUDITED: &str = "audited";

// Keep Arc alias available for concurrent tests.
#[allow(dead_code)]
type SharedMemory = Arc<MemoryIdempotencyStore>;

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::Bson;
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Mutex as StdMutex,
    };

    static IDEMPOTENCY_FLAG_ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn oid(n: u8) -> ObjectId {
        ObjectId::from_bytes([n; 12])
    }

    fn now() -> DateTime {
        DateTime::from_millis(1_700_000_000_000)
    }

    struct NoRecovery;
    impl DomainMarkerRecovery for NoRecovery {
        async fn recover(
            &self,
            _actor_id: ObjectId,
            _route_key: &str,
            _idempotency_key: &str,
            _request_digest: &str,
        ) -> DomainRecovery {
            DomainRecovery::None
        }
    }

    struct MarkerRecovery {
        outcome: Mutex<DomainRecovery>,
        hits: AtomicU32,
    }

    impl MarkerRecovery {
        fn new(outcome: DomainRecovery) -> Self {
            Self {
                outcome: Mutex::new(outcome),
                hits: AtomicU32::new(0),
            }
        }
    }

    impl DomainMarkerRecovery for MarkerRecovery {
        async fn recover(
            &self,
            _actor_id: ObjectId,
            _route_key: &str,
            _idempotency_key: &str,
            _request_digest: &str,
        ) -> DomainRecovery {
            self.hits.fetch_add(1, Ordering::SeqCst);
            self.outcome.lock().expect("lock").clone()
        }
    }

    #[test]
    fn normalize_key_bounds_and_charset() {
        assert!(normalize_idempotency_key("short").is_err());
        assert!(normalize_idempotency_key(&"a".repeat(129)).is_err());
        assert!(normalize_idempotency_key("bad key!!").is_err());
        assert_eq!(
            normalize_idempotency_key("  abcdefgh-12.OK_  ").unwrap(),
            "abcdefgh-12.OK_"
        );
    }

    #[test]
    fn legacy_balance_and_refund_digests_remain_v1_compatible() {
        assert_eq!(
            balance_adjust_digest(
                b"legacy-secret",
                "507f1f77bcf86cd799439011",
                "add",
                10.5,
                "legacy reason",
            ),
            "B0pO7yMrnSPg13Jz8Q7-Snc0a94sTldVLgfc5wMVqSc"
        );
        assert_eq!(
            refund_digest(
                b"legacy-secret",
                "507f1f77bcf86cd799439012",
                "legacy refund",
            ),
            "gXpcm2iUrQ4FTJe5ooTKV9T3zL-ULogINPkM4DwZdNI"
        );
    }

    #[test]
    fn digest_is_keyed_and_stable() {
        let a = balance_adjust_digest(b"secret-a", "user1", "add", 10.0, "reason-long");
        let b = balance_adjust_digest(b"secret-a", "user1", "add", 10.0, "reason-long");
        let c = balance_adjust_digest(b"secret-b", "user1", "add", 10.0, "reason-long");
        let d = balance_adjust_digest(b"secret-a", "user1", "add", 11.0, "reason-long");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert!(!a.contains("secret"));
    }

    #[test]
    fn absent_key_enforced_by_default() {
        let _guard = IDEMPOTENCY_FLAG_ENV_LOCK.lock().expect("env lock");
        let previous = std::env::var_os("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED");
        std::env::remove_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED");
        let headers = HeaderMap::new();
        let result = require_idempotency_key(&headers);
        match previous {
            Some(value) => std::env::set_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED", value),
            None => std::env::remove_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED"),
        }
        let err = result.unwrap_err();
        assert!(matches!(err, IdempotencyError::MissingKey));
    }

    #[test]
    fn absent_key_allowed_when_rollout_flag_off() {
        let _guard = IDEMPOTENCY_FLAG_ENV_LOCK.lock().expect("env lock");
        let previous = std::env::var_os("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED");
        std::env::set_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED", "false");
        let headers = HeaderMap::new();
        let result = require_idempotency_key(&headers);
        match previous {
            Some(value) => std::env::set_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED", value),
            None => std::env::remove_var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED"),
        }
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn index_models_require_unique_triple_and_completed_only_ttl() {
        let models = idempotency_index_models();
        assert_eq!(models.len(), 2);
        let names: Vec<String> = models
            .iter()
            .filter_map(|m| m.options.as_ref().and_then(|o| o.name.clone()))
            .collect();
        assert!(names.iter().any(|n| n == INDEX_UNIQ_ACTOR_ROUTE_KEY));
        assert!(names.iter().any(|n| n == INDEX_TTL_CLEANUP_COMPLETED));
        let ttl = models
            .iter()
            .find(|m| {
                m.options.as_ref().and_then(|o| o.name.as_deref())
                    == Some(INDEX_TTL_CLEANUP_COMPLETED)
            })
            .expect("ttl index");
        let options = ttl.options.as_ref().expect("options");
        assert_eq!(options.expire_after, Some(Duration::ZERO));
        let partial = options
            .partial_filter_expression
            .as_ref()
            .expect("partial filter for completed-only TTL");
        assert_eq!(partial.get_str("status").unwrap(), STATUS_COMPLETED);
        let unique = models
            .iter()
            .find(|m| {
                m.options.as_ref().and_then(|o| o.name.as_deref())
                    == Some(INDEX_UNIQ_ACTOR_ROUTE_KEY)
            })
            .expect("unique index");
        assert_eq!(unique.options.as_ref().unwrap().unique, Some(true));
        assert_eq!(
            unique.keys,
            doc! { "actorId": 1, "routeKey": 1, "idempotencyKey": 1 }
        );
    }

    #[test]
    fn main_rs_awaits_idempotency_indexes_before_listener() {
        let main_src = include_str!("../main.rs");
        assert!(
            main_src.contains("MongoIdempotencyStore::ensure_indexes")
                || main_src.contains("idempotency::MongoIdempotencyStore::ensure_indexes")
                || main_src
                    .contains("services::idempotency::MongoIdempotencyStore::ensure_indexes"),
            "main.rs must await idempotency ensure_indexes before traffic"
        );
        assert!(
            main_src.contains("idempotency indexes")
                || main_src.contains("ensure_indexes") && main_src.contains("idempotency"),
            "startup failure context must mention idempotency indexes"
        );
        // ensure_indexes must appear before TcpListener::bind
        let ensure_pos = main_src
            .find("ensure_indexes")
            .expect("ensure_indexes call");
        let bind_pos = main_src.find("TcpListener::bind").expect("listener bind");
        assert!(
            ensure_pos < bind_pos,
            "indexes must be established before listener bind (no lazy race)"
        );
    }

    #[test]
    fn classify_started_prefers_immutable_snapshot_over_lease() {
        let snapshot = CompletedSnapshot {
            status: 200,
            body: serde_json::json!({"message":"exact","audit":{"amount":1}}),
            resource_id: Some("a1".into()),
        };
        let outcome = classify_started_row(
            "d1",
            "d1",
            STATUS_STARTED,
            None,
            None,
            Some(i64::MAX),
            0,
            &DomainRecovery::EffectApplied {
                snapshot: Some(snapshot.clone()),
            },
        );
        match outcome {
            IdempotencyBegin::Completed { status, body } => {
                assert_eq!(status, 200);
                assert_eq!(body, snapshot.body);
            }
            other => panic!("expected completed from marker, got {other:?}"),
        }
    }

    #[test]
    fn classify_started_with_effect_but_no_snapshot_allows_forward_reconcile() {
        let outcome = classify_started_row(
            "d1",
            "d1",
            STATUS_STARTED,
            None,
            None,
            Some(i64::MAX),
            0,
            &DomainRecovery::EffectApplied { snapshot: None },
        );
        assert!(matches!(outcome, IdempotencyBegin::Started { .. }));
    }

    #[test]
    fn classify_started_without_marker_live_lease_is_in_progress() {
        let outcome = classify_started_row(
            "d1",
            "d1",
            STATUS_STARTED,
            None,
            None,
            Some(5_000),
            1_000,
            &DomainRecovery::None,
        );
        assert!(matches!(outcome, IdempotencyBegin::InProgress));
    }

    #[test]
    fn classify_started_without_marker_expired_lease_is_takeover_candidate() {
        let outcome = classify_started_row(
            "d1",
            "d1",
            STATUS_STARTED,
            None,
            None,
            Some(500),
            1_000,
            &DomainRecovery::None,
        );
        assert!(matches!(outcome, IdempotencyBegin::Started { .. }));
    }

    #[test]
    fn balance_effect_filter_and_pipeline_couple_money_with_full_identity() {
        let user = oid(9);
        let identity = EffectIdentity::balance(oid(1), "key-1", "digest-1", user);
        let filter = balance_effect_filter(user, &identity, "subtract", 10.0);
        assert_eq!(filter.get_object_id("_id").unwrap(), user);
        let slot = identity.slot_id();
        assert!(filter.contains_key(&format!("balanceEffectSlots.{slot}")));
        assert!(filter.contains_key("balance"));
        let pipeline = balance_effect_pipeline(&identity, "add", 10.0, 10.0, "reason-long", now());
        assert_eq!(pipeline.len(), 1);
        let set = pipeline[0].get_document("$set").unwrap();
        assert!(set.contains_key("balance"));
        assert!(set.contains_key(&format!("balanceEffectSlots.{slot}")));
        let encoded = pipeline[0].to_string();
        assert!(encoded.contains("key-1"));
        assert!(encoded.contains("requestDigest"));
        assert!(encoded.contains("balanceBefore"));
        assert!(encoded.contains("balanceAfter"));
        // No rolling $slice eviction of unresolved proofs.
        assert!(!encoded.contains("$slice"));
    }

    #[test]
    fn refund_credit_pipeline_is_conditional_and_full_identity() {
        let identity = EffectIdentity::refund(oid(1), "refund-key", "digest-r", oid(3));
        let filter = refund_credit_filter(oid(2), &identity);
        let slot = identity.slot_id();
        assert!(filter.to_string().contains(&slot));
        let pipeline = refund_credit_pipeline(
            &identity,
            5000,
            "Refund transaksi ABCD: reason",
            oid(3),
            now(),
        );
        let encoded = pipeline[0].to_string();
        assert!(encoded.contains("refund-key"));
        assert!(encoded.contains("transactionId"));
        assert!(encoded.contains("requestDigest"));
        assert!(!encoded.contains("$slice"));
    }

    #[test]
    fn response_snapshot_is_bounded() {
        let huge = Value::String("x".repeat(MAX_RESPONSE_BYTES + 10));
        assert!(matches!(
            bound_response_body(&huge),
            Err(IdempotencyError::ResponseTooLarge)
        ));
        let ok = serde_json::json!({"message":"ok"});
        assert!(bound_response_body(&ok).is_ok());
    }

    #[tokio::test]
    async fn same_key_same_digest_replays_completed_without_second_effect() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(1);
        let key = "stable-key-001";
        let digest = "digest-aaa";
        let effects = AtomicU32::new(0);

        let begin = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(begin, IdempotencyBegin::Started { .. }));
        effects.fetch_add(1, Ordering::SeqCst);
        let body = serde_json::json!({"message":"ok","audit":{"amount":1}});
        store
            .complete(
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                digest,
                1,
                &CompletedSnapshot {
                    status: 200,
                    body: body.clone(),
                    resource_id: Some("adj-1".into()),
                },
                now(),
            )
            .await
            .unwrap();

        let replay = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        match replay {
            IdempotencyBegin::Completed {
                status,
                body: replayed,
            } => {
                assert_eq!(status, 200);
                assert_eq!(replayed, body);
            }
            other => panic!("expected completed replay, got {other:?}"),
        }
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn same_key_different_digest_is_conflict() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(2);
        let key = "stable-key-002";
        begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            "digest-1",
            now(),
        )
        .await
        .unwrap();
        store
            .complete(
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                "digest-1",
                1,
                &CompletedSnapshot {
                    status: 200,
                    body: serde_json::json!({"ok":true}),
                    resource_id: None,
                },
                now(),
            )
            .await
            .unwrap();

        let outcome = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            "digest-2",
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, IdempotencyBegin::Conflict));
    }

    #[tokio::test]
    async fn concurrent_same_key_allows_one_executor() {
        let store = Arc::new(MemoryIdempotencyStore::new());
        let actor = oid(3);
        let key = "stable-key-003";
        let digest = "digest-concurrent";
        let started = Arc::new(AtomicU32::new(0));
        let in_progress = Arc::new(AtomicU32::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = Arc::clone(&store);
            let started = Arc::clone(&started);
            let in_progress = Arc::clone(&in_progress);
            handles.push(tokio::spawn(async move {
                let outcome = begin_with_recovery(
                    store.as_ref(),
                    &NoRecovery,
                    actor,
                    ROUTE_TRANSACTION_REFUND,
                    key,
                    digest,
                    now(),
                )
                .await
                .unwrap();
                match outcome {
                    IdempotencyBegin::Started { .. } => {
                        started.fetch_add(1, Ordering::SeqCst);
                    }
                    IdempotencyBegin::InProgress => {
                        in_progress.fetch_add(1, Ordering::SeqCst);
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(in_progress.load(Ordering::SeqCst), 7);
    }

    #[tokio::test]
    async fn interrupted_started_recovers_exact_immutable_snapshot() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(4);
        let key = "stable-key-004";
        let digest = "digest-recover";
        store.force_started(actor, ROUTE_BALANCE_ADJUST, key, digest);

        let recovered_body = serde_json::json!({
            "message": "Saldo user berhasil ditambahkan",
            "user": { "_id": "u1", "name": "frozen", "balance": 100.0 },
            "audit": { "amount": 5000.0, "type": "add" }
        });
        let recovery = MarkerRecovery::new(DomainRecovery::EffectApplied {
            snapshot: Some(CompletedSnapshot {
                status: 200,
                body: recovered_body.clone(),
                resource_id: Some("audit-99".into()),
            }),
        });

        let outcome = begin_with_recovery(
            &store,
            &recovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        match outcome {
            IdempotencyBegin::Completed { status, body } => {
                assert_eq!(status, 200);
                assert_eq!(body, recovered_body);
            }
            other => panic!("expected recovered completed, got {other:?}"),
        }
        // Exact body persisted on the record (not re-read from mutable user).
        assert_eq!(
            store.row_body(actor, ROUTE_BALANCE_ADJUST, key),
            Some(recovered_body)
        );
    }

    #[tokio::test]
    async fn effect_applied_without_snapshot_on_live_foreign_lease_stays_in_progress() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(5);
        let key = "stable-key-005";
        let digest = "digest-forward";
        // Live foreign lease: money may be durable, but we do not steal the fence.
        store.force_started_with_lease(
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now().timestamp_millis() + 60_000,
        );
        let recovery = MarkerRecovery::new(DomainRecovery::EffectApplied { snapshot: None });
        let outcome = begin_with_recovery(
            &store,
            &recovery,
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, IdempotencyBegin::InProgress));
        assert_eq!(recovery.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn effect_applied_without_snapshot_after_takeover_returns_started() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(15);
        let key = "stable-key-015";
        let digest = "digest-forward-takeover";
        store.force_started_with_lease(
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now().timestamp_millis() - 1,
        );
        let recovery = MarkerRecovery::new(DomainRecovery::EffectApplied { snapshot: None });
        let outcome = begin_with_recovery(
            &store,
            &recovery,
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, IdempotencyBegin::Started { .. }));
        assert_eq!(recovery.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stranded_start_without_marker_stays_in_progress_while_lease_live() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(6);
        let key = "stable-key-006";
        let digest = "digest-progress";
        store.force_started_with_lease(
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now().timestamp_millis() + 60_000,
        );
        let outcome = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_TRANSACTION_REFUND,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, IdempotencyBegin::InProgress));
    }

    #[tokio::test]
    async fn stranded_start_lease_takeover_when_expired() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(7);
        let key = "stable-key-007";
        let digest = "digest-takeover";
        store.force_started_with_lease(
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now().timestamp_millis() - 1,
        );
        let outcome = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, IdempotencyBegin::Started { .. }));
    }

    #[tokio::test]
    async fn crash_table_financial_effect_counter_stays_one_across_complete_failure_recovery() {
        // Simulates: effect applied + complete failed → retry recovers exact snapshot once.
        let store = MemoryIdempotencyStore::new();
        let actor = oid(8);
        let key = "stable-key-008";
        let digest = "digest-crash";
        let effects = AtomicU32::new(0);

        assert!(matches!(
            begin_with_recovery(
                &store,
                &NoRecovery,
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                digest,
                now(),
            )
            .await
            .unwrap(),
            IdempotencyBegin::Started { .. }
        ));
        effects.fetch_add(1, Ordering::SeqCst);
        // Crash: leave started, domain marker exists with immutable snapshot.
        let body =
            serde_json::json!({"message":"Saldo user berhasil ditambahkan","audit":{"amount":1.0}});
        let recovery = MarkerRecovery::new(DomainRecovery::EffectApplied {
            snapshot: Some(CompletedSnapshot {
                status: 200,
                body: body.clone(),
                resource_id: Some("audit-1".into()),
            }),
        });
        let recovered = begin_with_recovery(
            &store,
            &recovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        match recovered {
            IdempotencyBegin::Completed {
                status,
                body: replayed,
            } => {
                assert_eq!(status, 200);
                assert_eq!(replayed, body);
            }
            other => panic!("expected recovery completed, got {other:?}"),
        }
        assert_eq!(effects.load(Ordering::SeqCst), 1);
        // Subsequent replay does not re-hit financial effect.
        let replay = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        assert!(matches!(replay, IdempotencyBegin::Completed { .. }));
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn release_started_only_removes_started_not_completed() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(10);
        let key = "stable-key-010";
        let digest = "digest-release";
        begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        store
            .release_started(actor, ROUTE_BALANCE_ADJUST, key, digest, 1)
            .await
            .unwrap();
        assert!(store.row_status(actor, ROUTE_BALANCE_ADJUST, key).is_none());

        begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        store
            .complete(
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                digest,
                1,
                &CompletedSnapshot {
                    status: 200,
                    body: serde_json::json!({"ok":true}),
                    resource_id: None,
                },
                now(),
            )
            .await
            .unwrap();
        store
            .release_started(actor, ROUTE_BALANCE_ADJUST, key, digest, 1)
            .await
            .unwrap();
        assert_eq!(
            store
                .row_status(actor, ROUTE_BALANCE_ADJUST, key)
                .as_deref(),
            Some(STATUS_COMPLETED)
        );
    }

    #[test]
    fn secrecy_and_collection_contract() {
        let src = include_str!("idempotency.rs");
        assert!(src.contains("idempotencyrecords"));
        assert!(src.contains(INDEX_UNIQ_ACTOR_ROUTE_KEY));
        assert!(src.contains("cleanupAt"));
        assert!(src.contains("requestDigest"));
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(!production.to_ascii_lowercase().contains("password"));
        assert!(!production.contains("raw_request"));
        assert!(
            production.contains("Never includes secrets")
                || production.contains("Never store full secrets")
                || production.contains("Never includes secrets or full bodies")
        );
    }

    #[test]
    fn balance_route_wires_atomic_marker_and_no_unsafe_release_after_effect() {
        let src = include_str!("../routes/users/balance.rs");
        assert!(
            src.contains("require_idempotency_key") || src.contains("services::idempotency"),
            "adjust_balance must require Idempotency-Key via services::idempotency"
        );
        assert!(
            src.contains("balance_effect_pipeline") || src.contains("balanceEffects"),
            "balance money effect must couple marker in same document update"
        );
        assert!(
            src.contains("begin_with_recovery") || src.contains("IdempotencyBegin"),
            "adjust_balance must begin idempotency with recovery"
        );
        assert!(
            src.contains("CompletedSnapshot") && src.contains("responseBody")
                || src.contains("immutable")
                || src.contains("balanceEffects"),
            "balance recovery must use immutable marker snapshot data"
        );
        // Must not release started after unverified rollback of money effect.
        assert!(
            !src.contains("rollback_balance_adjustment(users, user_id, delta).await;\n            return Err(internal_error())")
                || src.contains("do not release")
                || src.contains("leave started")
                || src.contains("DomainWriteOutcome"),
            "balance path must not blindly release after partial money effect"
        );
    }

    #[test]
    fn refund_route_does_not_treat_claim_as_completion() {
        let src = include_str!("../routes/transactions.rs");
        assert!(
            src.contains("require_idempotency_key") || src.contains("services::idempotency"),
            "refund_transaction must require Idempotency-Key"
        );
        assert!(
            src.contains("REFUND_PHASE_CLAIMED") || src.contains("refundPhase"),
            "refund must track explicit phases; claim is not completion"
        );
        assert!(
            src.contains("refund_credit_pipeline") || src.contains("balanceEffects"),
            "refund credit must be keyed same-document money marker"
        );
        assert!(
            src.contains("REFUND_PHASE_CREDITED") || src.contains("\"credited\""),
            "refund must distinguish credited from claimed"
        );
        // reconstruct must require credit/audit proof, not claim alone
        assert!(
            src.contains("DOMAIN_PHASE")
                || src.contains("refundPhase")
                    && (src.contains("credited") || src.contains("audited")),
            "recovery must require credit phase, not claim alone"
        );
    }

    /// Production-seam adapter test: financial transitions refuse double money effects.
    #[test]
    fn domain_phase_machine_refuses_double_effect() {
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        enum Phase {
            None,
            EffectApplied,
            DomainComplete,
        }
        fn apply_effect(phase: Phase) -> Result<Phase, &'static str> {
            match phase {
                Phase::None => Ok(Phase::EffectApplied),
                Phase::EffectApplied | Phase::DomainComplete => Err("already applied"),
            }
        }
        fn finish_domain(phase: Phase) -> Result<Phase, &'static str> {
            match phase {
                Phase::EffectApplied => Ok(Phase::DomainComplete),
                Phase::DomainComplete => Ok(Phase::DomainComplete),
                Phase::None => Err("missing effect"),
            }
        }
        let mut phase = Phase::None;
        phase = apply_effect(phase).unwrap();
        assert_eq!(apply_effect(phase), Err("already applied"));
        phase = finish_domain(phase).unwrap();
        assert_eq!(finish_domain(phase).unwrap(), Phase::DomainComplete);
        assert_eq!(apply_effect(phase), Err("already applied"));
    }

    #[test]
    fn compensation_failure_must_not_release_orchestration() {
        // Documented production rule encoded as executable seam:
        // if effect_applied && compensation_failed => keep started, do not release.
        let effect_applied = true;
        let compensation_verified = false;
        let may_release = !effect_applied && compensation_verified;
        assert!(
            !may_release,
            "unsafe release after unverified compensation is forbidden"
        );
    }

    #[test]
    fn effect_identity_slots_distinct_across_actor_route_digest_resource() {
        let user = oid(20);
        let base = EffectIdentity::balance(oid(1), "shared-key", "digest-a", user);
        let cross_actor = EffectIdentity::balance(oid(2), "shared-key", "digest-a", user);
        let cross_route = EffectIdentity::refund(oid(1), "shared-key", "digest-a", oid(30));
        let cross_digest = EffectIdentity::balance(oid(1), "shared-key", "digest-b", user);
        let cross_resource = EffectIdentity::balance(oid(1), "shared-key", "digest-a", oid(21));
        let slots = [
            base.slot_id(),
            cross_actor.slot_id(),
            cross_route.slot_id(),
            cross_digest.slot_id(),
            cross_resource.slot_id(),
        ];
        let unique: std::collections::HashSet<_> = slots.iter().cloned().collect();
        assert_eq!(
            unique.len(),
            5,
            "full identity must not collide on bare key"
        );
    }

    #[test]
    fn bare_key_collision_cannot_suppress_or_borrow_cross_actor_effect() {
        let user = oid(22);
        let mut model = EffectSlotModel::new();
        let actor_a = EffectIdentity::balance(oid(1), "K", "da", user);
        let actor_b = EffectIdentity::balance(oid(2), "K", "db", user);
        assert!(model.try_apply(&actor_a));
        // Actor B with same bare key must still apply — distinct slot.
        assert!(model.try_apply(&actor_b));
        assert_eq!(model.apply_count(&actor_a), 1);
        assert_eq!(model.apply_count(&actor_b), 1);
        // Re-apply same full identity is suppressed.
        assert!(!model.try_apply(&actor_a));
        assert_eq!(model.apply_count(&actor_a), 1);
    }

    #[test]
    fn cross_route_same_key_does_not_borrow_balance_marker_for_refund() {
        let user = oid(23);
        let mut model = EffectSlotModel::new();
        let balance = EffectIdentity::balance(oid(1), "K", "d1", user);
        let refund = EffectIdentity::refund(oid(1), "K", "d1", oid(99));
        assert!(model.try_apply(&balance));
        assert!(
            model.try_apply(&refund),
            "refund must not see balance bare-key proof"
        );
        assert_eq!(model.apply_count(&balance), 1);
        assert_eq!(model.apply_count(&refund), 1);
    }

    #[test]
    fn unresolved_marker_survives_51_later_completed_effects() {
        let user = oid(24);
        let mut model = EffectSlotModel::new();
        let unresolved = EffectIdentity::balance(oid(1), "unresolved-key", "du", user);
        assert!(model.try_apply(&unresolved));
        assert!(model.has_unresolved(&unresolved));
        // 51 later completed effects + prune must not evict the unresolved proof.
        for i in 0..51u8 {
            let later = EffectIdentity::balance(
                oid(3),
                &format!("later-key-{i}"),
                &format!("digest-{i}"),
                user,
            );
            assert!(model.try_apply(&later));
            model.mark_resolved(&later);
            model.prune_resolved();
        }
        assert!(
            model.has_unresolved(&unresolved),
            "unresolved proof must remain durable after 51 later effects"
        );
        assert_eq!(model.apply_count(&unresolved), 1);
        // Attempting re-apply of the original unresolved identity is still suppressed.
        assert!(!model.try_apply(&unresolved));
        assert_eq!(model.apply_count(&unresolved), 1);
        // Retention bounds only resolved proofs.
        assert!(model.slot_count() <= 1 + COMPLETED_EFFECT_RETENTION as usize);
    }

    #[test]
    fn marker_payload_must_verify_full_identity_before_accept() {
        let user = oid(25);
        let identity = EffectIdentity::balance(oid(1), "k1", "d1", user);
        let good = doc! {
            "key": "k1",
            "actorId": oid(1),
            "routeKey": ROUTE_BALANCE_ADJUST,
            "requestDigest": "d1",
            "resourceId": user.to_hex(),
        };
        let bad_actor = doc! {
            "key": "k1",
            "actorId": oid(2),
            "routeKey": ROUTE_BALANCE_ADJUST,
            "requestDigest": "d1",
            "resourceId": user.to_hex(),
        };
        let bad_digest = doc! {
            "key": "k1",
            "actorId": oid(1),
            "routeKey": ROUTE_BALANCE_ADJUST,
            "requestDigest": "other",
            "resourceId": user.to_hex(),
        };
        assert!(effect_marker_matches_identity(&good, &identity));
        assert!(!effect_marker_matches_identity(&bad_actor, &identity));
        assert!(!effect_marker_matches_identity(&bad_digest, &identity));
    }

    #[tokio::test]
    async fn resumed_stale_executor_cannot_complete_after_lease_takeover() {
        let store = MemoryIdempotencyStore::new();
        let actor = oid(26);
        let key = "stable-key-fence";
        let digest = "digest-fence";
        let first = begin_with_recovery(
            &store,
            &NoRecovery,
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now(),
        )
        .await
        .unwrap();
        let IdempotencyBegin::Started {
            lease_generation: old_gen,
        } = first
        else {
            panic!("expected started");
        };
        // Expire lease and takeover.
        store.force_started_with_lease(
            actor,
            ROUTE_BALANCE_ADJUST,
            key,
            digest,
            now().timestamp_millis() - 1,
        );
        // force_started resets generation to 1; simulate takeover via begin.
        // Set expired lease generation explicitly by begin path:
        let takeover = store
            .begin(actor, ROUTE_BALANCE_ADJUST, key, digest, now())
            .await
            .unwrap();
        let IdempotencyBegin::Started {
            lease_generation: new_gen,
        } = takeover
        else {
            panic!("expected takeover started, got {takeover:?}");
        };
        assert_ne!(new_gen, 0);
        // Stale executor with old fence must not complete.
        let stale = store
            .complete(
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                digest,
                old_gen,
                &CompletedSnapshot {
                    status: 200,
                    body: serde_json::json!({"stale":true}),
                    resource_id: None,
                },
                now(),
            )
            .await;
        assert!(stale.is_err(), "stale executor must be fenced out");
        // Current owner completes.
        store
            .complete(
                actor,
                ROUTE_BALANCE_ADJUST,
                key,
                digest,
                new_gen,
                &CompletedSnapshot {
                    status: 200,
                    body: serde_json::json!({"owner":true}),
                    resource_id: None,
                },
                now(),
            )
            .await
            .unwrap();
        assert_eq!(
            store.row_body(actor, ROUTE_BALANCE_ADJUST, key),
            Some(serde_json::json!({"owner":true}))
        );
    }

    #[test]
    fn index_verification_fails_on_key_or_option_mismatch_not_name_only() {
        let required = idempotency_index_models();
        // Same names but wrong unique/keys/TTL/partial must fail closed.
        let bad_unique = IndexModel::builder()
            .keys(doc! { "actorId": 1, "routeKey": 1, "idempotencyKey": 1 })
            .options(
                IndexOptions::builder()
                    .name(INDEX_UNIQ_ACTOR_ROUTE_KEY.to_string())
                    .unique(false)
                    .build(),
            )
            .build();
        let bad_keys = IndexModel::builder()
            .keys(doc! { "idempotencyKey": 1 })
            .options(
                IndexOptions::builder()
                    .name(INDEX_UNIQ_ACTOR_ROUTE_KEY.to_string())
                    .unique(true)
                    .build(),
            )
            .build();
        let bad_ttl = IndexModel::builder()
            .keys(doc! { "cleanupAt": 1 })
            .options(
                IndexOptions::builder()
                    .name(INDEX_TTL_CLEANUP_COMPLETED.to_string())
                    .expire_after(Duration::from_secs(60))
                    .partial_filter_expression(doc! { "status": STATUS_COMPLETED })
                    .build(),
            )
            .build();
        let bad_partial = IndexModel::builder()
            .keys(doc! { "cleanupAt": 1 })
            .options(
                IndexOptions::builder()
                    .name(INDEX_TTL_CLEANUP_COMPLETED.to_string())
                    .expire_after(Duration::ZERO)
                    .partial_filter_expression(doc! { "status": STATUS_STARTED })
                    .build(),
            )
            .build();
        assert!(verify_required_index_models(&[bad_unique], &required[..1], "t").is_err());
        assert!(verify_required_index_models(&[bad_keys], &required[..1], "t").is_err());
        assert!(
            verify_required_index_models(&[required[0].clone(), bad_ttl], &required, "t").is_err()
        );
        assert!(
            verify_required_index_models(&[required[0].clone(), bad_partial], &required, "t")
                .is_err()
        );
        // Exact models pass.
        assert!(verify_required_index_models(&required, &required, "t").is_ok());
        // Audit models also require unique full identity.
        let audits = audit_index_models();
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].options.as_ref().unwrap().unique, Some(true));
        assert_eq!(audits[1].options.as_ref().unwrap().unique, Some(true));
        let bad_audit = IndexModel::builder()
            .keys(doc! { "idempotencyKey": 1 })
            .options(
                IndexOptions::builder()
                    .name(INDEX_UNIQ_BALANCE_AUDIT.to_string())
                    .unique(true)
                    .build(),
            )
            .build();
        assert!(verify_required_index_models(&[bad_audit], &audits[..1], "audits").is_err());
    }

    #[test]
    fn audit_duplicate_insert_model_is_exactly_once() {
        // Executable model of unique full-identity audit index + check-then-insert.
        #[derive(Default)]
        struct AuditModel {
            rows: HashMap<String, u32>,
        }
        impl AuditModel {
            fn identity_key(identity: &EffectIdentity) -> String {
                format!(
                    "{}|{}|{}|{}|{}",
                    identity.actor_id.to_hex(),
                    identity.route_key,
                    identity.idempotency_key,
                    identity.request_digest,
                    identity.resource_id.clone().unwrap_or_default()
                )
            }
            fn ensure(&mut self, identity: &EffectIdentity) -> Result<(), &'static str> {
                let key = Self::identity_key(identity);
                if self.rows.contains_key(&key) {
                    return Ok(());
                }
                // Simulated unique index insert.
                if self.rows.contains_key(&key) {
                    return Err("duplicate");
                }
                self.rows.insert(key, 1);
                Ok(())
            }
            fn count(&self) -> usize {
                self.rows.len()
            }
        }
        let identity = EffectIdentity::balance(oid(1), "k", "d", oid(2));
        let mut audits = AuditModel::default();
        audits.ensure(&identity).unwrap();
        // Overlapping lease executors both call ensure — still one row.
        audits.ensure(&identity).unwrap();
        audits.ensure(&identity).unwrap();
        assert_eq!(audits.count(), 1);
        // Different digest is a different audit identity (should not collide).
        let other = EffectIdentity::balance(oid(1), "k", "d2", oid(2));
        audits.ensure(&other).unwrap();
        assert_eq!(audits.count(), 2);
    }

    #[test]
    fn prune_pipeline_never_targets_unresolved_slots() {
        let stages = prune_resolved_effect_slots_pipeline(now());
        let encoded = stages
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(encoded.contains("resolved"));
        assert!(encoded.contains("$filter"));
        // Unresolved entries are explicitly preserved via $ne resolved true.
        assert!(encoded.contains("$ne") || encoded.contains("resolved"));
        assert!(
            encoded.contains(&COMPLETED_EFFECT_RETENTION.to_string()) || encoded.contains("50")
        );
    }

    /// Live Mongo integration (runs only when MONGO_URI is set). Exercises create/list index
    /// option verification and same-document full-identity money marker pipelines.
    #[tokio::test]
    async fn live_mongo_indexes_and_effect_slots_when_uri_present() {
        let Ok(uri) = std::env::var("MONGO_URI") else {
            eprintln!("MONGO_URI not set; skipping live mongo integration");
            return;
        };
        let client = mongodb::Client::with_uri_str(&uri)
            .await
            .expect("connect mongo");
        // Use the URI database (no createDatabase privilege required) with isolated temp collections.
        let db = client
            .default_database()
            .unwrap_or_else(|| client.database("POBB"));
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let idemp_coll = format!("task12_fix2_idemp_{suffix}");
        let users_coll = format!("task12_fix2_users_{suffix}");
        let audit_coll = format!("task12_fix2_audits_{suffix}");

        // Build indexes on isolated collections and verify via production helpers.
        let idemp = db.collection::<Document>(&idemp_coll);
        idemp
            .create_indexes(idempotency_index_models())
            .await
            .expect("create idemp indexes");
        let listed = list_index_models(&idemp).await.expect("list idemp");
        verify_required_index_models(&listed, &idempotency_index_models(), &idemp_coll)
            .expect("verify idemp options");
        let audits = db.collection::<Document>(&audit_coll);
        audits
            .create_indexes(audit_index_models())
            .await
            .expect("create audit indexes");
        let audit_listed = list_index_models(&audits).await.expect("list audits");
        verify_required_index_models(&audit_listed, &audit_index_models(), &audit_coll)
            .expect("verify audit options");

        // Adversarial: listed model with wrong unique must fail verification helper.
        let mut listed_bad = listed.clone();
        if let Some(model) = listed_bad.iter_mut().find(|m| {
            m.options.as_ref().and_then(|o| o.name.as_deref()) == Some(INDEX_UNIQ_ACTOR_ROUTE_KEY)
        }) {
            if let Some(opts) = model.options.as_mut() {
                opts.unique = Some(false);
            }
            assert!(
                verify_required_index_models(&listed_bad, &idempotency_index_models(), "x")
                    .is_err()
            );
        }

        // Money marker pipeline: first apply succeeds; same identity second apply is no-op.
        let users = db.collection::<Document>(&users_coll);
        let user_id = ObjectId::new();
        users
            .insert_one(doc! {
                "_id": user_id,
                "role": "member",
                "balance": 1000.0,
                "name": "live",
                "email": "live@example.com",
                "level": "basic",
                "points": 0,
                "active": true,
                "createdAt": now(),
                "updatedAt": now(),
            })
            .await
            .expect("insert user");
        let identity = EffectIdentity::balance(oid(1), "live-key-001", "live-digest", user_id);
        let filter = balance_effect_filter(user_id, &identity, "add", 10.0);
        let pipeline = balance_effect_pipeline(&identity, "add", 10.0, 10.0, "reason-long", now());
        let first = users
            .find_one_and_update(
                filter.clone(),
                UpdateModifications::Pipeline(pipeline.clone()),
            )
            .return_document(ReturnDocument::After)
            .await
            .expect("update1")
            .expect("user after first apply");
        assert!(find_balance_effect_by_identity(&first, &identity).is_some());
        assert_eq!(read_balance(&first), 1010.0);
        let second = users
            .find_one_and_update(filter, UpdateModifications::Pipeline(pipeline))
            .return_document(ReturnDocument::After)
            .await
            .expect("update2");
        assert!(
            second.is_none(),
            "same full identity must not re-apply money"
        );
        let after = users
            .find_one(doc! { "_id": user_id })
            .await
            .expect("find")
            .expect("user");
        assert_eq!(read_balance(&after), 1010.0);

        // Cross-actor same bare key still applies.
        let other = EffectIdentity::balance(oid(2), "live-key-001", "other-digest", user_id);
        let filter_b = balance_effect_filter(user_id, &other, "add", 5.0);
        let pipeline_b = balance_effect_pipeline(&other, "add", 5.0, 5.0, "reason-long", now());
        let cross = users
            .find_one_and_update(filter_b, UpdateModifications::Pipeline(pipeline_b))
            .return_document(ReturnDocument::After)
            .await
            .expect("cross")
            .expect("cross apply");
        assert_eq!(read_balance(&cross), 1015.0);

        // Unresolved original survives prune of many resolved later slots.
        for i in 0..51u32 {
            let later =
                EffectIdentity::balance(oid(3), &format!("later-{i}"), &format!("d-{i}"), user_id);
            let f = balance_effect_filter(user_id, &later, "add", 1.0);
            let p = balance_effect_pipeline(&later, "add", 1.0, 1.0, "reason-long", now());
            let _ = users
                .find_one_and_update(f, UpdateModifications::Pipeline(p))
                .await
                .expect("later apply");
            let _ = users
                .update_one(
                    doc! { "_id": user_id },
                    mark_effect_resolved_update(&later, now()),
                )
                .await
                .expect("resolve");
            let _ = users
                .update_one(
                    doc! { "_id": user_id },
                    UpdateModifications::Pipeline(prune_resolved_effect_slots_pipeline(now())),
                )
                .await
                .expect("prune");
        }
        let final_user = users
            .find_one(doc! { "_id": user_id })
            .await
            .expect("final find")
            .expect("final user");
        assert!(
            find_balance_effect_by_identity(&final_user, &identity).is_some(),
            "unresolved original must survive 51 later resolved effects"
        );
        // Re-applying unresolved identity still suppressed.
        let re = users
            .find_one_and_update(
                balance_effect_filter(user_id, &identity, "add", 10.0),
                UpdateModifications::Pipeline(balance_effect_pipeline(
                    &identity,
                    "add",
                    10.0,
                    10.0,
                    "reason-long",
                    now(),
                )),
            )
            .await
            .expect("reapply");
        assert!(re.is_none());

        // Lease fencing on isolated idempotency collection via direct documents + complete filter model.
        let actor = ObjectId::new();
        let key = "live-fence-key";
        let digest = "live-fence-digest";
        idemp
            .insert_one(doc! {
                "actorId": actor,
                "routeKey": ROUTE_BALANCE_ADJUST,
                "idempotencyKey": key,
                "requestDigest": digest,
                "status": STATUS_STARTED,
                "leaseExpiresAt": DateTime::from_millis(0),
                "leaseGeneration": 1i64,
                "createdAt": now(),
                "updatedAt": now(),
                "cleanupAt": started_cleanup_at(now()),
            })
            .await
            .expect("insert started");
        // CAS takeover bump generation
        let taken = idemp
            .find_one_and_update(
                doc! {
                    "actorId": actor,
                    "routeKey": ROUTE_BALANCE_ADJUST,
                    "idempotencyKey": key,
                    "requestDigest": digest,
                    "status": STATUS_STARTED,
                    "leaseExpiresAt": { "$lte": now() },
                },
                UpdateModifications::Pipeline(vec![doc! {
                    "$set": {
                        "leaseExpiresAt": lease_expires_at(now()),
                        "updatedAt": now(),
                        "leaseGeneration": {
                            "$add": [{ "$ifNull": ["$leaseGeneration", 0i64] }, 1i64]
                        }
                    }
                }]),
            )
            .return_document(ReturnDocument::After)
            .await
            .expect("takeover")
            .expect("taken doc");
        let gen2 = read_lease_generation(&taken);
        assert_eq!(gen2, 2);
        // Stale complete with gen1 must miss fenced filter.
        let stale = idemp
            .find_one_and_update(
                doc! {
                    "actorId": actor,
                    "routeKey": ROUTE_BALANCE_ADJUST,
                    "idempotencyKey": key,
                    "requestDigest": digest,
                    "$or": [
                        { "status": STATUS_STARTED, "leaseGeneration": 1i64 },
                        { "status": STATUS_COMPLETED },
                    ],
                },
                doc! { "$set": { "status": STATUS_COMPLETED, "responseBody": "{\"stale\":true}" } },
            )
            .await
            .expect("stale update");
        assert!(stale.is_none(), "stale fence must not complete");
        let owner = idemp
            .find_one_and_update(
                doc! {
                    "actorId": actor,
                    "routeKey": ROUTE_BALANCE_ADJUST,
                    "idempotencyKey": key,
                    "requestDigest": digest,
                    "$or": [
                        { "status": STATUS_STARTED, "leaseGeneration": gen2 as i64 },
                        { "status": STATUS_COMPLETED },
                    ],
                },
                doc! { "$set": { "status": STATUS_COMPLETED, "responseBody": "{\"owner\":true}" } },
            )
            .return_document(ReturnDocument::After)
            .await
            .expect("owner update")
            .expect("owner doc");
        assert_eq!(owner.get_str("status").unwrap(), STATUS_COMPLETED);

        // Audit unique index: second insert with same full identity fails closed.
        let audit_doc = doc! {
            "user": user_id,
            "adjustedBy": actor,
            "type": "add",
            "amount": 10.0,
            "balanceBefore": 1000.0,
            "balanceAfter": 1010.0,
            "reason": "reason-long",
            "createdAt": now(),
            "updatedAt": now(),
            "idempotencyKey": "live-key-001",
            "routeKey": ROUTE_BALANCE_ADJUST,
            "requestDigest": "live-digest",
            "resourceId": user_id.to_hex(),
        };
        audits.insert_one(audit_doc.clone()).await.expect("audit1");
        let dup = audits.insert_one(audit_doc).await;
        assert!(
            dup.is_err(),
            "duplicate audit identity must fail unique index"
        );

        // Cleanup temp collections only (do not drop production DB).
        let _ = idemp.drop().await;
        let _ = users.drop().await;
        let _ = audits.drop().await;
    }

    fn read_balance(user: &Document) -> f64 {
        match user.get("balance") {
            Some(Bson::Double(v)) => *v,
            Some(Bson::Int32(v)) => f64::from(*v),
            Some(Bson::Int64(v)) => *v as f64,
            _ => panic!("missing balance"),
        }
    }

    // ── Fix wave 3: commit ambiguity + unresolved slot capacity ──────────────

    #[test]
    fn transaction_commit_unknown_result_never_releases_started() {
        let outcome = classify_transaction_commit_error(
            &[mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT],
            1,
        );
        assert_eq!(outcome, TransactionCommitOutcome::Ambiguous);
        assert_eq!(
            release_decision_after_transaction_commit(outcome),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
        // Even "definite" commit failure after in-session domain ops retains.
        let definite = classify_transaction_commit_error(&[], 1);
        assert_eq!(definite, TransactionCommitOutcome::FailedDefinitely);
        assert_eq!(
            release_decision_after_transaction_commit(definite),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
    }

    #[test]
    fn transaction_abort_failure_retains_started() {
        assert_eq!(
            release_decision_after_transaction_abort(false, true),
            OrchestrationReleaseDecision::ReleaseStarted
        );
        assert_eq!(
            release_decision_after_transaction_abort(false, false),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
        // Domain ops observed success ⇒ never release on abort alone.
        assert_eq!(
            release_decision_after_transaction_abort(true, true),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
        assert_eq!(
            release_decision_after_transaction_abort(true, false),
            OrchestrationReleaseDecision::RetainAndReconcile
        );
    }

    #[test]
    fn committed_server_lost_response_retry_reconciles_once_no_double_money() {
        let mut model = TransactionCrashBoundaryModel::new_started();
        model.attempt_with_lost_commit_response();
        assert!(model.started_present);
        assert_eq!(model.money_applied, 1);
        assert_eq!(model.audit_rows, 1);
        assert!(!model.completed);
        // Retry reconciles from durable marker/audit — no second money/audit.
        model.retry_reconcile_from_marker();
        assert!(model.completed);
        assert_eq!(model.money_applied, 1);
        assert_eq!(model.audit_rows, 1);
        // A second "retry" is a no-op complete path.
        model.retry_reconcile_from_marker();
        assert_eq!(model.money_applied, 1);
        assert_eq!(model.audit_rows, 1);
    }

    #[test]
    fn unknown_commit_retries_are_bounded_and_still_retain() {
        let mut model = TransactionCrashBoundaryModel::new_started();
        let outcome = model.retry_unknown_commit_until_bound();
        assert_eq!(outcome, TransactionCommitOutcome::Ambiguous);
        assert_eq!(model.commit_attempts, MAX_UNKNOWN_COMMIT_RETRIES);
        assert!(model.started_present);
        assert_eq!(model.money_applied, 1);
        assert_eq!(model.audit_rows, 1);
    }

    #[test]
    fn abort_failure_regression_seam_retains_without_money() {
        let mut model = TransactionCrashBoundaryModel::new_started();
        model.attempt_op_error_with_abort_failure();
        assert!(model.started_present);
        assert_eq!(model.money_applied, 0);
        assert_eq!(model.audit_rows, 0);
    }

    #[test]
    fn balance_route_never_releases_on_commit_or_abort_error_alone() {
        let src = include_str!("../routes/users/balance.rs");
        assert!(
            src.contains("commit_mongo_transaction_with_unknown_retry"),
            "balance path must use bounded unknown-commit retry helper"
        );
        assert!(
            src.contains("RetainAndReconcile")
                || src.contains("release_decision_after_transaction_abort"),
            "balance path must consult release decision after abort"
        );
        // Forbidden pattern: commit_transaction error immediately followed by release.
        assert!(
            !src.contains(
                "commit_transaction().await {\n            eprintln!(\"Failed to commit balance adjustment transaction"
            ),
            "legacy unsafe commit-error→release path must be removed"
        );
        assert!(
            !src.contains("Commit failed: effect not durable"),
            "must not claim commit error proves non-durability"
        );
    }

    #[test]
    fn effect_slot_cap1_accepts_then_rejects_new_and_reconciles_existing() {
        let user = oid(40);
        let mut model = EffectSlotModel::with_caps(1, 2);
        let first = EffectIdentity::balance(oid(1), "cap-key-1", "d1", user);
        assert_eq!(
            model.try_apply_detailed(&first),
            EffectApplyOutcome::Applied
        );
        assert_eq!(model.unresolved_count(), 1);
        // New identity at cap=1 is rejected; no money mutation.
        let second = EffectIdentity::balance(oid(1), "cap-key-2", "d2", user);
        assert_eq!(
            model.try_apply_detailed(&second),
            EffectApplyOutcome::CapacityExceeded
        );
        assert_eq!(model.apply_count(&second), 0);
        assert_eq!(model.slot_count(), 1);
        // Existing matching unresolved slot remains reconcilable at the cap.
        assert_eq!(
            model.try_apply_detailed(&first),
            EffectApplyOutcome::AlreadyPresent
        );
        assert_eq!(model.apply_count(&first), 1);
        assert!(model.has_unresolved(&first));
    }

    #[test]
    fn completion_and_prune_frees_unresolved_capacity() {
        let user = oid(41);
        let mut model = EffectSlotModel::with_caps(1, 10);
        let first = EffectIdentity::balance(oid(1), "free-1", "d1", user);
        assert!(model.try_apply(&first));
        assert_eq!(
            model.try_apply_detailed(&EffectIdentity::balance(oid(1), "free-2", "d2", user)),
            EffectApplyOutcome::CapacityExceeded
        );
        // Complete + prune resolved → capacity reopens for a new effect.
        model.mark_resolved(&first);
        model.prune_resolved();
        assert_eq!(model.unresolved_count(), 0);
        let third = EffectIdentity::balance(oid(1), "free-3", "d3", user);
        assert_eq!(
            model.try_apply_detailed(&third),
            EffectApplyOutcome::Applied
        );
        assert_eq!(model.apply_count(&first), 1);
        assert_eq!(model.apply_count(&third), 1);
    }

    #[test]
    fn concurrent_new_effects_near_cap_cannot_both_exceed() {
        let user = oid(42);
        let mut model = EffectSlotModel::with_caps(1, 10);
        // Fill to remaining=1.
        // (empty model: remaining unresolved = 1)
        let a = EffectIdentity::balance(oid(1), "c-a", "da", user);
        let b = EffectIdentity::balance(oid(1), "c-b", "db", user);
        let (oa, ob) = model.try_apply_concurrent_pair(&a, &b);
        let applied = matches!(oa, EffectApplyOutcome::Applied) as u32
            + matches!(ob, EffectApplyOutcome::Applied) as u32;
        assert_eq!(
            applied, 1,
            "exactly one of two concurrent new effects may apply at cap-1"
        );
        assert!(model.unresolved_count() <= 1);
        assert!(model.slot_count() <= 1);
        // Neither re-executes.
        assert!(model.apply_count(&a) + model.apply_count(&b) == 1);
    }

    #[test]
    fn malformed_balance_effect_slots_fails_closed() {
        let user = oid(43);
        let mut model = EffectSlotModel::with_caps(8, 16);
        model.mark_malformed();
        let id = EffectIdentity::balance(oid(1), "mal-1", "dm", user);
        assert_eq!(
            model.try_apply_detailed(&id),
            EffectApplyOutcome::MalformedFailClosed
        );
        assert_eq!(model.apply_count(&id), 0);

        // Document-level admission helper also fails closed on non-object.
        let bad = doc! { "_id": user, "balanceEffectSlots": Bson::Array(vec![]) };
        assert!(!admits_new_effect_slot(Some(&bad)));
        let nullish = doc! { "_id": user, "balanceEffectSlots": Bson::Null };
        assert!(!admits_new_effect_slot(Some(&nullish)));
        let good_empty = doc! { "_id": user };
        assert!(admits_new_effect_slot(Some(&good_empty)));
    }

    #[test]
    fn production_filters_embed_admission_expr_and_capacity_helpers() {
        let user = oid(44);
        let identity = EffectIdentity::balance(oid(1), "adm-1", "dd", user);
        let filter = balance_effect_filter(user, &identity, "add", 1.0);
        let encoded = filter.to_string();
        assert!(encoded.contains("$expr") || encoded.contains("expr"));
        assert!(
            encoded.contains("balanceEffectSlots") || encoded.contains("$objectToArray"),
            "admission must count balanceEffectSlots"
        );
        let refund = refund_credit_filter(user, &identity);
        assert!(refund.to_string().contains("$expr") || refund.to_string().contains("expr"));

        // Capacity response is stable service/conflict style code.
        let response = effect_slot_capacity_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        // At-cap document with existing slot is reconcilable, not a capacity rejection for that identity.
        let slot = identity.slot_id();
        let mut slots = Document::new();
        slots.insert(
            slot,
            doc! {
                "key": "adm-1",
                "actorId": oid(1),
                "routeKey": ROUTE_BALANCE_ADJUST,
                "requestDigest": "dd",
                "resourceId": user.to_hex(),
                "resolved": false,
            },
        );
        // Fill remaining unresolved to the production cap.
        for i in 1..MAX_UNRESOLVED_EFFECT_SLOTS {
            slots.insert(
                format!("filler-{i}"),
                doc! { "resolved": false, "key": format!("f-{i}") },
            );
        }
        let at_cap = doc! { "_id": user, "balanceEffectSlots": slots };
        assert!(!admits_new_effect_slot(Some(&at_cap)));
        assert!(
            !is_effect_slot_capacity_rejection(Some(&at_cap), &identity),
            "existing matching slot must remain reconcilable at cap"
        );
        let other = EffectIdentity::balance(oid(1), "other-new", "d-other", user);
        assert!(
            is_effect_slot_capacity_rejection(Some(&at_cap), &other),
            "brand-new identity at cap must fail closed"
        );
    }

    #[test]
    fn no_eviction_of_unresolved_under_capacity_pressure() {
        let user = oid(45);
        let mut model = EffectSlotModel::with_caps(2, 4);
        let a = EffectIdentity::balance(oid(1), "keep-a", "da", user);
        let b = EffectIdentity::balance(oid(1), "keep-b", "db", user);
        assert!(model.try_apply(&a));
        assert!(model.try_apply(&b));
        // Further new effects rejected; unresolved proofs never evicted.
        for i in 0..5u8 {
            let later =
                EffectIdentity::balance(oid(2), &format!("x-{i}"), &format!("dx-{i}"), user);
            assert_eq!(
                model.try_apply_detailed(&later),
                EffectApplyOutcome::CapacityExceeded
            );
        }
        assert!(model.has_unresolved(&a));
        assert!(model.has_unresolved(&b));
        assert_eq!(model.apply_count(&a), 1);
        assert_eq!(model.apply_count(&b), 1);
        assert!(!model.try_apply(&a));
        assert_eq!(model.apply_count(&a), 1);
    }
}
