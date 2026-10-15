//! Durable slider claims stored in `content_mutation_replies`.
//!
//! A claim is coordination, not an execution engine. Recovery reads the frozen reply and the
//! candidate row; it never runs the mutation again.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use super::SLIDER_MUTATION_CONTRACT;

pub const SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION: &str = "content_mutation_replies";
pub const SLIDER_CLAIM_LEASE_SECONDS: i64 = 5 * 60;
const OPERATION: &str = "slider";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliderClaimBinding {
    pub key: String,
    pub contract_version: String,
    pub operator_id: Uuid,
    pub action: String,
    pub target_id: Option<Uuid>,
    pub expected_revision: i64,
    pub payload_digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SliderClaimBegin {
    Started { claim_token: String, lease_generation: i64 },
    Completed { status: u16, body: Value, result_revision: Option<i64> },
    Conflict,
    InProgress,
    CommitUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderClaimError {
    Storage,
    InvalidKey,
    Fenced,
}

pub fn normalize_slider_idempotency_key(raw: &str) -> Result<String, SliderClaimError> {
    let key = raw.trim();
    if !(8..=128).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')) {
        return Err(SliderClaimError::InvalidKey);
    }
    Ok(key.to_string())
}

pub fn normalize_slider_claim_binding(binding: &SliderClaimBinding) -> Result<SliderClaimBinding, SliderClaimError> {
    Ok(SliderClaimBinding { key: normalize_slider_idempotency_key(&binding.key)?, contract_version: SLIDER_MUTATION_CONTRACT.to_string(), ..binding.clone() })
}

struct ClaimRow {
    digest: String,
    status: i32,
    response: Value,
    state: String,
    claim_token: String,
    lease_generation: i64,
    lease_expires_at: Option<DateTime<Utc>>,
    transaction_started_at: Option<DateTime<Utc>>,
    commit_unknown: bool,
    candidate_slider_id: Option<Uuid>,
    result_revision: Option<i64>,
}

fn claim_from(row: &sqlx::postgres::PgRow) -> ClaimRow {
    ClaimRow {
        digest: row.get("digest"),
        status: row.get("status"),
        response: row.get("response"),
        state: row.get("state"),
        claim_token: row.get("claim_token"),
        lease_generation: row.get("lease_generation"),
        lease_expires_at: row.get("lease_expires_at"),
        transaction_started_at: row.get("transaction_started_at"),
        commit_unknown: row.get("commit_unknown"),
        candidate_slider_id: row.get("candidate_slider_id"),
        result_revision: row.get("result_revision"),
    }
}

async fn load_claim(executor: &PgPool, actor: Uuid, key: &str) -> Result<Option<ClaimRow>, sqlx::Error> {
    Ok(sqlx::query(
        "SELECT digest, status, response, state, claim_token, lease_generation, lease_expires_at, transaction_started_at, commit_unknown, candidate_slider_id, result_revision \
         FROM content_mutation_replies WHERE actor=$1 AND operation=$2 AND key=$3",
    ).bind(actor).bind(OPERATION).bind(key).fetch_optional(executor).await?.map(|row| claim_from(&row)))
}

fn classify(row: &ClaimRow, digest: &str, now: DateTime<Utc>) -> SliderClaimBegin {
    if row.digest != digest { return SliderClaimBegin::Conflict; }
    if row.state == "completed" {
        return SliderClaimBegin::Completed { status: row.status as u16, body: replay(row.response.clone()), result_revision: row.result_revision };
    }
    if row.commit_unknown || row.transaction_started_at.is_some() { return SliderClaimBegin::CommitUnknown; }
    if row.lease_expires_at.is_some_and(|expiry| expiry > now) { return SliderClaimBegin::InProgress; }
    SliderClaimBegin::Started { claim_token: String::new(), lease_generation: row.lease_generation }
}

fn replay(mut stored: Value) -> Value {
    if let Some(object) = stored.as_object_mut() { object.insert("replayed".to_string(), Value::Bool(true)); }
    stored
}

/// Insert a new claim or take over an expired one. A live lease or unknown commit is returned as-is.
pub async fn begin_slider_claim(pool: &PgPool, binding: &SliderClaimBinding) -> Result<SliderClaimBegin, SliderClaimError> {
    let now = Utc::now();
    if let Some(existing) = load_claim(pool, binding.operator_id, &binding.key).await.map_err(|_| SliderClaimError::Storage)? {
        let classified = classify(&existing, &binding.payload_digest, now);
        if !matches!(classified, SliderClaimBegin::Started { .. }) { return Ok(classified); }
    }
    let token = Uuid::new_v4().simple().to_string();
    let expiry = now + Duration::seconds(SLIDER_CLAIM_LEASE_SECONDS);
    let row = sqlx::query(
        "INSERT INTO content_mutation_replies(actor, operation, key, digest, status, response, state, claim_token, lease_generation, lease_expires_at, claimed_at, updated_at) \
         VALUES($1, $2, $3, $4, 0, 'null'::jsonb, 'in_progress', $5, 1, $6, $7, $7) \
         ON CONFLICT (actor, operation, key) DO UPDATE SET \
           digest=EXCLUDED.digest, state='in_progress', claim_token=EXCLUDED.claim_token, \
           lease_generation=content_mutation_replies.lease_generation+1, lease_expires_at=EXCLUDED.lease_expires_at, \
           claimed_at=EXCLUDED.claimed_at, updated_at=EXCLUDED.updated_at, status=0, response='null'::jsonb \
         WHERE content_mutation_replies.state<>'completed' AND content_mutation_replies.transaction_started_at IS NULL \
           AND content_mutation_replies.commit_unknown=false AND (content_mutation_replies.lease_expires_at IS NULL OR content_mutation_replies.lease_expires_at<=$7) \
           AND content_mutation_replies.digest=$4 \
         RETURNING claim_token, lease_generation",
    )
    .bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(&binding.payload_digest).bind(&token).bind(expiry).bind(now)
    .fetch_optional(pool).await.map_err(|_| SliderClaimError::Storage)?;
    if let Some(row) = row {
        return Ok(SliderClaimBegin::Started { claim_token: row.get("claim_token"), lease_generation: row.get("lease_generation") });
    }
    let current = load_claim(pool, binding.operator_id, &binding.key).await.map_err(|_| SliderClaimError::Storage)?;
    Ok(current.map(|row| classify(&row, &binding.payload_digest, Utc::now())).unwrap_or(SliderClaimBegin::InProgress))
}

pub async fn store_recovery_identifiers(
    pool: &PgPool,
    binding: &SliderClaimBinding,
    token: &str,
    generation: i64,
    candidate: Option<Uuid>,
    result_revision: i64,
) -> Result<(), SliderClaimError> {
    let changed = sqlx::query(
        "UPDATE content_mutation_replies SET candidate_slider_id=$6, candidate_result_revision=$7, recovery_ids_stored=true, updated_at=now() \
         WHERE actor=$1 AND operation=$2 AND key=$3 AND claim_token=$4 AND lease_generation=$5 AND state='in_progress' AND transaction_started_at IS NULL",
    ).bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(token).bind(generation).bind(candidate).bind(result_revision)
        .execute(pool).await.map_err(|_| SliderClaimError::Storage)?.rows_affected();
    if changed == 1 { Ok(()) } else { Err(SliderClaimError::Fenced) }
}

pub async fn mark_slider_transaction_started(pool: &PgPool, binding: &SliderClaimBinding, token: &str, generation: i64) -> Result<DateTime<Utc>, SliderClaimError> {
    let started = Utc::now();
    let changed = sqlx::query(
        "UPDATE content_mutation_replies SET transaction_started_at=$6, updated_at=now() \
         WHERE actor=$1 AND operation=$2 AND key=$3 AND claim_token=$4 AND lease_generation=$5 AND state='in_progress' AND transaction_started_at IS NULL",
    ).bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(token).bind(generation).bind(started)
        .execute(pool).await.map_err(|_| SliderClaimError::Storage)?.rows_affected();
    if changed == 1 { Ok(started) } else { Err(SliderClaimError::Fenced) }
}

pub async fn mark_slider_commit_unknown(pool: &PgPool, binding: &SliderClaimBinding, token: &str, generation: i64) -> Result<(), SliderClaimError> {
    sqlx::query(
        "UPDATE content_mutation_replies SET commit_unknown=true, updated_at=now() WHERE actor=$1 AND operation=$2 AND key=$3 AND claim_token=$4 AND lease_generation=$5",
    ).bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(token).bind(generation).execute(pool).await.map_err(|_| SliderClaimError::Storage)?;
    Ok(())
}

pub async fn release_slider_claim(pool: &PgPool, binding: &SliderClaimBinding, token: &str, generation: i64) -> Result<(), SliderClaimError> {
    sqlx::query(
        "UPDATE content_mutation_replies SET state='retryable', lease_expires_at=now(), updated_at=now() \
         WHERE actor=$1 AND operation=$2 AND key=$3 AND claim_token=$4 AND lease_generation=$5 AND transaction_started_at IS NULL AND commit_unknown=false",
    ).bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(token).bind(generation).execute(pool).await.map_err(|_| SliderClaimError::Storage)?;
    Ok(())
}

pub async fn complete_slider_claim(
    tx: &mut Transaction<'_, Postgres>,
    binding: &SliderClaimBinding,
    token: &str,
    generation: i64,
    status: i32,
    body: &Value,
    result_revision: i64,
) -> Result<(), SliderClaimError> {
    let changed = sqlx::query(
        "UPDATE content_mutation_replies SET state='completed', status=$6, response=$7, result_revision=$8, completed_at=now(), updated_at=now(), commit_unknown=false \
         WHERE actor=$1 AND operation=$2 AND key=$3 AND claim_token=$4 AND lease_generation=$5 AND state='in_progress'",
    ).bind(binding.operator_id).bind(OPERATION).bind(&binding.key).bind(token).bind(generation).bind(status).bind(body).bind(result_revision)
        .execute(&mut **tx).await.map_err(|_| SliderClaimError::Storage)?.rows_affected();
    if changed == 1 { Ok(()) } else { Err(SliderClaimError::Fenced) }
}

#[derive(Debug, Clone)]
pub struct SliderCommitRecovery {
    pub status: u16,
    pub body: Value,
    pub candidate_slider_id: Option<Uuid>,
}

pub async fn recover_slider_commit(pool: &PgPool, binding: &SliderClaimBinding) -> Result<Option<SliderCommitRecovery>, SliderClaimError> {
    let Some(row) = load_claim(pool, binding.operator_id, &binding.key).await.map_err(|_| SliderClaimError::Storage)? else { return Ok(None); };
    if row.digest != binding.payload_digest || row.state != "completed" { return Ok(None); }
    Ok(Some(SliderCommitRecovery { status: row.status as u16, body: replay(row.response), candidate_slider_id: row.candidate_slider_id }))
}
