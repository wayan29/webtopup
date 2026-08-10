//! Balance giveaway lottery: randomly distribute a fixed pool across N registered members.
//! Credits go through the same balance field as voucher redeem; each win is audited in
//! `userbalanceadjustments` and listed under the campaign document.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use mongodb::{error::ErrorKind, options::IndexOptions, ClientSession, IndexModel};
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{internal_error, status_message, unavailable};
use super::mappers::{id_from_doc, number_from_bson};
use crate::{
    routes::auth::require_trusted_step_up_group,
    security::require_permission,
    state::AppState,
    utils::bson::{read_i64, read_string},
};

const MAX_WINNERS: i64 = 100;
const MIN_WINNERS: i64 = 1;
const MAX_POOL: i64 = 100_000_000;
const LIST_LIMIT_DEFAULT: i64 = 20;
const GIVEAWAY_STATUS_IN_PROGRESS: &str = "in_progress";
const GIVEAWAY_STATUS_RETRYABLE: &str = "retryable";
const GIVEAWAY_STATUS_COMPLETED: &str = "completed";
const GIVEAWAY_STATUS_FIELD: &str = "status";

#[derive(Deserialize)]
pub struct GiveawayListQuery {
    page: Option<i64>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct GiveawayPayload {
    name: Option<Value>,
    #[serde(rename = "totalPool")]
    total_pool: Option<Value>,
    #[serde(rename = "winnerCount")]
    winner_count: Option<Value>,
    #[serde(rename = "minAmount")]
    min_amount: Option<Value>,
    #[serde(rename = "maxAmount")]
    max_amount: Option<Value>,
    note: Option<Value>,
    /// all | has_transactions | emails
    #[serde(rename = "participantFilter")]
    participant_filter: Option<Value>,
    /// Newline/comma separated emails when participantFilter=emails.
    emails: Option<Value>,
    /// When set, re-run the same random draw as a previous preview (auditability).
    seed: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
struct WinnerPreview {
    #[serde(rename = "userId")]
    user_id: String,
    name: String,
    email: String,
    amount: i64,
}

#[derive(Serialize)]
struct GiveawayPreviewResponse {
    name: String,
    #[serde(rename = "totalPool")]
    total_pool: i64,
    #[serde(rename = "winnerCount")]
    winner_count: i64,
    #[serde(rename = "minAmount")]
    min_amount: i64,
    #[serde(rename = "maxAmount")]
    max_amount: i64,
    note: String,
    #[serde(rename = "participantFilter")]
    participant_filter: String,
    #[serde(rename = "eligibleMembers")]
    eligible_members: i64,
    winners: Vec<WinnerPreview>,
    #[serde(rename = "allocatedTotal")]
    allocated_total: i64,
    #[serde(rename = "seed")]
    seed: String,
    #[serde(rename = "executionAvailable")]
    execution_available: bool,
}

#[derive(Serialize)]
struct GiveawayListItem {
    #[serde(rename = "_id")]
    id: String,
    name: String,
    #[serde(rename = "totalPool")]
    total_pool: i64,
    #[serde(rename = "winnerCount")]
    winner_count: i64,
    status: String,
    note: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "createdBy")]
    created_by: Option<UserBrief>,
    #[serde(rename = "allocatedTotal")]
    allocated_total: i64,
}

#[derive(Clone, Serialize)]
struct UserBrief {
    #[serde(rename = "_id")]
    id: String,
    name: String,
    email: String,
}

#[derive(Serialize)]
struct GiveawayDetail {
    #[serde(rename = "_id")]
    id: String,
    name: String,
    #[serde(rename = "totalPool")]
    total_pool: i64,
    #[serde(rename = "winnerCount")]
    winner_count: i64,
    #[serde(rename = "minAmount")]
    min_amount: i64,
    #[serde(rename = "maxAmount")]
    max_amount: i64,
    status: String,
    note: String,
    seed: String,
    #[serde(rename = "participantFilter")]
    participant_filter: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "createdBy")]
    created_by: Option<UserBrief>,
    winners: Vec<WinnerPreview>,
    #[serde(rename = "allocatedTotal")]
    allocated_total: i64,
}

#[derive(Serialize)]
struct GiveawayListResponse {
    items: Vec<GiveawayListItem>,
    meta: Meta,
    #[serde(rename = "executionAvailable")]
    execution_available: bool,
}

#[derive(Serialize)]
struct Meta {
    page: i64,
    limit: i64,
    total: i64,
    #[serde(rename = "totalPages")]
    total_pages: i64,
}

#[derive(Serialize)]
struct ExecuteResponse {
    message: &'static str,
    campaign: GiveawayDetail,
}

struct NormalizedGiveaway {
    name: String,
    total_pool: i64,
    winner_count: i64,
    min_amount: i64,
    max_amount: i64,
    note: String,
    participant_filter: String,
    emails: Vec<String>,
    seed: Option<u64>,
}

struct MemberPick {
    id: ObjectId,
    name: String,
    email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdempotencyDecision {
    Start,
    Retryable,
    Replay,
    Conflict,
    InProgress,
}

fn decide_idempotency(stored_digest: Option<&str>, requested_digest: &str) -> IdempotencyDecision {
    match stored_digest {
        None => IdempotencyDecision::Start,
        Some(digest) if digest == requested_digest => IdempotencyDecision::Replay,
        Some(_) => IdempotencyDecision::Conflict,
    }
}

fn giveaway_execution_available(mongo_transactions_enabled: bool) -> bool {
    mongo_transactions_enabled
}

pub fn giveaway_idempotency_index_model() -> IndexModel {
    IndexModel::builder()
        .keys(doc! {
            "idempotencyOperatorId": 1,
            "idempotencyKey": 1,
        })
        .options(
            IndexOptions::builder()
                .name("uniq_balance_giveaway_operator_key".to_string())
                .unique(true)
                .partial_filter_expression(doc! {
                    "idempotencyOperatorId": { "$exists": true },
                    "idempotencyKey": { "$exists": true },
                })
                .build(),
        )
        .build()
}

pub async fn ensure_giveaway_indexes(db: &mongodb::Database) -> mongodb::error::Result<()> {
    db.collection::<Document>("balancegiveaways")
        .create_index(giveaway_idempotency_index_model())
        .await
        .map(|_| ())
}

fn draw_from_claim_document(document: &Document) -> Result<GiveawayDraw, Response> {
    let winners = document
        .get_array("winners")
        .ok()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_document())
                .map(|winner| WinnerPreview {
                    user_id: winner
                        .get_object_id("userId")
                        .map(|id| id.to_hex())
                        .unwrap_or_else(|_| read_string(winner, "userId")),
                    name: read_string(winner, "name"),
                    email: read_string(winner, "email"),
                    amount: read_i64(winner, "amount"),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let seed = document
        .get_str("seed")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(internal_error)?;
    let request_digest = document
        .get_str("requestDigest")
        .map(str::to_string)
        .map_err(|_| internal_error())?;
    if winners.is_empty() || request_digest.is_empty() {
        return Err(internal_error());
    }
    let allocated_total = read_i64(document, "allocatedTotal");
    Ok(GiveawayDraw {
        request_digest,
        seed,
        winners,
        allocated_total,
    })
}

fn winner_documents(winners: &[WinnerPreview]) -> Vec<Document> {
    winners
        .iter()
        .filter_map(|winner| {
            let user_id = ObjectId::parse_str(&winner.user_id).ok()?;
            Some(doc! {
                "userId": user_id,
                "name": &winner.name,
                "email": &winner.email,
                "amount": winner.amount,
            })
        })
        .collect()
}

fn giveaway_claim_document(
    payload: &NormalizedGiveaway,
    operator_id: ObjectId,
    idempotency_key: &str,
    request_digest: &str,
    seed: u64,
    winners: &[WinnerPreview],
    allocated_total: i64,
    now: DateTime,
) -> Document {
    let payload_digest = giveaway_payload_digest(payload, operator_id);
    let winner_docs = winner_documents(winners);
    doc! {
        "name": &payload.name,
        "totalPool": payload.total_pool,
        "winnerCount": payload.winner_count,
        "minAmount": payload.min_amount,
        "maxAmount": payload.max_amount,
        "note": &payload.note,
        "participantFilter": &payload.participant_filter,
        "seed": seed.to_string(),
        "status": GIVEAWAY_STATUS_IN_PROGRESS,
        "winners": winner_docs,
        "allocatedTotal": allocated_total,
        "idempotencyOperatorId": operator_id,
        "idempotencyKey": idempotency_key,
        "payloadDigest": payload_digest,
        "requestDigest": request_digest,
        "createdBy": { "_id": operator_id },
        "createdAt": now,
        "updatedAt": now,
    }
}

#[derive(Debug)]
struct GiveawayDraw {
    request_digest: String,
    seed: u64,
    winners: Vec<WinnerPreview>,
    allocated_total: i64,
}

#[derive(Debug)]
enum GiveawayClaim {
    NeedDraw,
    Acquired {
        id: ObjectId,
        token: String,
        existing: Option<Document>,
    },
    Replay(Document),
    Conflict,
    InProgress,
}

async fn resolve_existing_claim(
    campaigns: &mongodb::Collection<Document>,
    existing: Document,
    payload_digest: &str,
    operator_id: ObjectId,
    idempotency_key: &str,
) -> Result<GiveawayClaim, Response> {
    let stored_payload_digest = existing.get_str("payloadDigest").unwrap_or_default();
    if stored_payload_digest != payload_digest {
        return Ok(GiveawayClaim::Conflict);
    }

    match existing
        .get_str(GIVEAWAY_STATUS_FIELD)
        .unwrap_or(GIVEAWAY_STATUS_IN_PROGRESS)
    {
        GIVEAWAY_STATUS_COMPLETED => Ok(GiveawayClaim::Replay(existing)),
        GIVEAWAY_STATUS_RETRYABLE => {
            let Some(id) = existing.get_object_id("_id").ok() else {
                return Err(internal_error());
            };
            let token = ObjectId::new().to_hex();
            let updated = campaigns
                .update_one(
                    doc! {
                        "_id": id,
                        "idempotencyOperatorId": operator_id,
                        "idempotencyKey": idempotency_key,
                        "payloadDigest": payload_digest,
                        GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_RETRYABLE,
                    },
                    doc! {
                        "$set": {
                            GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_IN_PROGRESS,
                            "claimToken": &token,
                            "updatedAt": DateTime::now(),
                        },
                    },
                )
                .await
                .map_err(|error| {
                    eprintln!("Failed to reacquire retryable giveaway claim: {error}");
                    internal_error()
                })?;
            if updated.matched_count == 1 {
                Ok(GiveawayClaim::Acquired {
                    id,
                    token,
                    existing: Some(existing),
                })
            } else {
                Ok(GiveawayClaim::InProgress)
            }
        }
        _ => Ok(GiveawayClaim::InProgress),
    }
}

async fn claim_giveaway(
    campaigns: &mongodb::Collection<Document>,
    payload: &NormalizedGiveaway,
    operator_id: ObjectId,
    idempotency_key: &str,
    draw: Option<&GiveawayDraw>,
) -> Result<GiveawayClaim, Response> {
    let payload_digest = giveaway_payload_digest(payload, operator_id);
    let key_filter = doc! {
        "idempotencyOperatorId": operator_id,
        "idempotencyKey": idempotency_key,
    };

    // Resolve an existing durable claim before loading the participant pool. A completed replay
    // must not depend on the current member role/filter state or perform a new random draw.
    match campaigns.find_one(key_filter.clone()).await {
        Ok(Some(existing)) => {
            return resolve_existing_claim(
                campaigns,
                existing,
                &payload_digest,
                operator_id,
                idempotency_key,
            )
            .await;
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("Failed to read giveaway idempotency claim: {error}");
            return Err(internal_error());
        }
    }

    let Some(draw) = draw else {
        return Ok(GiveawayClaim::NeedDraw);
    };
    let now = DateTime::now();
    let token = ObjectId::new().to_hex();
    let mut claim = giveaway_claim_document(
        payload,
        operator_id,
        idempotency_key,
        &draw.request_digest,
        draw.seed,
        &draw.winners,
        draw.allocated_total,
        now,
    );
    claim.insert("claimToken", &token);

    match campaigns.insert_one(claim).await {
        Ok(result) => {
            let Some(id) = result.inserted_id.as_object_id() else {
                return Err(internal_error());
            };
            Ok(GiveawayClaim::Acquired {
                id,
                token,
                existing: None,
            })
        }
        Err(error) if is_duplicate_key_error(&error) => {
            let existing = campaigns
                .find_one(key_filter)
                .await
                .map_err(|read_error| {
                    eprintln!("Failed to read raced giveaway idempotency claim: {read_error}");
                    internal_error()
                })?;
            let Some(existing) = existing else {
                return Err(internal_error());
            };
            resolve_existing_claim(
                campaigns,
                existing,
                &payload_digest,
                operator_id,
                idempotency_key,
            )
            .await
        }
        Err(error) => {
            eprintln!("Failed to claim giveaway idempotency key: {error}");
            Err(internal_error())
        }
    }
}

async fn mark_claim_retryable(
    campaigns: &mongodb::Collection<Document>,
    claim_id: ObjectId,
    claim_token: &str,
) -> bool {
    campaigns
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_IN_PROGRESS,
            },
            doc! {
                "$set": {
                    GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_RETRYABLE,
                    "updatedAt": DateTime::now(),
                },
            },
        )
        .await
        .map(|result| result.matched_count == 1)
        .unwrap_or(false)
}

fn giveaway_payload_digest(payload: &NormalizedGiveaway, operator_id: ObjectId) -> String {
    giveaway_request_digest(payload, operator_id, &[])
}

fn giveaway_request_digest(
    payload: &NormalizedGiveaway,
    operator_id: ObjectId,
    winners: &[WinnerPreview],
) -> String {
    let mut canonical = String::new();
    push_digest_part(&mut canonical, &operator_id.to_hex());
    push_digest_part(&mut canonical, &payload.name);
    push_digest_part(&mut canonical, &payload.total_pool.to_string());
    push_digest_part(&mut canonical, &payload.winner_count.to_string());
    push_digest_part(&mut canonical, &payload.min_amount.to_string());
    push_digest_part(&mut canonical, &payload.max_amount.to_string());
    push_digest_part(&mut canonical, &payload.note);
    push_digest_part(&mut canonical, &payload.participant_filter);
    let mut emails = payload.emails.clone();
    emails.sort();
    for email in emails {
        push_digest_part(&mut canonical, &email);
    }
    push_digest_part(
        &mut canonical,
        &payload.seed.map(|seed| seed.to_string()).unwrap_or_default(),
    );
    for winner in winners {
        push_digest_part(&mut canonical, &winner.user_id);
        push_digest_part(&mut canonical, &winner.amount.to_string());
    }
    crate::services::idempotency::sha256_hex(canonical.as_bytes())
}

fn push_digest_part(canonical: &mut String, value: &str) {
    canonical.push_str(&value.len().to_string());
    canonical.push(':');
    canonical.push_str(value);
    canonical.push('|');
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    matches!(
        error.kind.as_ref(),
        ErrorKind::Write(_) | ErrorKind::InsertMany(_)
    ) && error.to_string().contains("E11000")
}

fn giveaway_conflict_response() -> Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Idempotency-Key sudah digunakan untuk payload giveaway berbeda",
            "error": {
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "Idempotency-Key sudah digunakan untuk payload giveaway berbeda",
            },
        })),
    )
        .into_response()
}

fn giveaway_in_progress_response() -> Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Giveaway dengan Idempotency-Key yang sama sedang diproses atau perlu rekonsiliasi",
            "error": {
                "code": "IDEMPOTENCY_IN_PROGRESS",
                "message": "Giveaway dengan Idempotency-Key yang sama sedang diproses atau perlu rekonsiliasi",
            },
        })),
    )
        .into_response()
}

fn giveaway_transactions_unavailable_response() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Eksekusi giveaway sementara tidak tersedia karena MongoDB transaction belum aktif",
            "error": {
                "code": "GIVEAWAY_TRANSACTIONS_UNAVAILABLE",
                "message": "Eksekusi giveaway sementara tidak tersedia karena MongoDB transaction belum aktif",
            },
        })),
    )
        .into_response()
}

fn giveaway_commit_unknown_response() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "message": "Status commit giveaway belum dapat dipastikan; jangan gunakan key baru",
            "error": {
                "code": "GIVEAWAY_COMMIT_UNKNOWN",
                "message": "Status commit giveaway belum dapat dipastikan; ulangi dengan Idempotency-Key yang sama setelah rekonsiliasi",
            },
        })),
    )
        .into_response()
}


fn text_value(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn number_value(value: Option<Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|v| v.is_finite())
                .map(|v| v.round() as i64)
        }),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|v| v.round() as i64),
        _ => None,
    }
}

fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .ok()
        .and_then(|dt| dt.try_to_rfc3339_string().ok())
        .unwrap_or_default()
}

fn normalize_payload(payload: GiveawayPayload) -> Result<NormalizedGiveaway, Response> {
    let name = text_value(payload.name)
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() || name.len() > 120 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama campaign wajib 1-120 karakter",
        ));
    }
    let total_pool = number_value(payload.total_pool).unwrap_or(0);
    let winner_count = number_value(payload.winner_count).unwrap_or(0);
    let min_amount = number_value(payload.min_amount).unwrap_or(0);
    let max_amount = number_value(payload.max_amount).unwrap_or(0);
    let note = text_value(payload.note).unwrap_or_default().trim().to_string();
    if note.len() > 300 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan maksimal 300 karakter",
        ));
    }
    if total_pool < 1 || total_pool > MAX_POOL {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Total pool tidak valid",
        ));
    }
    if winner_count < MIN_WINNERS || winner_count > MAX_WINNERS {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Jumlah pemenang harus 1-100",
        ));
    }
    if min_amount < 1 || max_amount < min_amount {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Rentang nominal per pemenang tidak valid",
        ));
    }
    if min_amount * winner_count > total_pool {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Total pool terlalu kecil untuk min × jumlah pemenang",
        ));
    }
    if max_amount * winner_count < total_pool {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Total pool terlalu besar untuk max × jumlah pemenang",
        ));
    }
    let participant_filter = text_value(payload.participant_filter)
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        participant_filter.as_str(),
        "all" | "has_transactions" | "emails"
    ) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Filter peserta tidak valid",
        ));
    }
    let emails = text_value(payload.emails)
        .unwrap_or_default()
        .split(|c: char| c == ',' || c == ';' || c == '\n' || c == '\r')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if participant_filter == "emails" && emails.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Daftar email peserta wajib diisi",
        ));
    }
    let seed_raw = payload.seed;
    let seed = text_value(seed_raw.clone())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or_else(|| number_value(seed_raw).map(|value| value as u64));
    Ok(NormalizedGiveaway {
        name,
        total_pool,
        winner_count,
        min_amount,
        max_amount,
        note,
        participant_filter,
        emails,
        seed,
    })
}

/// Allocate `total` across `n` buckets with each in [min, max], summing exactly to total.
pub(super) fn allocate_random_amounts(
    total: i64,
    n: usize,
    min_amount: i64,
    max_amount: i64,
) -> Option<Vec<i64>> {
    let mut rng = StdRng::from_entropy();
    allocate_random_amounts_with_rng(total, n, min_amount, max_amount, &mut rng)
}

fn allocate_random_amounts_with_rng<R: Rng + ?Sized>(
    total: i64,
    n: usize,
    min_amount: i64,
    max_amount: i64,
    mut rng: &mut R,
) -> Option<Vec<i64>> {
    if n == 0 || min_amount < 1 || max_amount < min_amount {
        return None;
    }
    let n_i64 = n as i64;
    if min_amount * n_i64 > total || max_amount * n_i64 < total {
        return None;
    }
    // Random weights then scale into the free room above `min_amount`.
    let _headroom = max_amount - min_amount;
    let weights: Vec<f64> = (0..n).map(|_| rng.gen::<f64>() + 0.001).collect();
    let weight_sum: f64 = weights.iter().sum();
    let free = (total - min_amount * n_i64) as f64;
    let mut amounts: Vec<i64> = weights
        .iter()
        .map(|w| min_amount + ((w / weight_sum) * free).floor() as i64)
        .map(|amount| amount.min(max_amount))
        .collect();
    // Fix rounding so the sum is exact without exceeding max.
    let mut allocated: i64 = amounts.iter().sum();
    let mut guard = 0;
    while allocated < total && guard < n * 4 {
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(&mut rng);
        for index in order {
            if allocated >= total {
                break;
            }
            if amounts[index] < max_amount {
                amounts[index] += 1;
                allocated += 1;
            }
        }
        guard += 1;
    }
    while allocated > total {
        // Should be rare; peel from largest slots.
        if let Some((index, _)) = amounts
            .iter()
            .enumerate()
            .filter(|(_, amount)| **amount > min_amount)
            .max_by_key(|(_, amount)| *amount)
        {
            amounts[index] -= 1;
            allocated -= 1;
        } else {
            break;
        }
    }
    if amounts.iter().sum::<i64>() != total
        || amounts.iter().any(|amount| *amount < min_amount || *amount > max_amount)
    {
        // Fallback: even split then push remainder (always valid when bounds allow).
        let base = total / n_i64;
        let mut rem = total % n_i64;
        if base < min_amount || base > max_amount {
            return None;
        }
        amounts = vec![base; n];
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(&mut rng);
        for index in order {
            if rem <= 0 {
                break;
            }
            if amounts[index] < max_amount {
                amounts[index] += 1;
                rem -= 1;
            }
        }
        if amounts.iter().sum::<i64>() != total {
            return None;
        }
    }
    let _ = _headroom; // documented constraint used via min/max clamps above
    Some(amounts)
}

async fn load_member_pool(
    db: &mongodb::Database,
    filter: &str,
    emails: &[String],
) -> Result<Vec<MemberPick>, Response> {
    let mut query = doc! { "role": "member" };
    if filter == "emails" {
        query.insert("email", doc! { "$in": emails });
    } else if filter == "has_transactions" {
        let tx_user_ids = db
            .collection::<Document>("transactions")
            .distinct("user", doc! {})
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| match value {
                Bson::ObjectId(id) => Some(id),
                Bson::String(text) => ObjectId::parse_str(text).ok(),
                _ => None,
            })
            .collect::<Vec<_>>();
        query.insert("_id", doc! { "$in": tx_user_ids });
    }
    let users = db.collection::<Document>("users");
    let cursor = users
        .find(query)
        .projection(doc! { "name": 1, "email": 1 })
        .await
        .map_err(|error| {
            eprintln!("Failed to query members for giveaway: {error}");
            internal_error()
        })?;
    let docs = cursor.try_collect::<Vec<_>>().await.map_err(|error| {
        eprintln!("Failed to collect members for giveaway: {error}");
        internal_error()
    })?;
    Ok(docs
        .into_iter()
        .filter_map(|document| {
            let id = document.get_object_id("_id").ok()?;
            Some(MemberPick {
                id,
                name: read_string(&document, "name"),
                email: read_string(&document, "email"),
            })
        })
        .collect())
}

fn pick_winners(
    members: &[MemberPick],
    winner_count: i64,
    total_pool: i64,
    min_amount: i64,
    max_amount: i64,
    seed: Option<u64>,
) -> Result<(Vec<WinnerPreview>, u64), Response> {
    if members.len() < winner_count as usize {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Member eligible lebih sedikit dari jumlah pemenang",
        ));
    }
    let seed = seed.unwrap_or_else(|| rand::thread_rng().gen());
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let mut pool: Vec<&MemberPick> = members.iter().collect();
    pool.shuffle(&mut rng);
    let selected: Vec<&MemberPick> = pool.into_iter().take(winner_count as usize).collect();
    let amounts = allocate_random_amounts_with_rng(
        total_pool,
        selected.len(),
        min_amount,
        max_amount,
        &mut rng,
    )
    .ok_or_else(|| {
        status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Gagal mengalokasikan nominal acak sesuai batas",
        )
    })?;
    let winners = selected
        .into_iter()
        .zip(amounts)
        .map(|(member, amount)| WinnerPreview {
            user_id: member.id.to_hex(),
            name: member.name.clone(),
            email: member.email.clone(),
            amount,
        })
        .collect();
    Ok((winners, seed))
}

fn operator_brief(proxy_user: &crate::security::AuthenticatedProxyUser) -> UserBrief {
    UserBrief {
        id: proxy_user.id.to_hex(),
        name: proxy_user.email.clone(),
        email: proxy_user.email.clone(),
    }
}

fn campaign_from_doc(document: Document) -> GiveawayDetail {
    let winners = document
        .get_array("winners")
        .ok()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_document())
                .map(|winner| WinnerPreview {
                    user_id: winner
                        .get_object_id("userId")
                        .map(|id| id.to_hex())
                        .unwrap_or_else(|_| read_string(winner, "userId")),
                    name: read_string(winner, "name"),
                    email: read_string(winner, "email"),
                    amount: read_i64(winner, "amount"),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let allocated_total = winners.iter().map(|winner| winner.amount).sum();
    let created_by = document.get_document("createdBy").ok().map(|brief| UserBrief {
        id: brief
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_else(|_| read_string(brief, "_id")),
        name: read_string(brief, "name"),
        email: read_string(brief, "email"),
    });
    GiveawayDetail {
        id: id_from_doc(&document),
        name: read_string(&document, "name"),
        total_pool: read_i64(&document, "totalPool"),
        winner_count: read_i64(&document, "winnerCount"),
        min_amount: read_i64(&document, "minAmount"),
        max_amount: read_i64(&document, "maxAmount"),
        status: read_string(&document, "status"),
        note: read_string(&document, "note"),
        seed: read_string(&document, "seed"),
        participant_filter: read_string(&document, "participantFilter"),
        created_at: date_string(&document, "createdAt"),
        created_by,
        winners,
        allocated_total,
    }
}

pub async fn giveaway_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<GiveawayListQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageVouchers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let page = query.page.unwrap_or(1).clamp(1, 100_000);
    let limit = query.limit.unwrap_or(LIST_LIMIT_DEFAULT).clamp(1, 100);
    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("balancegiveaways");
    let total = collection
        .count_documents(doc! {})
        .await
        .unwrap_or_default() as i64;
    let docs = match collection
        .find(doc! {})
        .sort(doc! { "createdAt": -1 })
        .skip(((page - 1) * limit) as u64)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let items = docs
        .into_iter()
        .map(|document| {
            let detail = campaign_from_doc(document);
            GiveawayListItem {
                id: detail.id,
                name: detail.name,
                total_pool: detail.total_pool,
                winner_count: detail.winner_count,
                status: detail.status,
                note: detail.note,
                created_at: detail.created_at,
                created_by: detail.created_by,
                allocated_total: detail.allocated_total,
            }
        })
        .collect();
    Json(GiveawayListResponse {
        items,
        meta: Meta {
            page,
            limit,
            total,
            total_pages: std::cmp::max(1, (total + limit - 1) / limit),
        },
        execution_available: giveaway_execution_available(state.mongo_transactions_enabled),
    })
    .into_response()
}

pub async fn giveaway_detail(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageVouchers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID campaign tidak valid");
    };
    let db = client.database(&state.mongo_db);
    let document = match db
        .collection::<Document>("balancegiveaways")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => {
            return status_message(axum::http::StatusCode::NOT_FOUND, "Campaign tidak ditemukan")
        }
        Err(_) => return internal_error(),
    };
    Json(campaign_from_doc(document)).into_response()
}

pub async fn giveaway_preview(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<GiveawayPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageVouchers").await {
        return response;
    }
    let normalized = match normalize_payload(payload) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let members = match load_member_pool(
        &db,
        &normalized.participant_filter,
        &normalized.emails,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (winners, seed) = match pick_winners(
        &members,
        normalized.winner_count,
        normalized.total_pool,
        normalized.min_amount,
        normalized.max_amount,
        normalized.seed,
    ) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let allocated_total: i64 = winners.iter().map(|winner| winner.amount).sum();
    Json(GiveawayPreviewResponse {
        name: normalized.name,
        total_pool: normalized.total_pool,
        winner_count: normalized.winner_count,
        min_amount: normalized.min_amount,
        max_amount: normalized.max_amount,
        note: normalized.note,
        participant_filter: normalized.participant_filter,
        eligible_members: members.len() as i64,
        winners,
        allocated_total,
        seed: seed.to_string(),
        execution_available: giveaway_execution_available(state.mongo_transactions_enabled),
    })
    .into_response()
}

enum GiveawayTransactionError {
    PreEffect(Response),
    Ambiguous(Response),
}

async fn apply_giveaway_transaction(
    session: &mut ClientSession,
    db: &mongodb::Database,
    claim_id: ObjectId,
    claim_token: &str,
    payload_digest: &str,
    request_digest: &str,
    idempotency_key: &str,
    operator: &UserBrief,
    payload: &NormalizedGiveaway,
    winners: &[WinnerPreview],
    allocated_total: i64,
    seed: u64,
) -> Result<GiveawayDetail, Response> {
    let operator_id = ObjectId::parse_str(&operator.id).map_err(|_| internal_error())?;
    let campaigns = db.collection::<Document>("balancegiveaways");
    let users = db.collection::<Document>("users");
    let adjustments = db.collection::<Document>("userbalanceadjustments");
    let now = DateTime::now();

    let winner_docs = winners
        .iter()
        .filter_map(|winner| {
            let user_id = ObjectId::parse_str(&winner.user_id).ok()?;
            Some(doc! {
                "userId": user_id,
                "name": &winner.name,
                "email": &winner.email,
                "amount": winner.amount,
            })
        })
        .collect::<Vec<_>>();
    let claimed = campaigns
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyOperatorId": operator_id,
                "idempotencyKey": idempotency_key,
                "payloadDigest": payload_digest,
                GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_IN_PROGRESS,
            },
            doc! {
                "$set": {
                    "requestDigest": request_digest,
                    "seed": seed.to_string(),
                    "winners": winner_docs,
                    "allocatedTotal": allocated_total,
                    "updatedAt": now,
                },
            },
        )
        .session(&mut *session)
        .await
        .map_err(|error| {
            eprintln!("Failed to fence giveaway claim in transaction: {error}");
            internal_error()
        })?;
    if claimed.matched_count != 1 {
        return Err(giveaway_in_progress_response());
    }

    let reason_base = if payload.note.is_empty() {
        format!("Bagikan saldo random: {}", payload.name)
    } else {
        format!("Bagikan saldo random: {} — {}", payload.name, payload.note)
    };

    for winner in winners {
        let user_id = ObjectId::parse_str(&winner.user_id).map_err(|_| internal_error())?;
        let amount = winner.amount;
        let updated = users
            .find_one_and_update(
                doc! { "_id": user_id, "role": "member" },
                doc! {
                    "$inc": { "balance": amount },
                    "$set": { "updatedAt": now },
                },
            )
            .return_document(mongodb::options::ReturnDocument::After)
            .session(&mut *session)
            .await
            .map_err(|error| {
                eprintln!("Failed to credit giveaway winner in transaction: {error}");
                internal_error()
            })?;
        let Some(user) = updated else {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Gagal mengkredit salah satu pemenang; transaksi dibatalkan",
            ));
        };
        let balance_after = number_from_bson(user.get("balance")).unwrap_or(0);
        let balance_before = balance_after - amount;
        let audit = doc! {
            "user": user_id,
            "adjustedBy": operator_id,
            "type": "add",
            "amount": amount,
            "balanceBefore": balance_before,
            "balanceAfter": balance_after,
            "reason": format!("{} (pemenang giveaway)", reason_base),
            "source": "balance_giveaway",
            "routeKey": "vouchers.giveaway.execute",
            "idempotencyKey": idempotency_key,
            "requestDigest": request_digest,
            "createdAt": now,
            "updatedAt": now,
        };
        adjustments
            .insert_one(audit)
            .session(&mut *session)
            .await
            .map_err(|error| {
                eprintln!("Failed to insert giveaway audit in transaction: {error}");
                internal_error()
            })?;
    }

    let finalized = campaigns
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyOperatorId": operator_id,
                "idempotencyKey": idempotency_key,
                "payloadDigest": payload_digest,
                "requestDigest": request_digest,
                GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_IN_PROGRESS,
            },
            doc! {
                "$set": {
                    GIVEAWAY_STATUS_FIELD: GIVEAWAY_STATUS_COMPLETED,
                    "createdBy": {
                        "_id": operator_id,
                        "name": &operator.name,
                        "email": &operator.email,
                    },
                    "updatedAt": now,
                },
            },
        )
        .session(&mut *session)
        .await
        .map_err(|error| {
            eprintln!("Failed to finalize giveaway campaign in transaction: {error}");
            internal_error()
        })?;
    if finalized.matched_count != 1 {
        return Err(giveaway_in_progress_response());
    }

    Ok(GiveawayDetail {
        id: claim_id.to_hex(),
        name: payload.name.clone(),
        total_pool: payload.total_pool,
        winner_count: payload.winner_count,
        min_amount: payload.min_amount,
        max_amount: payload.max_amount,
        status: GIVEAWAY_STATUS_COMPLETED.to_string(),
        note: payload.note.clone(),
        seed: seed.to_string(),
        participant_filter: payload.participant_filter.clone(),
        created_at: now.try_to_rfc3339_string().unwrap_or_default(),
        created_by: Some(operator.clone()),
        winners: winners.to_vec(),
        allocated_total,
    })
}

async fn execute_giveaway_transaction(
    client: &mongodb::Client,
    db: &mongodb::Database,
    claim_id: ObjectId,
    claim_token: &str,
    payload_digest: &str,
    request_digest: &str,
    idempotency_key: &str,
    operator: &UserBrief,
    payload: &NormalizedGiveaway,
    winners: &[WinnerPreview],
    allocated_total: i64,
    seed: u64,
) -> Result<GiveawayDetail, GiveawayTransactionError> {
    let mut session = client.start_session().await.map_err(|error| {
        eprintln!("Failed to start giveaway Mongo session: {error}");
        GiveawayTransactionError::PreEffect(giveaway_transactions_unavailable_response())
    })?;
    session.start_transaction().await.map_err(|error| {
        eprintln!("Failed to start giveaway Mongo transaction: {error}");
        GiveawayTransactionError::PreEffect(giveaway_transactions_unavailable_response())
    })?;

    let result = apply_giveaway_transaction(
        &mut session,
        db,
        claim_id,
        claim_token,
        payload_digest,
        request_digest,
        idempotency_key,
        operator,
        payload,
        winners,
        allocated_total,
        seed,
    )
    .await;
    let detail = match result {
        Ok(detail) => detail,
        Err(response) => {
            if session.abort_transaction().await.is_ok() {
                return Err(GiveawayTransactionError::PreEffect(response));
            }
            eprintln!("Giveaway transaction abort failed; retaining claim in progress");
            return Err(GiveawayTransactionError::Ambiguous(
                giveaway_commit_unknown_response(),
            ));
        }
    };

    match crate::services::idempotency::commit_mongo_transaction_with_unknown_retry(&mut session)
        .await
    {
        crate::services::idempotency::TransactionCommitOutcome::Committed => Ok(detail),
        crate::services::idempotency::TransactionCommitOutcome::Ambiguous
        | crate::services::idempotency::TransactionCommitOutcome::FailedDefinitely => {
            eprintln!("Giveaway transaction commit was not positively acknowledged; retaining claim");
            Err(GiveawayTransactionError::Ambiguous(
                giveaway_commit_unknown_response(),
            ))
        }
    }
}

pub async fn giveaway_execute(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<GiveawayPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "manageVouchers").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.adjust_balance") {
        return response;
    }
    let normalized = match normalize_payload(payload) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !state.mongo_transactions_enabled {
        return giveaway_transactions_unavailable_response();
    }
    let idempotency_key = match crate::services::idempotency::require_idempotency_key(&headers) {
        Ok(Some(value)) => value,
        Ok(None) => return crate::services::idempotency::IdempotencyError::MissingKey.into_response(),
        Err(error) => return error.into_response(),
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let campaigns = db.collection::<Document>("balancegiveaways");
    let payload_digest = giveaway_payload_digest(&normalized, proxy_user.id);

    // Resolve the durable claim before reading the current member pool. Completed replays must
    // return the stored campaign even if a member was later deactivated or removed from the
    // original participant filter; a replay must never perform a fresh draw.
    let initial_claim = match claim_giveaway(
        &campaigns,
        &normalized,
        proxy_user.id,
        &idempotency_key,
        None,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };

    let (claim_id, claim_token, draw) = match initial_claim {
        GiveawayClaim::Replay(existing) => {
            return Json(ExecuteResponse {
                message: "Bagikan saldo random (replay idempotent)",
                campaign: campaign_from_doc(existing),
            })
            .into_response();
        }
        GiveawayClaim::Conflict => return giveaway_conflict_response(),
        GiveawayClaim::InProgress => return giveaway_in_progress_response(),
        GiveawayClaim::Acquired {
            id,
            token,
            existing: Some(existing),
        } => {
            let draw = match draw_from_claim_document(&existing) {
                Ok(value) => value,
                Err(response) => return response,
            };
            (id, token, draw)
        }
        GiveawayClaim::Acquired {
            existing: None, ..
        } => return internal_error(),
        GiveawayClaim::NeedDraw => {
            let members = match load_member_pool(
                &db,
                &normalized.participant_filter,
                &normalized.emails,
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let (winners, seed) = match pick_winners(
                &members,
                normalized.winner_count,
                normalized.total_pool,
                normalized.min_amount,
                normalized.max_amount,
                normalized.seed,
            ) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let draw = GiveawayDraw {
                request_digest: giveaway_request_digest(&normalized, proxy_user.id, &winners),
                seed,
                allocated_total: winners.iter().map(|winner| winner.amount).sum(),
                winners,
            };
            let claim = match claim_giveaway(
                &campaigns,
                &normalized,
                proxy_user.id,
                &idempotency_key,
                Some(&draw),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            match claim {
                GiveawayClaim::Replay(existing) => {
                    return Json(ExecuteResponse {
                        message: "Bagikan saldo random (replay idempotent)",
                        campaign: campaign_from_doc(existing),
                    })
                    .into_response();
                }
                GiveawayClaim::Conflict => return giveaway_conflict_response(),
                GiveawayClaim::InProgress => return giveaway_in_progress_response(),
                GiveawayClaim::Acquired {
                    id,
                    token,
                    existing: None,
                } => (id, token, draw),
                GiveawayClaim::Acquired {
                    id,
                    token,
                    existing: Some(existing),
                } => {
                    let stored_draw = match draw_from_claim_document(&existing) {
                        Ok(value) => value,
                        Err(response) => return response,
                    };
                    (id, token, stored_draw)
                }
                GiveawayClaim::NeedDraw => return internal_error(),
            }
        }
    };

    let GiveawayDraw {
        request_digest,
        seed,
        winners,
        allocated_total,
    } = draw;

    let operator = operator_brief(&proxy_user);
    match execute_giveaway_transaction(
        client,
        &db,
        claim_id,
        &claim_token,
        &payload_digest,
        &request_digest,
        &idempotency_key,
        &operator,
        &normalized,
        &winners,
        allocated_total,
        seed,
    )
    .await
    {
        Ok(campaign) => Json(ExecuteResponse {
            message: "Bagikan saldo random berhasil dijalankan",
            campaign,
        })
        .into_response(),
        Err(GiveawayTransactionError::PreEffect(response)) => {
            if !mark_claim_retryable(&campaigns, claim_id, &claim_token).await {
                return giveaway_commit_unknown_response();
            }
            response
        }
        Err(GiveawayTransactionError::Ambiguous(response)) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        allocate_random_amounts, decide_idempotency, giveaway_claim_document,
        giveaway_execution_available,
        giveaway_idempotency_index_model, giveaway_request_digest,
        giveaway_transactions_unavailable_response,
        GiveawayListResponse, GiveawayPreviewResponse, IdempotencyDecision,
        Meta, NormalizedGiveaway, WinnerPreview, GIVEAWAY_STATUS_IN_PROGRESS,
    };
    use mongodb::bson::{oid::ObjectId, Bson, DateTime};

    fn fixture_payload(name: &str, total_pool: i64) -> NormalizedGiveaway {
        NormalizedGiveaway {
            name: name.to_string(),
            total_pool,
            winner_count: 2,
            min_amount: 1_000,
            max_amount: 10_000,
            note: "catatan".to_string(),
            participant_filter: "emails".to_string(),
            emails: vec!["z@example.com".to_string(), "a@example.com".to_string()],
            seed: Some(42),
        }
    }

    #[test]
    fn giveaway_request_digest_is_stable_and_payload_bound() {
        let first = giveaway_request_digest(
            &fixture_payload("Promo", 10_000),
            ObjectId::from_bytes([1; 12]),
            &[],
        );
        let same = giveaway_request_digest(
            &fixture_payload("Promo", 10_000),
            ObjectId::from_bytes([1; 12]),
            &[],
        );
        let changed_amount = giveaway_request_digest(
            &fixture_payload("Promo", 20_000),
            ObjectId::from_bytes([1; 12]),
            &[],
        );
        let different_operator = giveaway_request_digest(
            &fixture_payload("Promo", 10_000),
            ObjectId::from_bytes([2; 12]),
            &[],
        );

        assert_eq!(first, same);
        assert_ne!(first, changed_amount);
        assert_ne!(first, different_operator);
    }

    #[test]
    fn giveaway_idempotency_decision_replays_only_same_digest() {
        assert_eq!(decide_idempotency(Some("abc"), "abc"), IdempotencyDecision::Replay);
        assert_eq!(decide_idempotency(Some("abc"), "xyz"), IdempotencyDecision::Conflict);
        assert_eq!(decide_idempotency(None, "abc"), IdempotencyDecision::Start);
    }

    #[test]
    fn giveaway_capability_is_false_when_transactions_are_disabled() {
        assert!(!giveaway_execution_available(false));
        assert!(giveaway_execution_available(true));
    }

    #[test]
    fn giveaway_list_response_includes_execution_available_boolean() {
        let response = GiveawayListResponse {
            items: Vec::new(),
            meta: Meta {
                page: 1,
                limit: 20,
                total: 0,
                total_pages: 1,
            },
            execution_available: false,
        };
        let json = serde_json::to_value(response).expect("list response json");
        assert_eq!(json["executionAvailable"], false);
    }

    #[test]
    fn giveaway_preview_response_includes_execution_available_boolean() {
        let response = GiveawayPreviewResponse {
            name: "Promo".to_string(),
            total_pool: 10_000,
            winner_count: 1,
            min_amount: 10_000,
            max_amount: 10_000,
            note: String::new(),
            participant_filter: "all".to_string(),
            eligible_members: 1,
            winners: vec![WinnerPreview {
                user_id: ObjectId::from_bytes([1; 12]).to_hex(),
                name: "Member".to_string(),
                email: "member@example.com".to_string(),
                amount: 10_000,
            }],
            allocated_total: 10_000,
            seed: "42".to_string(),
            execution_available: true,
        };
        let json = serde_json::to_value(response).expect("preview response json");
        assert_eq!(json["executionAvailable"], true);
    }

    #[test]
    fn giveaway_idempotency_index_is_unique_and_partial_without_ttl() {
        let model = giveaway_idempotency_index_model();
        let options = model.options.expect("index options");
        assert_eq!(options.unique, Some(true));
        assert_eq!(options.name.as_deref(), Some("uniq_balance_giveaway_operator_key"));
        assert!(options.expire_after.is_none());
        assert_eq!(
            model.keys,
            mongodb::bson::doc! {
                "idempotencyOperatorId": 1,
                "idempotencyKey": 1,
            }
        );
        let partial = options.partial_filter_expression.expect("partial filter");
        assert_eq!(partial["idempotencyOperatorId"]["$exists"], Bson::Boolean(true));
        assert_eq!(partial["idempotencyKey"]["$exists"], Bson::Boolean(true));
    }

    #[test]
    fn giveaway_claim_fields_bind_operator_key_and_digest() {
        let operator_id = ObjectId::from_bytes([3; 12]);
        let payload = fixture_payload("Promo", 10_000);
        let digest = giveaway_request_digest(&payload, operator_id, &[]);
        let claim = giveaway_claim_document(
            &payload,
            operator_id,
            "giveaway-claim-001",
            &digest,
            42,
            &[],
            0,
            DateTime::from_millis(1_700_000_000_000),
        );
        assert_eq!(claim.get_object_id("idempotencyOperatorId").unwrap(), operator_id);
        assert_eq!(claim.get_str("idempotencyKey").unwrap(), "giveaway-claim-001");
        assert_eq!(claim.get_str("requestDigest").unwrap(), digest);
        assert_eq!(claim.get_str("status").unwrap(), GIVEAWAY_STATUS_IN_PROGRESS);
    }

    #[test]
    fn giveaway_execution_is_transaction_only_and_integer_based() {
        let source = include_str!("giveaway.rs");
        let production = source.split("#[cfg(test)]").next().expect("production source");
        assert!(production.contains("state.mongo_transactions_enabled"));
        assert!(production.contains("start_transaction"));
        assert!(production.contains("commit_mongo_transaction_with_unknown_retry"));
        assert!(!production.contains("rollback_credits"));
        assert!(!production.contains("amount as f64"));
    }

    #[test]
    fn giveaway_transactions_unavailable_response_is_503() {
        let response = giveaway_transactions_unavailable_response();
        assert_eq!(response.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn allocation_sums_to_pool_and_respects_bounds() {
        for _ in 0..20 {
            let amounts = allocate_random_amounts(100_000, 10, 5_000, 20_000).expect("alloc");
            assert_eq!(amounts.len(), 10);
            assert_eq!(amounts.iter().sum::<i64>(), 100_000);
            assert!(amounts.iter().all(|a| *a >= 5_000 && *a <= 20_000));
        }
    }

    #[test]
    fn allocation_rejects_impossible_bounds() {
        assert!(allocate_random_amounts(1000, 10, 500, 600).is_none());
        assert!(allocate_random_amounts(100_000, 2, 1, 10).is_none());
    }
}
