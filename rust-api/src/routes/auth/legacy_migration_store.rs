//! Persistence and exact-session installation foundation for legacy migration.
//!
//! MongoDB 3.6's Rust driver exposes write-error code/category and `errInfo` as structured data,
//! but does not expose the index name as a dedicated field.  Classification therefore accepts
//! code 11000 only with an exact structured `errInfo.indexName`, or (when omitted) an exact
//! structured `{ fingerprint: 1 }` key pattern.  Missing metadata fails closed; error strings are
//! never parsed.

use std::{collections::HashMap, sync::Mutex};

use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, spec::BinarySubtype, Binary, Bson, DateTime, Document},
    error::{Error as MongoError, ErrorKind, WriteFailure},
    options::IndexOptions,
    Database, IndexModel,
};

use super::{
    legacy_migration::{LegacyMigrationOperation, MigrationCleanupState, MigrationStatus},
    session_store::{
        exact_migration_session_document, exact_migration_session_filter, slot_max_for_role,
        AUTH_SESSIONS_COLLECTION, AUTH_SESSION_ID_INDEX, AUTH_SESSION_SLOT_INDEX,
    },
};

pub const LEGACY_MIGRATIONS_COLLECTION: &str = "legacy_session_migrations";
pub const LEGACY_MIGRATION_INDEX_NAME: &str = "legacy_session_migrations_fingerprint_uq";
pub const LEGACY_MIGRATION_SCAN_INDEX_NAME: &str = "legacy_session_migrations_cleanup_scan";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMigration {
    pub fingerprint: [u8; 32],
    pub user_id: ObjectId,
    pub target_session_id: ObjectId,
    pub legacy_expires_at: DateTime,
    pub migration_cutoff_at: DateTime,
    pub created_at: DateTime,
    pub recovery_until: DateTime,
}

/// Immutable operation identity available from the initial pending insert, before issuance
/// digests exist. Cleanup transitions use this narrower identity so they cannot rebind a pending
/// operation to another user, SID, or deadline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOperationBinding {
    pub fingerprint: [u8; 32],
    pub user_id: ObjectId,
    pub target_session_id: ObjectId,
    pub created_at: DateTime,
    pub recovery_until: DateTime,
    pub status: MigrationStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSessionBinding {
    pub fingerprint: [u8; 32],
    pub user_id: ObjectId,
    pub target_session_id: ObjectId,
    pub role: String,
    pub security_epoch: i64,
    pub slot: i32,
    pub refresh_digest: [u8; 32],
    pub recovery_digest: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuancePrecommit {
    pub binding: MigrationSessionBinding,
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 24],
    pub encryption_key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSessionInstall {
    pub binding: MigrationSessionBinding,
    pub rotation_key_id: String,
    pub absolute_expires_at: DateTime,
    pub idle_expires_at: Option<DateTime>,
    pub now: DateTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertPending {
    Inserted,
    Existing,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalWrite {
    Applied,
    AlreadyApplied,
    Miss,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExactSessionInstall {
    Installed,
    ExistingExact,
    DeviceLimit,
    Conflict,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExactSessionState {
    ExactActive,
    Missing,
    Inactive,
    Conflict,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpireResult {
    Expired,
    AlreadyTerminal,
    Miss,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupAction {
    Applied,
    AlreadyDone,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyMigrationStoreError {
    Store,
    MalformedDocument,
    Integrity,
}

/// All methods that can mutate a session take an immutable binding containing the sole SID and
/// slot.  There is no API that allocates another SID, changes generation, or selects another slot.
pub trait LegacyMigrationStore: Sync {
    async fn insert_pending(
        &self,
        proposal: &PendingMigration,
    ) -> Result<InsertPending, LegacyMigrationStoreError>;
    async fn load(
        &self,
        fingerprint: [u8; 32],
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError>;
    async fn load_by_target_session(
        &self,
        user_id: ObjectId,
        target_session_id: ObjectId,
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError>;
    async fn load_cleanup_binding(
        &self,
        operation: &LegacyMigrationOperation,
    ) -> Result<Option<MigrationSessionBinding>, LegacyMigrationStoreError>;
    async fn precommit_issuance(
        &self,
        precommit: &IssuancePrecommit,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError>;
    async fn install_exact_session(
        &self,
        install: &MigrationSessionInstall,
    ) -> Result<ExactSessionInstall, LegacyMigrationStoreError>;
    async fn verify_exact_session(
        &self,
        binding: &MigrationSessionBinding,
    ) -> Result<ExactSessionState, LegacyMigrationStoreError>;
    async fn commit(
        &self,
        binding: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError>;
    async fn complete(
        &self,
        binding: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError>;
    async fn expire(
        &self,
        binding: &MigrationOperationBinding,
        session_may_exist: bool,
        now: DateTime,
    ) -> Result<ExpireResult, LegacyMigrationStoreError>;
    async fn revoke_exact_abandoned_session(
        &self,
        binding: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError>;
    async fn release_exact_slot(
        &self,
        binding: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError>;
    async fn finish_cleanup(
        &self,
        binding: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError>;
    async fn finish_cleanup_without_session(
        &self,
        binding: &MigrationOperationBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError>;
    async fn scan_cleanup(
        &self,
        now: DateTime,
        limit: u32,
    ) -> Result<Vec<[u8; 32]>, LegacyMigrationStoreError>;
}

fn binary(bytes: &[u8]) -> Bson {
    Bson::Binary(Binary {
        subtype: BinarySubtype::Generic,
        bytes: bytes.to_vec(),
    })
}

pub fn recovery_until(created: DateTime, legacy: DateTime, cutoff: DateTime) -> DateTime {
    DateTime::from_millis(
        (created.timestamp_millis() + 60_000)
            .min(legacy.timestamp_millis())
            .min(cutoff.timestamp_millis()),
    )
}

pub fn migration_indexes() -> Vec<IndexModel> {
    vec![
        IndexModel::builder()
            .keys(doc! { "fingerprint": 1 })
            .options(
                IndexOptions::builder()
                    .name(LEGACY_MIGRATION_INDEX_NAME.to_string())
                    .unique(true)
                    .build(),
            )
            .build(),
        IndexModel::builder()
            .keys(doc! { "status": 1, "cleanupState": 1, "recoveryUntil": 1 })
            .options(
                IndexOptions::builder()
                    .name(LEGACY_MIGRATION_SCAN_INDEX_NAME.to_string())
                    .build(),
            )
            .build(),
    ]
}

pub async fn ensure_legacy_migration_indexes(db: &Database) -> mongodb::error::Result<()> {
    db.collection::<Document>(LEGACY_MIGRATIONS_COLLECTION)
        .create_indexes(migration_indexes())
        .await?;
    Ok(())
}

fn duplicate_metadata(code: i32, details: Option<&Document>) -> bool {
    if code != 11000 {
        return false;
    }
    let Some(details) = details else {
        return false;
    };
    if details.get_str("indexName") == Ok(LEGACY_MIGRATION_INDEX_NAME) {
        return true;
    }
    details
        .get_document("keyPattern")
        .is_ok_and(|pattern| pattern.len() == 1 && pattern.get_i32("fingerprint") == Ok(1))
}

pub fn structured_duplicate_fingerprint(error: &MongoError) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => {
            duplicate_metadata(write.code, write.details.as_ref())
        }
        ErrorKind::InsertMany(failure) => failure.write_errors.as_ref().is_some_and(|errors| {
            errors.len() == 1 && duplicate_metadata(errors[0].code, errors[0].details.as_ref())
        }),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionInsertFailure {
    SessionIdDuplicate,
    OwnedSlotDuplicate,
    Store,
}

fn exact_pattern(details: &Document, fields: &[&str]) -> bool {
    details.get_document("keyPattern").is_ok_and(|pattern| {
        pattern.len() == fields.len() && fields.iter().all(|field| pattern.get_i32(*field) == Ok(1))
    })
}

fn session_duplicate_metadata(code: i32, details: Option<&Document>) -> SessionInsertFailure {
    if code != 11000 {
        return SessionInsertFailure::Store;
    }
    let Some(details) = details else {
        return SessionInsertFailure::Store;
    };
    if details.get_str("indexName") == Ok(AUTH_SESSION_ID_INDEX)
        || exact_pattern(details, &["sessionId"])
    {
        SessionInsertFailure::SessionIdDuplicate
    } else if details.get_str("indexName") == Ok(AUTH_SESSION_SLOT_INDEX)
        || exact_pattern(details, &["userId", "slot"])
    {
        SessionInsertFailure::OwnedSlotDuplicate
    } else {
        SessionInsertFailure::Store
    }
}

fn classify_session_insert_error_kind(kind: &ErrorKind) -> SessionInsertFailure {
    match kind {
        ErrorKind::Write(WriteFailure::WriteError(write)) => {
            session_duplicate_metadata(write.code, write.details.as_ref())
        }
        ErrorKind::InsertMany(failure) if failure.write_concern_error.is_none() => failure
            .write_errors
            .as_ref()
            .filter(|errors| errors.len() == 1)
            .map_or(SessionInsertFailure::Store, |errors| {
                session_duplicate_metadata(errors[0].code, errors[0].details.as_ref())
            }),
        _ => SessionInsertFailure::Store,
    }
}

fn classify_session_insert_error(error: &MongoError) -> SessionInsertFailure {
    classify_session_insert_error_kind(error.kind.as_ref())
}

fn immutable_operation_filter(binding: &MigrationOperationBinding, status: &str) -> Document {
    doc! {
        "fingerprint": binary(&binding.fingerprint), "status": status,
        "userId": binding.user_id, "targetSessionId": binding.target_session_id,
        "createdAt": binding.created_at, "recoveryUntil": binding.recovery_until,
    }
}

fn immutable_filter(binding: &MigrationSessionBinding, status: &str) -> Document {
    doc! {
        "fingerprint": binary(&binding.fingerprint), "status": status,
        "userId": binding.user_id, "targetSessionId": binding.target_session_id,
        "refreshTokenDigest": binary(&binding.refresh_digest),
        "recoverySecretDigest": binary(&binding.recovery_digest),
    }
}

pub struct MongoLegacyMigrationStore<'a> {
    pub db: &'a Database,
}

impl LegacyMigrationStore for MongoLegacyMigrationStore<'_> {
    async fn insert_pending(
        &self,
        p: &PendingMigration,
    ) -> Result<InsertPending, LegacyMigrationStoreError> {
        let row = doc! { "fingerprint": binary(&p.fingerprint), "status":"pending", "userId":p.user_id,
        "targetSessionId":p.target_session_id, "legacyExpiresAt":p.legacy_expires_at,
        "migrationCutoffAt":p.migration_cutoff_at, "createdAt":p.created_at,
        "recoveryUntil":p.recovery_until, "cleanupState":"none" };
        match self
            .db
            .collection::<Document>(LEGACY_MIGRATIONS_COLLECTION)
            .insert_one(row)
            .await
        {
            Ok(_) => Ok(InsertPending::Inserted),
            Err(error) if structured_duplicate_fingerprint(&error) => Ok(InsertPending::Existing),
            Err(_) => Err(LegacyMigrationStoreError::Store),
        }
    }

    async fn load(
        &self,
        fingerprint: [u8; 32],
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError> {
        self.db
            .collection(LEGACY_MIGRATIONS_COLLECTION)
            .find_one(doc! { "fingerprint": binary(&fingerprint) })
            .projection(operation_projection())
            .await
            .map_err(|_| LegacyMigrationStoreError::Store)
    }

    async fn load_by_target_session(
        &self,
        user_id: ObjectId,
        target_session_id: ObjectId,
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError> {
        self.db
            .collection(LEGACY_MIGRATIONS_COLLECTION)
            .find_one(doc! {"userId": user_id, "targetSessionId": target_session_id})
            .projection(operation_projection())
            .await
            .map_err(|_| LegacyMigrationStoreError::Store)
    }

    async fn load_cleanup_binding(
        &self,
        op: &LegacyMigrationOperation,
    ) -> Result<Option<MigrationSessionBinding>, LegacyMigrationStoreError> {
        let Some(refresh) = op.refresh_token_digest.as_deref() else {
            return Ok(None);
        };
        let Some(recovery) = op.recovery_secret_digest.as_deref() else {
            return Ok(None);
        };
        let refresh_digest = refresh
            .try_into()
            .map_err(|_| LegacyMigrationStoreError::Integrity)?;
        let recovery_digest = recovery
            .try_into()
            .map_err(|_| LegacyMigrationStoreError::Integrity)?;
        let row = self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).find_one(doc! {
            "sessionId": op.target_session_id, "userId": op.user_id, "refreshGeneration": 0,
            "migrationOperationMarker": binary(&op.fingerprint),
            "currentRefreshTokenDigest": binary(refresh), "nextRecoverySecretDigest": binary(recovery),
        }).projection(doc! {"_id":0,"role":1,"sessionVersionAtIssue":1,"slot":1}).await.map_err(|_| LegacyMigrationStoreError::Store)?;
        let Some(row) = row else { return Ok(None) };
        Ok(Some(MigrationSessionBinding {
            fingerprint: op
                .fingerprint
                .as_slice()
                .try_into()
                .map_err(|_| LegacyMigrationStoreError::Integrity)?,
            user_id: op.user_id,
            target_session_id: op.target_session_id,
            role: row
                .get_str("role")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?
                .to_owned(),
            security_epoch: row
                .get_i64("sessionVersionAtIssue")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?,
            slot: row
                .get_i32("slot")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?,
            refresh_digest,
            recovery_digest,
        }))
    }

    async fn precommit_issuance(
        &self,
        p: &IssuancePrecommit,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let b = &p.binding;
        let result=self.db.collection::<Document>(LEGACY_MIGRATIONS_COLLECTION).update_one(
            doc! { "fingerprint":binary(&b.fingerprint), "status":"pending", "userId":b.user_id,
                "targetSessionId":b.target_session_id, "refreshTokenDigest":{"$exists":false},
                "recoverySecretDigest":{"$exists":false}, "issuanceCiphertext":{"$exists":false},
                "issuanceNonce":{"$exists":false}, "issuanceEncryptionKeyId":{"$exists":false},
                "issuanceEncryptionVersion":{"$exists":false} },
            doc! { "$set": { "refreshTokenDigest":binary(&b.refresh_digest), "recoverySecretDigest":binary(&b.recovery_digest),
                "issuanceCiphertext":binary(&p.ciphertext), "issuanceNonce":binary(&p.nonce),
                "issuanceEncryptionKeyId":&p.encryption_key_id, "issuanceEncryptionVersion":"xchacha20poly1305-v1" } }
        ).await.map_err(|_|LegacyMigrationStoreError::Store)?;
        Ok(if result.modified_count == 1 {
            ConditionalWrite::Applied
        } else {
            ConditionalWrite::Miss
        })
    }

    async fn install_exact_session(
        &self,
        p: &MigrationSessionInstall,
    ) -> Result<ExactSessionInstall, LegacyMigrationStoreError> {
        if p.binding.slot < 1 || p.binding.slot > slot_max_for_role(&p.binding.role) {
            return Ok(ExactSessionInstall::DeviceLimit);
        }
        let document = exact_migration_session_document(
            &p.binding.fingerprint,
            p.binding.user_id,
            p.binding.target_session_id,
            &p.binding.role,
            p.binding.security_epoch,
            p.binding.slot,
            &p.binding.refresh_digest,
            &p.binding.recovery_digest,
            &p.rotation_key_id,
            p.absolute_expires_at,
            p.idle_expires_at,
            p.now,
        );
        match self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .insert_one(document)
            .await
        {
            Ok(_) => Ok(ExactSessionInstall::Installed),
            Err(error) => match classify_session_insert_error(&error) {
                SessionInsertFailure::Store => Err(LegacyMigrationStoreError::Store),
                SessionInsertFailure::SessionIdDuplicate => {
                    Ok(match self.verify_exact_session(&p.binding).await? {
                        ExactSessionState::ExactActive => ExactSessionInstall::ExistingExact,
                        _ => ExactSessionInstall::Conflict,
                    })
                }
                SessionInsertFailure::OwnedSlotDuplicate => {
                    match self.verify_exact_session(&p.binding).await? {
                        ExactSessionState::ExactActive => Ok(ExactSessionInstall::ExistingExact),
                        ExactSessionState::Conflict => Ok(ExactSessionInstall::Conflict),
                        ExactSessionState::Missing | ExactSessionState::Inactive => {
                            let owner = self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION)
                                .find_one(doc! { "userId": p.binding.user_id, "slot": p.binding.slot, "ownsSlot": true })
                                .projection(doc! { "_id": 0, "sessionId": 1, "userId": 1, "slot": 1, "ownsSlot": 1 })
                                .await
                                .map_err(|_| LegacyMigrationStoreError::Store)?;
                            Ok(match owner {
                                Some(row)
                                    if row.get_object_id("sessionId").is_ok()
                                        && row.get_object_id("sessionId")
                                            != Ok(p.binding.target_session_id)
                                        && row.get_object_id("userId") == Ok(p.binding.user_id)
                                        && row.get_i32("slot") == Ok(p.binding.slot)
                                        && row.get_bool("ownsSlot") == Ok(true) =>
                                {
                                    ExactSessionInstall::DeviceLimit
                                }
                                Some(_) => ExactSessionInstall::Conflict,
                                None => ExactSessionInstall::Conflict,
                            })
                        }
                    }
                }
            },
        }
    }

    async fn verify_exact_session(
        &self,
        b: &MigrationSessionBinding,
    ) -> Result<ExactSessionState, LegacyMigrationStoreError> {
        let exact = exact_migration_session_filter(
            &b.fingerprint,
            b.user_id,
            b.target_session_id,
            &b.role,
            b.security_epoch,
            b.slot,
            &b.refresh_digest,
            &b.recovery_digest,
        );
        if self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find_one(exact)
            .await
            .map_err(|_| LegacyMigrationStoreError::Store)?
            .is_some()
        {
            return Ok(ExactSessionState::ExactActive);
        }
        Ok(
            if self
                .db
                .collection::<Document>(AUTH_SESSIONS_COLLECTION)
                .find_one(doc! {"sessionId":b.target_session_id})
                .await
                .map_err(|_| LegacyMigrationStoreError::Store)?
                .is_some()
            {
                ExactSessionState::Conflict
            } else {
                ExactSessionState::Missing
            },
        )
    }

    async fn commit(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.conditional(
            immutable_filter(b, "pending"),
            doc! {"$set":{"status":"committed","committedAt":now}},
        )
        .await
    }
    async fn complete(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.conditional(
            immutable_filter(b, "committed"),
            doc! {"$set":{"status":"completed","completedAt":now,"cleanupState":"complete"}},
        )
        .await
    }
    async fn expire(
        &self,
        b: &MigrationOperationBinding,
        session_may_exist: bool,
        now: DateTime,
    ) -> Result<ExpireResult, LegacyMigrationStoreError> {
        let status = match b.status {
            MigrationStatus::Pending => "pending",
            MigrationStatus::Committed => "committed",
            _ => return Ok(ExpireResult::AlreadyTerminal),
        };
        let mut f = immutable_operation_filter(b, status);
        f.insert("recoveryUntil", doc! {"$lt":now});
        let cleanup_state = if session_may_exist {
            "session-revoke-pending"
        } else {
            "complete"
        };
        let r=self.db.collection::<Document>(LEGACY_MIGRATIONS_COLLECTION).update_one(f,doc!{"$set":{"status":"expired","expiredAt":now,"cleanupState":cleanup_state,"cleanupAt":now}}).await.map_err(|_|LegacyMigrationStoreError::Store)?;
        Ok(if r.modified_count == 1 {
            ExpireResult::Expired
        } else {
            ExpireResult::Miss
        })
    }
    async fn revoke_exact_abandoned_session(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError> {
        let mut f = exact_migration_session_filter(
            &b.fingerprint,
            b.user_id,
            b.target_session_id,
            &b.role,
            b.security_epoch,
            b.slot,
            &b.refresh_digest,
            &b.recovery_digest,
        );
        f.insert("status", doc! {"$in":["active","locked"]});
        let r=self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(f,doc!{"$set":{"status":"revoked","revokedAt":now,"revocationReason":"legacy-migration-abandoned"}}).await.map_err(|_|LegacyMigrationStoreError::Store)?;
        Ok(if r.modified_count == 1 {
            CleanupAction::Applied
        } else {
            CleanupAction::AlreadyDone
        })
    }
    async fn release_exact_slot(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError> {
        let r=self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(doc!{"sessionId":b.target_session_id,"userId":b.user_id,"slot":b.slot,"ownsSlot":true,"refreshGeneration":0,"migrationOperationMarker":binary(&b.fingerprint),"status":"revoked"},doc!{"$set":{"ownsSlot":false,"slotReleasedAt":now}}).await.map_err(|_|LegacyMigrationStoreError::Store)?;
        Ok(if r.modified_count == 1 {
            CleanupAction::Applied
        } else {
            CleanupAction::AlreadyDone
        })
    }
    async fn finish_cleanup(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.conditional(
            immutable_filter(b, "expired"),
            doc! {"$set":{"cleanupState":"complete","cleanupAt":now}},
        )
        .await
    }
    async fn finish_cleanup_without_session(
        &self,
        b: &MigrationOperationBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.conditional(
            immutable_operation_filter(b, "expired"),
            doc! {"$set":{"cleanupState":"complete","cleanupAt":now}},
        )
        .await
    }
    async fn scan_cleanup(
        &self,
        now: DateTime,
        limit: u32,
    ) -> Result<Vec<[u8; 32]>, LegacyMigrationStoreError> {
        let cursor=self.db.collection::<Document>(LEGACY_MIGRATIONS_COLLECTION).find(doc!{"status":{"$in":["pending","committed","expired"]},"recoveryUntil":{"$lt":now},"cleanupState":{"$ne":"complete"}}).projection(doc!{"_id":0,"fingerprint":1}).limit(i64::from(limit.min(1000))).await.map_err(|_|LegacyMigrationStoreError::Store)?;
        let rows = cursor
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| LegacyMigrationStoreError::Store)?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                r.get_binary_generic("fingerprint")
                    .ok()?
                    .as_slice()
                    .try_into()
                    .ok()
            })
            .collect())
    }
}

impl MongoLegacyMigrationStore<'_> {
    async fn conditional(
        &self,
        filter: Document,
        update: Document,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let r = self
            .db
            .collection::<Document>(LEGACY_MIGRATIONS_COLLECTION)
            .update_one(filter, update)
            .await
            .map_err(|_| LegacyMigrationStoreError::Store)?;
        Ok(if r.modified_count == 1 {
            ConditionalWrite::Applied
        } else {
            ConditionalWrite::Miss
        })
    }
}

fn operation_projection() -> Document {
    doc! {"_id":0,"fingerprint":1,"status":1,"userId":1,"targetSessionId":1,"legacyExpiresAt":1,"migrationCutoffAt":1,"createdAt":1,"recoveryUntil":1,"committedAt":1,"completedAt":1,"expiredAt":1,"refreshTokenDigest":1,"recoverySecretDigest":1,"issuanceCiphertext":1,"issuanceNonce":1,"issuanceEncryptionKeyId":1,"issuanceEncryptionVersion":1,"cleanupState":1}
}

/// Deterministic production-contract seam used by orchestration tests without a live Mongo server.
#[derive(Default)]
pub struct InMemoryLegacyMigrationStore {
    operations: Mutex<HashMap<[u8; 32], LegacyMigrationOperation>>,
    sessions: Mutex<HashMap<ObjectId, Document>>,
    commands: Mutex<Vec<Document>>,
    #[cfg(test)]
    next_session_insert_failure: Mutex<Option<SessionInsertFailure>>,
    #[cfg(test)]
    fail_session_reload: Mutex<bool>,
}
impl InMemoryLegacyMigrationStore {
    pub fn captured_commands(&self) -> Vec<Document> {
        self.commands.lock().expect("commands").clone()
    }
    fn capture(&self, command: Document) {
        self.commands.lock().expect("commands").push(command)
    }
    #[cfg(test)]
    fn fail_next_session_insert(&self, failure: SessionInsertFailure) {
        *self.next_session_insert_failure.lock().unwrap() = Some(failure);
    }
    #[cfg(test)]
    fn fail_next_session_reload(&self) {
        *self.fail_session_reload.lock().unwrap() = true;
    }
}

impl LegacyMigrationStore for InMemoryLegacyMigrationStore {
    async fn insert_pending(
        &self,
        p: &PendingMigration,
    ) -> Result<InsertPending, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        if rows.contains_key(&p.fingerprint) {
            return Ok(InsertPending::Existing);
        }
        rows.insert(
            p.fingerprint,
            LegacyMigrationOperation {
                fingerprint: p.fingerprint.to_vec(),
                status: MigrationStatus::Pending,
                user_id: p.user_id,
                target_session_id: p.target_session_id,
                legacy_expires_at: p.legacy_expires_at,
                migration_cutoff_at: p.migration_cutoff_at,
                created_at: p.created_at,
                recovery_until: p.recovery_until,
                committed_at: None,
                completed_at: None,
                expired_at: None,
                refresh_token_digest: None,
                recovery_secret_digest: None,
                issuance_ciphertext: None,
                issuance_nonce: None,
                issuance_encryption_key_id: None,
                issuance_encryption_version: None,
                cleanup_state: MigrationCleanupState::None,
            },
        );
        self.capture(doc!{"insert":LEGACY_MIGRATIONS_COLLECTION,"document":{"fingerprint":binary(&p.fingerprint),"userId":p.user_id,"targetSessionId":p.target_session_id}});
        Ok(InsertPending::Inserted)
    }
    async fn load(
        &self,
        f: [u8; 32],
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError> {
        Ok(self.operations.lock().unwrap().get(&f).cloned())
    }
    async fn load_by_target_session(
        &self,
        user_id: ObjectId,
        target_session_id: ObjectId,
    ) -> Result<Option<LegacyMigrationOperation>, LegacyMigrationStoreError> {
        Ok(self
            .operations
            .lock()
            .unwrap()
            .values()
            .find(|op| op.user_id == user_id && op.target_session_id == target_session_id)
            .cloned())
    }
    async fn load_cleanup_binding(
        &self,
        op: &LegacyMigrationOperation,
    ) -> Result<Option<MigrationSessionBinding>, LegacyMigrationStoreError> {
        let sessions = self.sessions.lock().unwrap();
        let Some(row) = sessions.get(&op.target_session_id) else {
            return Ok(None);
        };
        let refresh_digest: [u8; 32] = op
            .refresh_token_digest
            .as_deref()
            .and_then(|v| v.try_into().ok())
            .ok_or(LegacyMigrationStoreError::Integrity)?;
        let recovery_digest: [u8; 32] = op
            .recovery_secret_digest
            .as_deref()
            .and_then(|v| v.try_into().ok())
            .ok_or(LegacyMigrationStoreError::Integrity)?;
        if row.get("migrationOperationMarker") != Some(&binary(&op.fingerprint))
            || row.get_object_id("userId") != Ok(op.user_id)
            || row.get_i64("refreshGeneration") != Ok(0)
            || row.get("currentRefreshTokenDigest") != Some(&binary(&refresh_digest))
            || row.get("nextRecoverySecretDigest") != Some(&binary(&recovery_digest))
        {
            return Ok(None);
        }
        Ok(Some(MigrationSessionBinding {
            fingerprint: op
                .fingerprint
                .as_slice()
                .try_into()
                .map_err(|_| LegacyMigrationStoreError::Integrity)?,
            user_id: op.user_id,
            target_session_id: op.target_session_id,
            role: row
                .get_str("role")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?
                .to_owned(),
            security_epoch: row
                .get_i64("sessionVersionAtIssue")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?,
            slot: row
                .get_i32("slot")
                .map_err(|_| LegacyMigrationStoreError::MalformedDocument)?,
            refresh_digest,
            recovery_digest,
        }))
    }
    async fn precommit_issuance(
        &self,
        p: &IssuancePrecommit,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        let Some(row) = rows.get_mut(&p.binding.fingerprint) else {
            return Ok(ConditionalWrite::Miss);
        };
        if row.status != MigrationStatus::Pending
            || row.user_id != p.binding.user_id
            || row.target_session_id != p.binding.target_session_id
        {
            return Ok(ConditionalWrite::Miss);
        }
        if row.issuance_ciphertext.is_some() {
            return Ok(ConditionalWrite::AlreadyApplied);
        }
        row.refresh_token_digest = Some(p.binding.refresh_digest.to_vec());
        row.recovery_secret_digest = Some(p.binding.recovery_digest.to_vec());
        row.issuance_ciphertext = Some(p.ciphertext.clone());
        row.issuance_nonce = Some(p.nonce.to_vec());
        row.issuance_encryption_key_id = Some(p.encryption_key_id.clone());
        row.issuance_encryption_version = Some("xchacha20poly1305-v1".into());
        self.capture(doc!{"update":LEGACY_MIGRATIONS_COLLECTION,"filter":immutable_filter(&p.binding,"pending")});
        Ok(ConditionalWrite::Applied)
    }
    async fn install_exact_session(
        &self,
        p: &MigrationSessionInstall,
    ) -> Result<ExactSessionInstall, LegacyMigrationStoreError> {
        #[cfg(test)]
        if let Some(failure) = self.next_session_insert_failure.lock().unwrap().take() {
            if failure == SessionInsertFailure::Store {
                return Err(LegacyMigrationStoreError::Store);
            }
            if *self.fail_session_reload.lock().unwrap() {
                *self.fail_session_reload.lock().unwrap() = false;
                return Err(LegacyMigrationStoreError::Store);
            }
            let sessions = self.sessions.lock().unwrap();
            return Ok(match failure {
                SessionInsertFailure::SessionIdDuplicate => sessions
                    .get(&p.binding.target_session_id)
                    .map_or(ExactSessionInstall::Conflict, |existing| {
                        if *existing
                            == exact_migration_session_document(
                                &p.binding.fingerprint,
                                p.binding.user_id,
                                p.binding.target_session_id,
                                &p.binding.role,
                                p.binding.security_epoch,
                                p.binding.slot,
                                &p.binding.refresh_digest,
                                &p.binding.recovery_digest,
                                &p.rotation_key_id,
                                p.absolute_expires_at,
                                p.idle_expires_at,
                                p.now,
                            )
                        {
                            ExactSessionInstall::ExistingExact
                        } else {
                            ExactSessionInstall::Conflict
                        }
                    }),
                SessionInsertFailure::OwnedSlotDuplicate => sessions
                    .values()
                    .find(|row| {
                        row.get_object_id("userId") == Ok(p.binding.user_id)
                            && row.get_i32("slot") == Ok(p.binding.slot)
                            && row.get_bool("ownsSlot") == Ok(true)
                    })
                    .map_or(ExactSessionInstall::Conflict, |row| {
                        match row.get_object_id("sessionId") {
                            Ok(owner_session_id)
                                if owner_session_id != p.binding.target_session_id =>
                            {
                                ExactSessionInstall::DeviceLimit
                            }
                            _ => ExactSessionInstall::Conflict,
                        }
                    }),
                SessionInsertFailure::Store => unreachable!(),
            });
        }
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(existing) = sessions.get(&p.binding.target_session_id) {
            return Ok(
                if *existing
                    == exact_migration_session_document(
                        &p.binding.fingerprint,
                        p.binding.user_id,
                        p.binding.target_session_id,
                        &p.binding.role,
                        p.binding.security_epoch,
                        p.binding.slot,
                        &p.binding.refresh_digest,
                        &p.binding.recovery_digest,
                        &p.rotation_key_id,
                        p.absolute_expires_at,
                        p.idle_expires_at,
                        p.now,
                    )
                {
                    ExactSessionInstall::ExistingExact
                } else {
                    ExactSessionInstall::Conflict
                },
            );
        }
        if sessions.values().any(|r| {
            r.get_object_id("userId") == Ok(p.binding.user_id)
                && r.get_i32("slot") == Ok(p.binding.slot)
                && r.get_bool("ownsSlot") == Ok(true)
        }) {
            return Ok(ExactSessionInstall::DeviceLimit);
        }
        let row = exact_migration_session_document(
            &p.binding.fingerprint,
            p.binding.user_id,
            p.binding.target_session_id,
            &p.binding.role,
            p.binding.security_epoch,
            p.binding.slot,
            &p.binding.refresh_digest,
            &p.binding.recovery_digest,
            &p.rotation_key_id,
            p.absolute_expires_at,
            p.idle_expires_at,
            p.now,
        );
        self.capture(doc! {"insert":AUTH_SESSIONS_COLLECTION,"document":row.clone()});
        sessions.insert(p.binding.target_session_id, row);
        Ok(ExactSessionInstall::Installed)
    }
    async fn verify_exact_session(
        &self,
        b: &MigrationSessionBinding,
    ) -> Result<ExactSessionState, LegacyMigrationStoreError> {
        let sessions = self.sessions.lock().unwrap();
        let Some(row) = sessions.get(&b.target_session_id) else {
            return Ok(ExactSessionState::Missing);
        };
        let filter = exact_migration_session_filter(
            &b.fingerprint,
            b.user_id,
            b.target_session_id,
            &b.role,
            b.security_epoch,
            b.slot,
            &b.refresh_digest,
            &b.recovery_digest,
        );
        Ok(if filter.iter().all(|(k, v)| row.get(k) == Some(v)) {
            ExactSessionState::ExactActive
        } else {
            ExactSessionState::Conflict
        })
    }
    async fn commit(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.transition(b, MigrationStatus::Pending, MigrationStatus::Committed, now)
            .map(|v| {
                if v == ConditionalWrite::Applied {
                    self.operations
                        .lock()
                        .unwrap()
                        .get_mut(&b.fingerprint)
                        .unwrap()
                        .committed_at = Some(now)
                }
                v
            })
    }
    async fn complete(
        &self,
        b: &MigrationSessionBinding,
        now: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        self.transition(
            b,
            MigrationStatus::Committed,
            MigrationStatus::Completed,
            now,
        )
        .map(|v| {
            if v == ConditionalWrite::Applied {
                let mut rows = self.operations.lock().unwrap();
                let row = rows.get_mut(&b.fingerprint).unwrap();
                row.completed_at = Some(now);
                row.cleanup_state = MigrationCleanupState::Complete
            }
            v
        })
    }
    async fn expire(
        &self,
        b: &MigrationOperationBinding,
        session_may_exist: bool,
        now: DateTime,
    ) -> Result<ExpireResult, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        let Some(row) = rows.get_mut(&b.fingerprint) else {
            return Ok(ExpireResult::Miss);
        };
        if matches!(
            row.status,
            MigrationStatus::Completed | MigrationStatus::Expired
        ) {
            return Ok(ExpireResult::AlreadyTerminal);
        }
        if now <= row.recovery_until {
            return Ok(ExpireResult::Miss);
        }
        if row.user_id != b.user_id
            || row.target_session_id != b.target_session_id
            || row.created_at != b.created_at
            || row.recovery_until != b.recovery_until
            || now <= row.recovery_until
        {
            return Ok(ExpireResult::Miss);
        }
        row.status = MigrationStatus::Expired;
        row.expired_at = Some(now);
        row.cleanup_state = if session_may_exist {
            MigrationCleanupState::SessionRevokePending
        } else {
            MigrationCleanupState::Complete
        };
        Ok(ExpireResult::Expired)
    }
    async fn revoke_exact_abandoned_session(
        &self,
        _: &MigrationSessionBinding,
        _: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError> {
        Ok(CleanupAction::AlreadyDone)
    }
    async fn release_exact_slot(
        &self,
        _: &MigrationSessionBinding,
        _: DateTime,
    ) -> Result<CleanupAction, LegacyMigrationStoreError> {
        Ok(CleanupAction::AlreadyDone)
    }
    async fn finish_cleanup(
        &self,
        b: &MigrationSessionBinding,
        _: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        let Some(row) = rows.get_mut(&b.fingerprint) else {
            return Ok(ConditionalWrite::Miss);
        };
        if row.status != MigrationStatus::Expired {
            return Ok(ConditionalWrite::Miss);
        }
        row.cleanup_state = MigrationCleanupState::Complete;
        Ok(ConditionalWrite::Applied)
    }
    async fn finish_cleanup_without_session(
        &self,
        b: &MigrationOperationBinding,
        _: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        let Some(row) = rows.get_mut(&b.fingerprint) else {
            return Ok(ConditionalWrite::Miss);
        };
        if row.status != MigrationStatus::Expired
            || row.user_id != b.user_id
            || row.target_session_id != b.target_session_id
            || row.created_at != b.created_at
            || row.recovery_until != b.recovery_until
        {
            return Ok(ConditionalWrite::Miss);
        }
        row.cleanup_state = MigrationCleanupState::Complete;
        Ok(ConditionalWrite::Applied)
    }
    async fn scan_cleanup(
        &self,
        now: DateTime,
        limit: u32,
    ) -> Result<Vec<[u8; 32]>, LegacyMigrationStoreError> {
        Ok(self
            .operations
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| {
                r.recovery_until < now && r.cleanup_state != MigrationCleanupState::Complete
            })
            .take(limit.min(1000) as usize)
            .map(|(f, _)| *f)
            .collect())
    }
}
impl InMemoryLegacyMigrationStore {
    fn transition(
        &self,
        b: &MigrationSessionBinding,
        from: MigrationStatus,
        to: MigrationStatus,
        _: DateTime,
    ) -> Result<ConditionalWrite, LegacyMigrationStoreError> {
        let mut rows = self.operations.lock().unwrap();
        let Some(row) = rows.get_mut(&b.fingerprint) else {
            return Ok(ConditionalWrite::Miss);
        };
        if row.status != from
            || row.user_id != b.user_id
            || row.target_session_id != b.target_session_id
            || row.refresh_token_digest.as_deref() != Some(b.refresh_digest.as_slice())
            || row.recovery_secret_digest.as_deref() != Some(b.recovery_digest.as_slice())
        {
            return Ok(ConditionalWrite::Miss);
        }
        row.status = to;
        Ok(ConditionalWrite::Applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn proposal() -> PendingMigration {
        let created = DateTime::from_millis(1_000);
        PendingMigration {
            fingerprint: [7; 32],
            user_id: ObjectId::new(),
            target_session_id: ObjectId::new(),
            legacy_expires_at: DateTime::from_millis(99_000),
            migration_cutoff_at: DateTime::from_millis(70_000),
            created_at: created,
            recovery_until: recovery_until(
                created,
                DateTime::from_millis(99_000),
                DateTime::from_millis(70_000),
            ),
        }
    }
    fn binding(p: &PendingMigration) -> MigrationSessionBinding {
        MigrationSessionBinding {
            fingerprint: p.fingerprint,
            user_id: p.user_id,
            target_session_id: p.target_session_id,
            role: "member".into(),
            security_epoch: 4,
            slot: 2,
            refresh_digest: [8; 32],
            recovery_digest: [9; 32],
        }
    }
    #[test]
    fn legacy_migration_store_contract() {
        let p = proposal();
        assert_eq!(p.recovery_until, DateTime::from_millis(61_000));
        let indexes = migration_indexes();
        assert_eq!(indexes[0].keys, doc! {"fingerprint":1});
        let options = indexes[0].options.as_ref().unwrap();
        assert_eq!(options.name.as_deref(), Some(LEGACY_MIGRATION_INDEX_NAME));
        assert_eq!(options.unique, Some(true));
        let encoded = mongodb::bson::to_document(&LegacyMigrationOperation {
            fingerprint: p.fingerprint.to_vec(),
            status: MigrationStatus::Pending,
            user_id: p.user_id,
            target_session_id: p.target_session_id,
            legacy_expires_at: p.legacy_expires_at,
            migration_cutoff_at: p.migration_cutoff_at,
            created_at: p.created_at,
            recovery_until: p.recovery_until,
            committed_at: None,
            completed_at: None,
            expired_at: None,
            refresh_token_digest: None,
            recovery_secret_digest: None,
            issuance_ciphertext: None,
            issuance_nonce: None,
            issuance_encryption_key_id: None,
            issuance_encryption_version: None,
            cleanup_state: MigrationCleanupState::None,
        })
        .unwrap();
        assert!(matches!(encoded.get("fingerprint"),Some(Bson::Binary(v)) if v.bytes.len()==32));
        assert_eq!(operation_projection().len(), 19)
    }
    #[test]
    fn legacy_migration_structured_write_error() {
        assert!(duplicate_metadata(
            11000,
            Some(&doc! {"indexName":LEGACY_MIGRATION_INDEX_NAME})
        ));
        assert!(duplicate_metadata(
            11000,
            Some(&doc! {"keyPattern":{"fingerprint":1}})
        ));
        assert!(!duplicate_metadata(
            11000,
            Some(&doc! {"indexName":"unrelated"})
        ));
        assert!(!duplicate_metadata(11000, None));
        assert!(!duplicate_metadata(
            42,
            Some(&doc! {"indexName":LEGACY_MIGRATION_INDEX_NAME,"message":"E11000"})
        ))
    }
    #[test]
    fn legacy_migration_session_insert_classification() {
        use mongodb::error::{WriteConcernError, WriteError};

        let write = |code, details: Option<Document>| {
            let mut row = doc! { "code": code, "errmsg": "fixture" };
            if let Some(details) = details {
                row.insert("errInfo", details);
            }
            ErrorKind::Write(WriteFailure::WriteError(
                mongodb::bson::from_document::<WriteError>(row).unwrap(),
            ))
        };
        assert_eq!(
            classify_session_insert_error_kind(&write(
                11000,
                Some(doc! { "indexName": AUTH_SESSION_SLOT_INDEX })
            )),
            SessionInsertFailure::OwnedSlotDuplicate
        );
        assert_eq!(
            classify_session_insert_error_kind(&write(
                11000,
                Some(doc! { "indexName": AUTH_SESSION_ID_INDEX })
            )),
            SessionInsertFailure::SessionIdDuplicate
        );
        for kind in [
            write(11000, Some(doc! { "indexName": "unrelated" })),
            write(11000, None),
            write(121, Some(doc! { "indexName": AUTH_SESSION_SLOT_INDEX })),
            ErrorKind::Write(WriteFailure::WriteConcernError(
                mongodb::bson::from_document::<WriteConcernError>(doc! {
                    "code": 64, "errmsg": "fixture"
                })
                .unwrap(),
            )),
        ] {
            assert_eq!(
                classify_session_insert_error_kind(&kind),
                SessionInsertFailure::Store
            );
        }
    }

    #[tokio::test]
    async fn legacy_migration_session_insert_classification_seam() {
        let p = proposal();
        let install = MigrationSessionInstall {
            binding: binding(&p),
            rotation_key_id: "rotation-1".into(),
            absolute_expires_at: DateTime::from_millis(80_000),
            idle_expires_at: None,
            now: p.created_at,
        };

        let store = InMemoryLegacyMigrationStore::default();
        store.fail_next_session_insert(SessionInsertFailure::Store);
        assert_eq!(
            store.install_exact_session(&install).await,
            Err(LegacyMigrationStoreError::Store)
        );

        let store = InMemoryLegacyMigrationStore::default();
        store.fail_next_session_insert(SessionInsertFailure::SessionIdDuplicate);
        assert_eq!(
            store.install_exact_session(&install).await.unwrap(),
            ExactSessionInstall::Conflict
        );

        let store = InMemoryLegacyMigrationStore::default();
        store.fail_next_session_insert(SessionInsertFailure::OwnedSlotDuplicate);
        assert_eq!(
            store.install_exact_session(&install).await.unwrap(),
            ExactSessionInstall::Conflict
        );

        let store = InMemoryLegacyMigrationStore::default();
        let mut owner = exact_migration_session_document(
            &[3; 32],
            install.binding.user_id,
            ObjectId::new(),
            &install.binding.role,
            install.binding.security_epoch,
            install.binding.slot,
            &[4; 32],
            &[5; 32],
            "rotation-1",
            install.absolute_expires_at,
            None,
            install.now,
        );
        let owner_sid = owner.get_object_id("sessionId").unwrap();
        owner.insert("sessionId", owner_sid);
        store.sessions.lock().unwrap().insert(owner_sid, owner);
        store.fail_next_session_insert(SessionInsertFailure::OwnedSlotDuplicate);
        assert_eq!(
            store.install_exact_session(&install).await.unwrap(),
            ExactSessionInstall::DeviceLimit
        );

        for malformed_session_id in [Some(Bson::String("not-an-object-id".into())), None] {
            let store = InMemoryLegacyMigrationStore::default();
            let mut owner = exact_migration_session_document(
                &[3; 32],
                install.binding.user_id,
                ObjectId::new(),
                &install.binding.role,
                install.binding.security_epoch,
                install.binding.slot,
                &[4; 32],
                &[5; 32],
                "rotation-1",
                install.absolute_expires_at,
                None,
                install.now,
            );
            let owner_key = owner.get_object_id("sessionId").unwrap();
            match malformed_session_id {
                Some(session_id) => {
                    owner.insert("sessionId", session_id);
                }
                None => {
                    owner.remove("sessionId");
                }
            }
            store.sessions.lock().unwrap().insert(owner_key, owner);
            store.fail_next_session_insert(SessionInsertFailure::OwnedSlotDuplicate);
            assert_eq!(
                store.install_exact_session(&install).await.unwrap(),
                ExactSessionInstall::Conflict
            );
        }

        let store = InMemoryLegacyMigrationStore::default();
        store.fail_next_session_insert(SessionInsertFailure::SessionIdDuplicate);
        store.fail_next_session_reload();
        assert_eq!(
            store.install_exact_session(&install).await,
            Err(LegacyMigrationStoreError::Store)
        );
    }

    #[tokio::test]
    async fn legacy_migration_slot_recovery() {
        let store = InMemoryLegacyMigrationStore::default();
        let p = proposal();
        assert_eq!(
            store.insert_pending(&p).await.unwrap(),
            InsertPending::Inserted
        );
        let b = binding(&p);
        let pre = IssuancePrecommit {
            binding: b.clone(),
            ciphertext: vec![1, 2, 3],
            nonce: [4; 24],
            encryption_key_id: "key-1".into(),
        };
        assert_eq!(
            store.precommit_issuance(&pre).await.unwrap(),
            ConditionalWrite::Applied
        );
        let install = MigrationSessionInstall {
            binding: b.clone(),
            rotation_key_id: "rotation-1".into(),
            absolute_expires_at: DateTime::from_millis(80_000),
            idle_expires_at: None,
            now: p.created_at,
        };
        assert_eq!(
            store.install_exact_session(&install).await.unwrap(),
            ExactSessionInstall::Installed
        );
        assert_eq!(
            store.install_exact_session(&install).await.unwrap(),
            ExactSessionInstall::ExistingExact
        );
        assert_eq!(
            store.verify_exact_session(&b).await.unwrap(),
            ExactSessionState::ExactActive
        );
        assert_eq!(store.sessions.lock().unwrap().len(), 1);
        let commands = store.captured_commands();
        assert!(commands
            .iter()
            .all(|c| !c.contains_key("startTransaction") && !c.contains_key("commitTransaction")));
        let insert = commands
            .iter()
            .find(|c| c.get_str("insert") == Ok(AUTH_SESSIONS_COLLECTION))
            .unwrap();
        let row = insert.get_document("document").unwrap();
        assert_eq!(row.get_object_id("sessionId"), Ok(b.target_session_id));
        assert_eq!(row.get_i64("refreshGeneration"), Ok(0));
        assert_eq!(row.get_i32("slot"), Ok(b.slot));
        assert!(row.contains_key("migrationOperationMarker"));
    }
}
