//! Recoverable legacy-session migration state machine.
//!
//! The operation document is the coordinator on standalone MongoDB.  The order is deliberately
//! precommit ciphertext, exact session install, exact verification, then conditional commit.

use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    Database,
};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::state::RecoveryEncryptionKeyRing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrationStatus {
    Pending,
    Committed,
    Completed,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationCleanupState {
    None,
    SessionRevokePending,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationOperation {
    #[serde(with = "required_binary")]
    pub fingerprint: Vec<u8>,
    pub status: MigrationStatus,
    pub user_id: ObjectId,
    pub target_session_id: ObjectId,
    pub legacy_expires_at: DateTime,
    pub migration_cutoff_at: DateTime,
    pub created_at: DateTime,
    pub recovery_until: DateTime,
    #[serde(default)]
    pub committed_at: Option<DateTime>,
    #[serde(default)]
    pub completed_at: Option<DateTime>,
    #[serde(default)]
    pub expired_at: Option<DateTime>,
    #[serde(default, with = "optional_binary")]
    pub refresh_token_digest: Option<Vec<u8>>,
    #[serde(default, with = "optional_binary")]
    pub recovery_secret_digest: Option<Vec<u8>>,
    #[serde(default, with = "optional_binary")]
    pub issuance_ciphertext: Option<Vec<u8>>,
    #[serde(default, with = "optional_binary")]
    pub issuance_nonce: Option<Vec<u8>>,
    #[serde(default)]
    pub issuance_encryption_key_id: Option<String>,
    #[serde(default)]
    pub issuance_encryption_version: Option<String>,
    pub cleanup_state: MigrationCleanupState,
}
mod required_binary {
    use mongodb::bson::{spec::BinarySubtype, Binary};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        Binary {
            subtype: BinarySubtype::Generic,
            bytes: v.to_vec(),
        }
        .serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Ok(Binary::deserialize(d)?.bytes)
    }
}
mod optional_binary {
    use mongodb::bson::{spec::BinarySubtype, Binary};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        v.as_ref()
            .map(|v| Binary {
                subtype: BinarySubtype::Generic,
                bytes: v.clone(),
            })
            .serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        Ok(Option::<Binary>::deserialize(d)?.map(|v| v.bytes))
    }
}

use super::{
    legacy_migration_aead::{
        decrypt_migration_issuance, encrypt_migration_issuance, migration_issuance_aad,
        EncryptedMigrationIssuance, MigrationIssuancePlaintext, MigrationNonceSource,
    },
    legacy_migration_store::{
        recovery_until, ConditionalWrite, ExactSessionInstall, ExactSessionState,
        IssuancePrecommit, LegacyMigrationStore, MigrationSessionBinding, MigrationSessionInstall,
        PendingMigration,
    },
    policy::SessionPolicy,
    session_store::{slot_max_for_role, AuthSession, SessionStatus, AUTH_SESSIONS_COLLECTION},
    session_tokens::{digest_rotation_secret, RotationDigestDomain},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoritativeMigrationState {
    pub user_id: ObjectId,
    pub role: String,
    pub security_epoch: i64,
    pub slot: i32,
    pub absolute_expires_at: DateTime,
    pub idle_expires_at: Option<DateTime>,
    pub active: bool,
}

pub trait MigrationAuthority: Sync {
    async fn reload(
        &self,
        user_id: ObjectId,
        target_session_id: Option<ObjectId>,
    ) -> Result<AuthoritativeMigrationState, LegacyMigrationError>;
}

/// Production authority backed by the canonical users and auth-session collections. Initial
/// admission chooses the lowest currently unowned role-valid slot; operation recovery instead
/// reloads the exact persisted target session and never selects a replacement slot.
pub struct MongoMigrationAuthority<'a> {
    pub db: &'a Database,
    pub now: DateTime,
}

impl MigrationAuthority for MongoMigrationAuthority<'_> {
    async fn reload(
        &self,
        user_id: ObjectId,
        target_session_id: Option<ObjectId>,
    ) -> Result<AuthoritativeMigrationState, LegacyMigrationError> {
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": user_id })
            .projection(doc! { "_id": 1, "active": 1, "role": 1, "sessionVersion": 1 })
            .await
            .map_err(unavailable)?
            .ok_or(LegacyMigrationError::Invalid)?;
        if user.get_bool("active") != Ok(true) {
            return Err(LegacyMigrationError::Invalid);
        }
        let role = user
            .get_str("role")
            .map(str::to_owned)
            .map_err(|_| LegacyMigrationError::Invalid)?;
        let security_epoch = user
            .get_i64("sessionVersion")
            .map_err(|_| LegacyMigrationError::Invalid)?;

        if let Some(sid) = target_session_id {
            let session = self
                .db
                .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
                .find_one(doc! { "sessionId": sid })
                .await
                .map_err(unavailable)?
                .ok_or(LegacyMigrationError::Invalid)?;
            let active = session.status == SessionStatus::Active
                && session.owns_slot
                && session.user_id == user_id
                && session.role == role
                && session.session_version_at_issue == security_epoch;
            return Ok(AuthoritativeMigrationState {
                user_id,
                role,
                security_epoch,
                slot: session.slot,
                absolute_expires_at: session.absolute_expires_at,
                idle_expires_at: session.idle_expires_at,
                active,
            });
        }

        let mut occupied = std::collections::HashSet::new();
        let mut cursor = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find(doc! { "userId": user_id, "ownsSlot": true, "status": { "$in": ["active", "locked"] } })
            .projection(doc! { "_id": 0, "slot": 1 })
            .await
            .map_err(unavailable)?;
        while let Some(row) = cursor.try_next().await.map_err(unavailable)? {
            let slot = row.get_i32("slot").map_err(unavailable)?;
            if slot < 1 || slot > slot_max_for_role(&role) || !occupied.insert(slot) {
                return Err(LegacyMigrationError::RecoveryUnavailable);
            }
        }
        let slot = (1..=slot_max_for_role(&role))
            .find(|slot| !occupied.contains(slot))
            .ok_or(LegacyMigrationError::DeviceLimit)?;
        let policy = SessionPolicy::for_role(&role, false, self.now.timestamp_millis() / 1000);
        Ok(AuthoritativeMigrationState {
            user_id,
            role,
            security_epoch,
            slot,
            absolute_expires_at: DateTime::from_millis(policy.absolute_expires_at * 1000),
            idle_expires_at: policy
                .idle_expires_at
                .map(|v| DateTime::from_millis(v * 1000)),
            active: true,
        })
    }
}

pub trait MigrationClock: Sync {
    fn now(&self) -> DateTime;
}

pub trait MigrationRandom: MigrationNonceSource {
    fn target_session_id(&self) -> ObjectId;
    fn issuance_secret(&self) -> [u8; 32];
    fn csrf_value(&self) -> String;
}

#[derive(Debug, Clone)]
pub struct LegacyMigrationRequest {
    pub fingerprint: [u8; 32],
    pub user_id: ObjectId,
    pub legacy_expires_at: DateTime,
    pub migration_cutoff_at: DateTime,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MigrationIssuance {
    pub target_session_id: ObjectId,
    pub refresh_secret: Zeroizing<[u8; 32]>,
    pub recovery_secret: Zeroizing<[u8; 32]>,
    pub csrf_value: Zeroizing<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyMigrationError {
    Invalid,
    Race,
    DeviceLimit,
    RecoveryUnavailable,
}

fn unavailable<T>(_: T) -> LegacyMigrationError {
    LegacyMigrationError::RecoveryUnavailable
}

fn fixed32(value: Option<&Vec<u8>>) -> Result<[u8; 32], LegacyMigrationError> {
    value
        .and_then(|v| v.as_slice().try_into().ok())
        .ok_or(LegacyMigrationError::RecoveryUnavailable)
}

fn encrypted(
    op: &LegacyMigrationOperation,
) -> Result<EncryptedMigrationIssuance, LegacyMigrationError> {
    Ok(EncryptedMigrationIssuance {
        ciphertext: op
            .issuance_ciphertext
            .clone()
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?,
        nonce: op
            .issuance_nonce
            .as_ref()
            .and_then(|v| v.as_slice().try_into().ok())
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?,
        key_id: op
            .issuance_encryption_key_id
            .clone()
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?,
        version: op
            .issuance_encryption_version
            .clone()
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?,
    })
}

fn binding(
    op: &LegacyMigrationOperation,
    authority: &AuthoritativeMigrationState,
) -> Result<MigrationSessionBinding, LegacyMigrationError> {
    Ok(MigrationSessionBinding {
        fingerprint: op.fingerprint.as_slice().try_into().map_err(unavailable)?,
        user_id: op.user_id,
        target_session_id: op.target_session_id,
        role: authority.role.clone(),
        security_epoch: authority.security_epoch,
        slot: authority.slot,
        refresh_digest: fixed32(op.refresh_token_digest.as_ref())?,
        recovery_digest: fixed32(op.recovery_secret_digest.as_ref())?,
    })
}

fn validate_authority(
    authority: &AuthoritativeMigrationState,
    user_id: ObjectId,
    now: DateTime,
) -> Result<(), LegacyMigrationError> {
    if !authority.active
        || authority.user_id != user_id
        || now >= authority.absolute_expires_at
        || authority
            .idle_expires_at
            .is_some_and(|expiry| now >= expiry)
    {
        return Err(LegacyMigrationError::Invalid);
    }
    Ok(())
}

/// Resumes one immutable migration operation. Crypto/integrity/store failures are non-terminal
/// during the inclusive recovery window; deadline and authoritative terminal outcomes win first.
pub async fn acknowledge_legacy_migration<S: LegacyMigrationStore, A: MigrationAuthority>(
    store: &S,
    authority: &A,
    user_id: ObjectId,
    target_session_id: ObjectId,
    now: DateTime,
) -> Result<(), LegacyMigrationError> {
    let operation = store
        .load_by_target_session(user_id, target_session_id)
        .await
        .map_err(unavailable)?
        .ok_or(LegacyMigrationError::Invalid)?;
    if operation.user_id != user_id || operation.target_session_id != target_session_id {
        return Err(LegacyMigrationError::Invalid);
    }
    if operation.status == MigrationStatus::Completed {
        return Ok(());
    }
    if operation.status != MigrationStatus::Committed || now > operation.recovery_until {
        return Err(LegacyMigrationError::Invalid);
    }
    let current = authority.reload(user_id, Some(target_session_id)).await?;
    validate_authority(&current, user_id, now)?;
    let bound = binding(&operation, &current)?;
    if store
        .verify_exact_session(&bound)
        .await
        .map_err(unavailable)?
        != ExactSessionState::ExactActive
    {
        return Err(LegacyMigrationError::Invalid);
    }
    match store.complete(&bound, now).await.map_err(unavailable)? {
        ConditionalWrite::Applied | ConditionalWrite::AlreadyApplied => Ok(()),
        ConditionalWrite::Miss => {
            let reloaded = store
                .load(
                    operation
                        .fingerprint
                        .as_slice()
                        .try_into()
                        .map_err(unavailable)?,
                )
                .await
                .map_err(unavailable)?;
            if reloaded.is_some_and(|op| op.status == MigrationStatus::Completed) {
                Ok(())
            } else {
                Err(LegacyMigrationError::Invalid)
            }
        }
    }
}

pub async fn migrate_legacy_session<S: LegacyMigrationStore, A: MigrationAuthority>(
    store: &S,
    authority: &A,
    request: &LegacyMigrationRequest,
    clock: &dyn MigrationClock,
    random: &dyn MigrationRandom,
    encryption_keys: &RecoveryEncryptionKeyRing,
    digest_key: &[u8; 32],
    rotation_key_id: &str,
) -> Result<MigrationIssuance, LegacyMigrationError> {
    let now = clock.now();
    if now >= request.legacy_expires_at || now >= request.migration_cutoff_at {
        return Err(LegacyMigrationError::Invalid);
    }
    let initial = authority.reload(request.user_id, None).await?;
    validate_authority(&initial, request.user_id, now)?;
    let proposal = PendingMigration {
        fingerprint: request.fingerprint,
        user_id: request.user_id,
        target_session_id: random.target_session_id(),
        legacy_expires_at: request.legacy_expires_at,
        migration_cutoff_at: request.migration_cutoff_at,
        created_at: now,
        recovery_until: recovery_until(now, request.legacy_expires_at, request.migration_cutoff_at),
    };
    let _claim = store.insert_pending(&proposal).await.map_err(unavailable)?;
    let mut op = store
        .load(request.fingerprint)
        .await
        .map_err(unavailable)?
        .ok_or(LegacyMigrationError::RecoveryUnavailable)?;
    if op.user_id != request.user_id
        || op.fingerprint.as_slice() != request.fingerprint
        || matches!(
            op.status,
            MigrationStatus::Completed | MigrationStatus::Expired
        )
    {
        return Err(LegacyMigrationError::Invalid);
    }
    if now > op.recovery_until {
        return Err(LegacyMigrationError::Invalid);
    }

    if op.issuance_ciphertext.is_none() {
        let mut plaintext = Zeroizing::new(MigrationIssuancePlaintext {
            refresh_secret: random.issuance_secret(),
            recovery_secret: random.issuance_secret(),
            csrf_value: random.csrf_value(),
        });
        let aad = migration_issuance_aad(
            &request.fingerprint,
            op.user_id,
            op.target_session_id,
            op.legacy_expires_at,
            op.migration_cutoff_at,
            op.recovery_until,
        );
        let encrypted = encrypt_migration_issuance(encryption_keys, &plaintext, &aad, random)
            .map_err(unavailable)?;
        let precommit = IssuancePrecommit {
            binding: MigrationSessionBinding {
                fingerprint: request.fingerprint,
                user_id: op.user_id,
                target_session_id: op.target_session_id,
                role: initial.role.clone(),
                security_epoch: initial.security_epoch,
                slot: initial.slot,
                refresh_digest: digest_rotation_secret(
                    RotationDigestDomain::Refresh,
                    &plaintext.refresh_secret,
                    digest_key,
                ),
                recovery_digest: digest_rotation_secret(
                    RotationDigestDomain::Recovery,
                    &plaintext.recovery_secret,
                    digest_key,
                ),
            },
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            encryption_key_id: encrypted.key_id,
        };
        let _ = store
            .precommit_issuance(&precommit)
            .await
            .map_err(unavailable)?;
        plaintext.zeroize();
        op = store
            .load(request.fingerprint)
            .await
            .map_err(unavailable)?
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?;
    }

    let current = authority
        .reload(op.user_id, Some(op.target_session_id))
        .await?;
    validate_authority(&current, op.user_id, now)?;
    let bound = binding(&op, &current)?;
    if op.status == MigrationStatus::Pending {
        match store
            .verify_exact_session(&bound)
            .await
            .map_err(unavailable)?
        {
            ExactSessionState::Missing => match store
                .install_exact_session(&MigrationSessionInstall {
                    binding: bound.clone(),
                    rotation_key_id: rotation_key_id.to_owned(),
                    absolute_expires_at: current.absolute_expires_at,
                    idle_expires_at: current.idle_expires_at,
                    now,
                })
                .await
                .map_err(unavailable)?
            {
                ExactSessionInstall::Installed | ExactSessionInstall::ExistingExact => {}
                ExactSessionInstall::DeviceLimit => return Err(LegacyMigrationError::DeviceLimit),
                ExactSessionInstall::Conflict => {
                    return Err(LegacyMigrationError::RecoveryUnavailable)
                }
            },
            ExactSessionState::ExactActive => {}
            ExactSessionState::Inactive | ExactSessionState::Conflict => {
                return Err(LegacyMigrationError::RecoveryUnavailable)
            }
        }
        if store
            .verify_exact_session(&bound)
            .await
            .map_err(unavailable)?
            != ExactSessionState::ExactActive
        {
            return Err(LegacyMigrationError::Race);
        }
        match store.commit(&bound, now).await.map_err(unavailable)? {
            ConditionalWrite::Applied | ConditionalWrite::AlreadyApplied => {}
            ConditionalWrite::Miss => return Err(LegacyMigrationError::Race),
        }
        op = store
            .load(request.fingerprint)
            .await
            .map_err(unavailable)?
            .ok_or(LegacyMigrationError::RecoveryUnavailable)?;
    }
    if op.status != MigrationStatus::Committed {
        return Err(LegacyMigrationError::Invalid);
    }

    let final_state = authority
        .reload(op.user_id, Some(op.target_session_id))
        .await?;
    validate_authority(&final_state, op.user_id, now)?;
    if store
        .verify_exact_session(&binding(&op, &final_state)?)
        .await
        .map_err(unavailable)?
        != ExactSessionState::ExactActive
    {
        return Err(LegacyMigrationError::Invalid);
    }
    let aad = migration_issuance_aad(
        &request.fingerprint,
        op.user_id,
        op.target_session_id,
        op.legacy_expires_at,
        op.migration_cutoff_at,
        op.recovery_until,
    );
    let plaintext =
        decrypt_migration_issuance(encryption_keys, &encrypted(&op)?, &aad).map_err(unavailable)?;
    let refresh_digest = digest_rotation_secret(
        RotationDigestDomain::Refresh,
        &plaintext.refresh_secret,
        digest_key,
    );
    let recovery_digest = digest_rotation_secret(
        RotationDigestDomain::Recovery,
        &plaintext.recovery_secret,
        digest_key,
    );
    let bound = binding(&op, &final_state)?;
    if !bool::from(refresh_digest.ct_eq(&bound.refresh_digest))
        || !bool::from(recovery_digest.ct_eq(&bound.recovery_digest))
    {
        return Err(LegacyMigrationError::RecoveryUnavailable);
    }
    Ok(MigrationIssuance {
        target_session_id: op.target_session_id,
        refresh_secret: Zeroizing::new(plaintext.refresh_secret),
        recovery_secret: Zeroizing::new(plaintext.recovery_secret),
        csrf_value: Zeroizing::new(plaintext.csrf_value.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::super::legacy_migration_store::InMemoryLegacyMigrationStore;
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::sync::Mutex;

    struct Clock(DateTime);
    impl MigrationClock for Clock {
        fn now(&self) -> DateTime {
            self.0
        }
    }
    struct Random {
        sid: ObjectId,
        calls: Mutex<u8>,
    }
    impl MigrationNonceSource for Random {
        fn fill_migration_nonce(&self, n: &mut [u8; 24]) {
            n.fill(9)
        }
    }
    impl MigrationRandom for Random {
        fn target_session_id(&self) -> ObjectId {
            self.sid
        }
        fn issuance_secret(&self) -> [u8; 32] {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            [*c; 32]
        }
        fn csrf_value(&self) -> String {
            "csrf-pair".into()
        }
    }
    #[derive(Clone)]
    struct Authority(AuthoritativeMigrationState);
    impl MigrationAuthority for Authority {
        async fn reload(
            &self,
            _: ObjectId,
            _: Option<ObjectId>,
        ) -> Result<AuthoritativeMigrationState, LegacyMigrationError> {
            Ok(self.0.clone())
        }
    }
    fn keys() -> RecoveryEncryptionKeyRing {
        RecoveryEncryptionKeyRing::parse("enc", &format!("enc:{}", URL_SAFE_NO_PAD.encode([8; 32])))
            .unwrap()
    }
    fn setup(
        now: i64,
    ) -> (
        InMemoryLegacyMigrationStore,
        LegacyMigrationRequest,
        Clock,
        Random,
        Authority,
    ) {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        (
            InMemoryLegacyMigrationStore::default(),
            LegacyMigrationRequest {
                fingerprint: [7; 32],
                user_id: user,
                legacy_expires_at: DateTime::from_millis(100_000),
                migration_cutoff_at: DateTime::from_millis(100_000),
            },
            Clock(DateTime::from_millis(now)),
            Random {
                sid,
                calls: Mutex::new(0),
            },
            Authority(AuthoritativeMigrationState {
                user_id: user,
                role: "member".into(),
                security_epoch: 3,
                slot: 1,
                absolute_expires_at: DateTime::from_millis(90_000),
                idle_expires_at: None,
                active: true,
            }),
        )
    }
    async fn run(
        store: &InMemoryLegacyMigrationStore,
        req: &LegacyMigrationRequest,
        c: &Clock,
        r: &Random,
        a: &Authority,
    ) -> Result<MigrationIssuance, LegacyMigrationError> {
        migrate_legacy_session(store, a, req, c, r, &keys(), &[6; 32], "rotation").await
    }

    #[tokio::test]
    async fn legacy_migration_acknowledgment_requires_exact_live_committed_target() {
        let (s, q, c, r, a) = setup(1_000);
        let issued = run(&s, &q, &c, &r, &a).await.unwrap();
        acknowledge_legacy_migration(&s, &a, q.user_id, issued.target_session_id, c.0)
            .await
            .unwrap();
        acknowledge_legacy_migration(&s, &a, q.user_id, issued.target_session_id, c.0)
            .await
            .unwrap();
        assert_eq!(
            s.load(q.fingerprint).await.unwrap().unwrap().status,
            MigrationStatus::Completed
        );
        assert_eq!(
            acknowledge_legacy_migration(&s, &a, ObjectId::new(), issued.target_session_id, c.0)
                .await,
            Err(LegacyMigrationError::Invalid)
        );
    }

    #[tokio::test]
    async fn legacy_migration_interleavings() {
        let (s, q, c, r, a) = setup(1_000);
        let first = run(&s, &q, &c, &r, &a).await.unwrap();
        let second = run(&s, &q, &c, &r, &a).await.unwrap();
        assert_eq!(*first.refresh_secret, *second.refresh_secret);
        assert_eq!(first.target_session_id, second.target_session_id);
        assert_eq!(*r.calls.lock().unwrap(), 2);
    }
    #[tokio::test]
    async fn legacy_migration_crash_recovery() {
        let (s, q, c, r, a) = setup(1_000);
        let one = run(&s, &q, &c, &r, &a).await.unwrap();
        let two = run(&s, &q, &c, &r, &a).await.unwrap();
        assert_eq!(*one.recovery_secret, *two.recovery_secret);
    }
    #[tokio::test]
    async fn legacy_migration_response_loss() {
        let (s, q, c, r, a) = setup(1_000);
        let lost = run(&s, &q, &c, &r, &a).await.unwrap();
        drop(lost);
        let retry = run(&s, &q, &c, &r, &a).await.unwrap();
        assert_eq!(&*retry.csrf_value, "csrf-pair");
    }
    #[tokio::test]
    async fn legacy_migration_authoritative_precedence() {
        let (s, q, c, r, mut a) = setup(1_000);
        a.0.active = false;
        assert_eq!(
            run(&s, &q, &c, &r, &a).await,
            Err(LegacyMigrationError::Invalid)
        );
        assert!(s.captured_commands().is_empty());
    }
    #[tokio::test]
    async fn legacy_migration_boundaries() {
        let (s, q, c, r, a) = setup(1_000);
        assert!(run(&s, &q, &c, &r, &a).await.is_ok());
        let (s, q, _, r, a) = setup(100_000);
        assert_eq!(
            run(&s, &q, &Clock(DateTime::from_millis(100_000)), &r, &a).await,
            Err(LegacyMigrationError::Invalid)
        );
        assert_eq!(
            recovery_until(
                DateTime::from_millis(1_000),
                DateTime::from_millis(40_000),
                DateTime::from_millis(90_000)
            ),
            DateTime::from_millis(40_000)
        );
    }
}
