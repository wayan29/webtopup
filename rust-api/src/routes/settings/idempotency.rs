//! Permanent fenced Site Config idempotency claims.
//! Claims bind operator + expectedRevision + payload digest and never TTL-expire.

use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use mongodb::options::{IndexOptions, UpdateModifications};
use mongodb::{error::ErrorKind, ClientSession, Database, IndexModel};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::Value;

pub const SITE_CONFIG_CLAIMS_COLLECTION: &str = "siteconfigidempotencyclaims";
pub const SITE_CONFIG_CLAIM_INDEX: &str = "uniq_site_config_idempotency_key";
pub const SITE_CONFIG_CLAIM_LEASE_SECONDS: i64 = 5 * 60;
pub const SITE_CONFIG_FROZEN_RESPONSE_MAX_BYTES: usize = 256 * 1024;

const STATUS_IN_PROGRESS: &str = "in_progress";
const STATUS_COMPLETED: &str = "completed";
const STATUS_RETRYABLE: &str = "retryable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteConfigClaimBinding {
    pub key: String,
    pub operator_id: ObjectId,
    pub expected_revision: i64,
    pub payload_digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SiteConfigClaimBegin {
    Started {
        claim_id: ObjectId,
        claim_token: String,
        undo: SiteConfigClaimUndo,
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

#[derive(Debug, Clone, PartialEq)]
pub enum SiteConfigClaimUndo {
    DeleteNew {
        claim_id: ObjectId,
        claim_token: String,
        binding: SiteConfigClaimBinding,
    },
    RestoreReclaimed {
        claim_id: ObjectId,
        claim_token: String,
        binding: SiteConfigClaimBinding,
        prior_document: Document,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteConfigClaimError {
    IndexesNotReady,
    Storage,
    InvalidKey,
    ResponseTooLarge,
    UndoFailed,
}

impl SiteConfigClaimError {
    pub fn code(self) -> &'static str {
        match self {
            Self::IndexesNotReady => "SITE_CONFIG_INDEXES_UNAVAILABLE",
            Self::Storage => "SITE_CONFIG_CLAIM_STORAGE_FAILED",
            Self::InvalidKey => "IDEMPOTENCY_KEY_REQUIRED",
            Self::ResponseTooLarge => "SETTINGS_RESPONSE_TOO_LARGE",
            Self::UndoFailed => "SETTINGS_COMMIT_UNKNOWN",
        }
    }
}

pub fn normalize_site_config_idempotency_key(raw: &str) -> Result<String, SiteConfigClaimError> {
    let trimmed = raw.trim();
    if trimmed.len() < 8 || trimmed.len() > 128 {
        return Err(SiteConfigClaimError::InvalidKey);
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(SiteConfigClaimError::InvalidKey);
    }
    Ok(trimmed.to_string())
}

pub fn generate_claim_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

pub fn lease_expires_at(now: DateTime) -> DateTime {
    DateTime::from_millis(now.timestamp_millis() + SITE_CONFIG_CLAIM_LEASE_SECONDS * 1000)
}

pub fn claim_binding_matches(existing: &Document, binding: &SiteConfigClaimBinding) -> bool {
    let operator_ok = existing
        .get_object_id("operatorId")
        .ok()
        .is_some_and(|id| id == binding.operator_id);
    let revision_ok = match existing.get("expectedRevision") {
        Some(Bson::Int32(value)) => i64::from(*value) == binding.expected_revision,
        Some(Bson::Int64(value)) => *value == binding.expected_revision,
        _ => false,
    };
    let digest_ok = existing
        .get_str("payloadDigest")
        .ok()
        .is_some_and(|digest| digest == binding.payload_digest);
    let key_ok = existing
        .get_str("idempotencyKey")
        .ok()
        .is_some_and(|key| key == binding.key);
    operator_ok && revision_ok && digest_ok && key_ok
}

pub fn can_reclaim_stale_pre_transaction(existing: &Document, now: DateTime) -> bool {
    let status = existing.get_str("status").unwrap_or_default();
    if status != STATUS_IN_PROGRESS && status != STATUS_RETRYABLE {
        return false;
    }
    if existing.get_bool("commitUnknown").unwrap_or(false) {
        return false;
    }
    if existing.get_datetime("transactionStartedAt").is_ok() {
        return false;
    }
    match existing.get_datetime("leaseExpiresAt") {
        Ok(lease) => lease.timestamp_millis() <= now.timestamp_millis(),
        Err(_) => status == STATUS_RETRYABLE,
    }
}

pub fn frozen_response_within_bounds(body: &Value) -> Result<Vec<u8>, SiteConfigClaimError> {
    let bytes = serde_json::to_vec(body).map_err(|_| SiteConfigClaimError::Storage)?;
    if bytes.len() > SITE_CONFIG_FROZEN_RESPONSE_MAX_BYTES {
        return Err(SiteConfigClaimError::ResponseTooLarge);
    }
    Ok(bytes)
}

pub fn completed_replay_body(stored: &Value, replayed: bool) -> Value {
    let mut body = stored.clone();
    if let Some(object) = body.as_object_mut() {
        object.insert("replayed".to_string(), Value::Bool(replayed));
    }
    body
}

pub fn site_config_claim_index_model() -> IndexModel {
    IndexModel::builder()
        .keys(doc! { "idempotencyKey": 1 })
        .options(
            IndexOptions::builder()
                .name(SITE_CONFIG_CLAIM_INDEX.to_string())
                .unique(true)
                .build(),
        )
        .build()
}

pub async fn ensure_site_config_foundation_indexes(
    db: &Database,
) -> Result<(), SiteConfigClaimError> {
    ensure_settings_key_unique(db).await?;
    db.collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
        .create_index(site_config_claim_index_model())
        .await
        .map_err(|_| SiteConfigClaimError::IndexesNotReady)?;
    Ok(())
}

async fn ensure_settings_key_unique(db: &Database) -> Result<(), SiteConfigClaimError> {
    let settings = db.collection::<Document>("settings");
    let mut cursor = settings
        .list_indexes()
        .await
        .map_err(|_| SiteConfigClaimError::IndexesNotReady)?;
    let mut found_compatible = false;
    while cursor
        .advance()
        .await
        .map_err(|_| SiteConfigClaimError::IndexesNotReady)?
    {
        let model = cursor
            .deserialize_current()
            .map_err(|_| SiteConfigClaimError::IndexesNotReady)?;
        if model.keys == doc! { "key": 1 } {
            let unique = model
                .options
                .as_ref()
                .and_then(|options| options.unique)
                .unwrap_or(false);
            let ttl = model
                .options
                .as_ref()
                .and_then(|options| options.expire_after)
                .is_some();
            if unique && !ttl {
                found_compatible = true;
                break;
            }
            // Conflicting definition on the same key pattern.
            return Err(SiteConfigClaimError::IndexesNotReady);
        }
    }
    if found_compatible {
        return Ok(());
    }
    settings
        .create_index(
            IndexModel::builder()
                .keys(doc! { "key": 1 })
                .options(
                    IndexOptions::builder()
                        .name("uniq_site_settings_key".to_string())
                        .unique(true)
                        .build(),
                )
                .build(),
        )
        .await
        .map_err(|_| SiteConfigClaimError::IndexesNotReady)?;
    Ok(())
}

pub async fn begin_claim(
    db: &Database,
    binding: &SiteConfigClaimBinding,
) -> Result<SiteConfigClaimBegin, SiteConfigClaimError> {
    let claims = db.collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION);
    let now = DateTime::now();
    let claim_token = generate_claim_token();
    let claim_id = ObjectId::new();
    let insert = doc! {
        "_id": claim_id,
        "idempotencyKey": &binding.key,
        "operatorId": binding.operator_id,
        "expectedRevision": binding.expected_revision,
        "payloadDigest": &binding.payload_digest,
        "status": STATUS_IN_PROGRESS,
        "claimToken": &claim_token,
        "leaseExpiresAt": lease_expires_at(now),
        "commitUnknown": false,
        "createdAt": now,
        "updatedAt": now,
    };
    match claims.insert_one(insert).await {
        Ok(_) => Ok(SiteConfigClaimBegin::Started {
            claim_id,
            claim_token: claim_token.clone(),
            undo: SiteConfigClaimUndo::DeleteNew {
                claim_id,
                claim_token,
                binding: binding.clone(),
            },
        }),
        Err(error) if is_duplicate_key_error(&error) => {
            let existing = claims
                .find_one(doc! { "idempotencyKey": &binding.key })
                .await
                .map_err(|_| SiteConfigClaimError::Storage)?
                .ok_or(SiteConfigClaimError::Storage)?;
            classify_existing_claim(&claims, existing, binding, now).await
        }
        Err(_) => Err(SiteConfigClaimError::Storage),
    }
}

async fn classify_existing_claim(
    claims: &mongodb::Collection<Document>,
    existing: Document,
    binding: &SiteConfigClaimBinding,
    now: DateTime,
) -> Result<SiteConfigClaimBegin, SiteConfigClaimError> {
    if !claim_binding_matches(&existing, binding) {
        return Ok(SiteConfigClaimBegin::Conflict);
    }
    let status = existing.get_str("status").unwrap_or_default();
    if existing.get_bool("commitUnknown").unwrap_or(false) && status != STATUS_COMPLETED {
        return Ok(SiteConfigClaimBegin::CommitUnknown);
    }
    if status == STATUS_COMPLETED {
        let status_code = match existing.get("responseStatus") {
            Some(Bson::Int32(value)) => *value as u16,
            Some(Bson::Int64(value)) => *value as u16,
            _ => 200,
        };
        let body = existing
            .get_str("responseBodyJson")
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let result_revision = match existing.get("resultRevision") {
            Some(Bson::Int32(value)) => Some(i64::from(*value)),
            Some(Bson::Int64(value)) => Some(*value),
            _ => None,
        };
        return Ok(SiteConfigClaimBegin::Completed {
            status: status_code,
            body: completed_replay_body(&body, true),
            result_revision,
        });
    }
    if can_reclaim_stale_pre_transaction(&existing, now) {
        let claim_id = existing
            .get_object_id("_id")
            .map_err(|_| SiteConfigClaimError::Storage)?;
        let prior_token = existing
            .get_str("claimToken")
            .map_err(|_| SiteConfigClaimError::Storage)?
            .to_string();
        let new_token = generate_claim_token();
        let updated = claims
            .find_one_and_update(
                doc! {
                    "_id": claim_id,
                    "claimToken": &prior_token,
                    "idempotencyKey": &binding.key,
                    "operatorId": binding.operator_id,
                    "expectedRevision": binding.expected_revision,
                    "payloadDigest": &binding.payload_digest,
                    "commitUnknown": { "$ne": true },
                    "transactionStartedAt": { "$exists": false },
                },
                doc! {
                    "$set": {
                        "status": STATUS_IN_PROGRESS,
                        "claimToken": &new_token,
                        "leaseExpiresAt": lease_expires_at(now),
                        "updatedAt": now,
                    },
                    "$unset": {
                        "transactionStartedAt": "",
                        "commitUnknown": "",
                        "responseStatus": "",
                        "responseBodyJson": "",
                        "resultRevision": "",
                    },
                },
            )
            .await
            .map_err(|_| SiteConfigClaimError::Storage)?;
        if updated.is_none() {
            return Ok(SiteConfigClaimBegin::InProgress);
        }
        return Ok(SiteConfigClaimBegin::Started {
            claim_id,
            claim_token: new_token.clone(),
            undo: SiteConfigClaimUndo::RestoreReclaimed {
                claim_id,
                claim_token: new_token,
                binding: binding.clone(),
                prior_document: existing,
            },
        });
    }
    Ok(SiteConfigClaimBegin::InProgress)
}

pub async fn mark_transaction_started(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SiteConfigClaimBinding,
) -> Result<bool, SiteConfigClaimError> {
    let now = DateTime::now();
    let result = db
        .collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyKey": &binding.key,
                "operatorId": binding.operator_id,
                "expectedRevision": binding.expected_revision,
                "payloadDigest": &binding.payload_digest,
                "status": STATUS_IN_PROGRESS,
                "commitUnknown": { "$ne": true },
            },
            doc! {
                "$set": {
                    "transactionStartedAt": now,
                    "updatedAt": now,
                },
                "$unset": { "leaseExpiresAt": "" },
            },
        )
        .await
        .map_err(|_| SiteConfigClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

pub async fn mark_retryable(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SiteConfigClaimBinding,
) -> Result<bool, SiteConfigClaimError> {
    let now = DateTime::now();
    let result = db
        .collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyKey": &binding.key,
                "operatorId": binding.operator_id,
                "expectedRevision": binding.expected_revision,
                "payloadDigest": &binding.payload_digest,
                "status": STATUS_IN_PROGRESS,
                "commitUnknown": { "$ne": true },
            },
            doc! {
                "$set": {
                    "status": STATUS_RETRYABLE,
                    "commitUnknown": false,
                    "updatedAt": now,
                },
                "$unset": {
                    "transactionStartedAt": "",
                    "leaseExpiresAt": "",
                },
            },
        )
        .await
        .map_err(|_| SiteConfigClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

pub async fn mark_commit_unknown(
    db: &Database,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SiteConfigClaimBinding,
) -> Result<bool, SiteConfigClaimError> {
    let result = db
        .collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyKey": &binding.key,
                "operatorId": binding.operator_id,
                "expectedRevision": binding.expected_revision,
                "payloadDigest": &binding.payload_digest,
                "status": STATUS_IN_PROGRESS,
            },
            doc! {
                "$set": {
                    "commitUnknown": true,
                    "updatedAt": DateTime::now(),
                },
            },
        )
        .await
        .map_err(|_| SiteConfigClaimError::Storage)?;
    Ok(result.matched_count == 1)
}

pub async fn complete_claim_in_session(
    db: &Database,
    session: &mut ClientSession,
    claim_id: ObjectId,
    claim_token: &str,
    binding: &SiteConfigClaimBinding,
    response_status: u16,
    response_body: &Value,
    result_revision: Option<i64>,
) -> Result<(), SiteConfigClaimError> {
    let body_bytes = frozen_response_within_bounds(response_body)?;
    let body_json = String::from_utf8(body_bytes).map_err(|_| SiteConfigClaimError::Storage)?;
    let mut set_doc = doc! {
        "status": STATUS_COMPLETED,
        "responseStatus": i32::from(response_status),
        "responseBodyJson": body_json,
        "commitUnknown": false,
        "updatedAt": DateTime::now(),
    };
    if let Some(revision) = result_revision {
        set_doc.insert("resultRevision", revision);
    }
    let result = db
        .collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION)
        .update_one(
            doc! {
                "_id": claim_id,
                "claimToken": claim_token,
                "idempotencyKey": &binding.key,
                "operatorId": binding.operator_id,
                "expectedRevision": binding.expected_revision,
                "payloadDigest": &binding.payload_digest,
                "status": STATUS_IN_PROGRESS,
            },
            UpdateModifications::Document(doc! { "$set": set_doc, "$unset": { "leaseExpiresAt": "" } }),
        )
        .session(&mut *session)
        .await
        .map_err(|_| SiteConfigClaimError::Storage)?;
    if result.matched_count != 1 {
        return Err(SiteConfigClaimError::Storage);
    }
    Ok(())
}

pub async fn undo_pre_effect_claim(
    db: &Database,
    undo: &SiteConfigClaimUndo,
) -> Result<(), SiteConfigClaimError> {
    let claims = db.collection::<Document>(SITE_CONFIG_CLAIMS_COLLECTION);
    match undo {
        SiteConfigClaimUndo::DeleteNew {
            claim_id,
            claim_token,
            binding,
        } => {
            let result = claims
                .delete_one(doc! {
                    "_id": *claim_id,
                    "claimToken": claim_token,
                    "idempotencyKey": &binding.key,
                    "operatorId": binding.operator_id,
                    "expectedRevision": binding.expected_revision,
                    "payloadDigest": &binding.payload_digest,
                    "status": STATUS_IN_PROGRESS,
                    "transactionStartedAt": { "$exists": false },
                    "commitUnknown": { "$ne": true },
                })
                .await
                .map_err(|_| SiteConfigClaimError::UndoFailed)?;
            if result.deleted_count != 1 {
                return Err(SiteConfigClaimError::UndoFailed);
            }
            Ok(())
        }
        SiteConfigClaimUndo::RestoreReclaimed {
            claim_id,
            claim_token,
            binding,
            prior_document,
        } => {
            let result = claims
                .find_one_and_replace(
                    doc! {
                        "_id": *claim_id,
                        "claimToken": claim_token,
                        "idempotencyKey": &binding.key,
                        "operatorId": binding.operator_id,
                        "expectedRevision": binding.expected_revision,
                        "payloadDigest": &binding.payload_digest,
                        "status": STATUS_IN_PROGRESS,
                        "transactionStartedAt": { "$exists": false },
                        "commitUnknown": { "$ne": true },
                    },
                    prior_document.clone(),
                )
                .await
                .map_err(|_| SiteConfigClaimError::UndoFailed)?;
            if result.is_none() {
                return Err(SiteConfigClaimError::UndoFailed);
            }
            Ok(())
        }
    }
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    matches!(
        error.kind.as_ref(),
        ErrorKind::Write(_) | ErrorKind::InsertMany(_)
    ) && error.to_string().contains("E11000")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;

    fn binding() -> SiteConfigClaimBinding {
        SiteConfigClaimBinding {
            key: "sitecfg_test_key_01".to_string(),
            operator_id: ObjectId::new(),
            expected_revision: 3,
            payload_digest: "abc".to_string(),
        }
    }

    #[test]
    fn normalize_key_uses_safe_ascii_bounds() {
        assert!(normalize_site_config_idempotency_key("short").is_err());
        assert!(normalize_site_config_idempotency_key("good_key_01").is_ok());
        assert!(normalize_site_config_idempotency_key("bad key!!").is_err());
    }

    #[test]
    fn claim_index_is_unique_without_ttl() {
        let model = site_config_claim_index_model();
        assert_eq!(model.keys, doc! { "idempotencyKey": 1 });
        let options = model.options.as_ref().unwrap();
        assert_eq!(options.name.as_deref(), Some(SITE_CONFIG_CLAIM_INDEX));
        assert_eq!(options.unique, Some(true));
        assert!(options.expire_after.is_none());
    }

    #[test]
    fn binding_mismatch_and_reclaim_rules() {
        let binding = binding();
        let now = DateTime::now();
        let mut doc = doc! {
            "idempotencyKey": &binding.key,
            "operatorId": binding.operator_id,
            "expectedRevision": binding.expected_revision,
            "payloadDigest": &binding.payload_digest,
            "status": STATUS_IN_PROGRESS,
            "leaseExpiresAt": DateTime::from_millis(now.timestamp_millis() - 1),
            "commitUnknown": false,
        };
        assert!(claim_binding_matches(&doc, &binding));
        assert!(can_reclaim_stale_pre_transaction(&doc, now));

        doc.insert("transactionStartedAt", now);
        assert!(!can_reclaim_stale_pre_transaction(&doc, now));

        doc.remove("transactionStartedAt");
        doc.insert("commitUnknown", true);
        assert!(!can_reclaim_stale_pre_transaction(&doc, now));

        let mut other = binding.clone();
        other.payload_digest = "different".to_string();
        assert!(!claim_binding_matches(&doc, &other));
    }

    #[test]
    fn completed_replay_only_toggles_replayed_flag() {
        let stored = serde_json::json!({
            "success": true,
            "replayed": false,
            "revision": 4,
            "data": { "brand": "Danayasa" }
        });
        let replayed = completed_replay_body(&stored, true);
        assert_eq!(replayed["success"], true);
        assert_eq!(replayed["replayed"], true);
        assert_eq!(replayed["revision"], 4);
        assert_eq!(replayed["data"]["brand"], "Danayasa");
    }

    #[test]
    fn frozen_response_bounds_are_enforced() {
        let small = serde_json::json!({"ok": true});
        assert!(frozen_response_within_bounds(&small).is_ok());
        let huge = Value::String("x".repeat(SITE_CONFIG_FROZEN_RESPONSE_MAX_BYTES + 1));
        assert_eq!(
            frozen_response_within_bounds(&huge).unwrap_err().code(),
            "SETTINGS_RESPONSE_TOO_LARGE"
        );
    }
}
