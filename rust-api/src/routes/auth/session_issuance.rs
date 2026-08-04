//! Recoverable device-selection issuance orchestration.
//!
//! Mongo-specific compare-and-set operations live in `session_store`; this module owns their
//! ordering. Tests can inject the same contracts without reproducing the state machine.

use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    ClientSession, Database,
};
use subtle::ConstantTimeEq;

use super::{
    policy::SessionPolicy,
    session_store::{
        derive_recovery_secret_for_operation, derive_refresh_secret_for_operation,
        device_challenge_assurance_valid, load_challenge_record, pending_device_audience_valid,
        validate_slot_ownership_state, AuthSession, ChallengeConsumeOutcome, ChallengeRecord,
        PendingIssuance, SessionStatus, AUTH_SESSIONS_COLLECTION, DEVICE_CHALLENGES_COLLECTION,
    },
    session_tokens::digest_refresh_secret,
    types::{AccessClaims, DeviceSelectionClaims, LoginAudience},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialMaterial {
    pub access_token: String,
    pub refresh_token: String,
    pub recovery_token: String,
    pub refresh_cookie_max_age_seconds: i64,
    pub recovery_cookie_max_age_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuanceError {
    Expired,
    NotFound,
    Conflict,
    InvalidSession,
    Store,
    Credential,
}

#[derive(Debug)]
pub struct IssuanceResult {
    pub material: CredentialMaterial,
    pub pending: PendingIssuance,
    pub user: Document,
    pub session: AuthSession,
}

pub trait CredentialEncoder: Sync {
    fn encode(
        &self,
        claims: &AccessClaims,
        session_id: ObjectId,
        refresh_secret: &[u8; 32],
        recovery_secret: &[u8; 32],
        refresh_cookie_max_age_seconds: i64,
    ) -> Result<CredentialMaterial, ()>;
}

/// CAS/reload contract required by the production orchestration. Implementations must return
/// authoritative stored values after every potentially losing write.
pub trait SlotAdmissionStore: Sync {
    type Claimed;
    async fn claim_next_slot(
        &self,
        max_slot: i32,
    ) -> Result<Self::Claimed, super::session_store::SlotClaimFailure>;
}

pub async fn orchestrate_slot_admission<S: SlotAdmissionStore>(
    store: &S,
    role: &str,
) -> Result<S::Claimed, super::session_store::SlotClaimFailure> {
    store
        .claim_next_slot(super::session_store::slot_max_for_role(role))
        .await
}

#[derive(Debug, Clone)]
pub struct DeviceSelectionEntryContext {
    pub remember_me: bool,
    pub device_name: String,
    pub user_agent: String,
    pub ip_address: String,
    pub issued_at: i64,
}

pub trait DeviceSelectionStore: Sync {
    /// Authoritative challenge-state resolution. Active challenges validate the old target and
    /// atomically claim; claimed/completed challenges return stored pending issuance without
    /// requiring the old session row to still exist.
    async fn resolve_entry(
        &self,
        target: ObjectId,
        entry: &DeviceSelectionEntryContext,
    ) -> Result<ChallengeConsumeOutcome, IssuanceError>;
    /// Atomically revalidates challenge, user, and target invariants, rolls the session
    /// identity, and completes the challenge. Implementations must not rely on pre-reads.
    async fn commit_issuance(
        &self,
        pending: &PendingIssuance,
        refresh_secret: &[u8; 32],
        recovery_secret: &[u8; 32],
    ) -> Result<AuthSession, ()>;
    async fn validate_current(
        &self,
        pending: &PendingIssuance,
        expected_refresh_digest: &[u8; 32],
    ) -> Result<(Document, AuthSession), ()>;
    fn rotation_refresh_digest(&self, refresh_secret: &[u8; 32]) -> [u8; 32];
    fn operation_nonce(&self) -> &str;
    fn refresh_derivation_key(&self) -> &[u8];
}

pub struct MongoDeviceSelectionStore<'a> {
    pub db: &'a Database,
    pub claims: &'a DeviceSelectionClaims,
    pub user_id: ObjectId,
    pub hash_secret: &'a [u8],
    pub rotation_key_id: &'a str,
    pub rotation_key: &'a [u8; 32],
}

fn bounded_device_name(value: &str) -> String {
    value.trim().chars().take(80).collect()
}

impl MongoDeviceSelectionStore<'_> {
    async fn commit_issuance_in_transaction(
        &self,
        mongo_session: &mut ClientSession,
        pending: &PendingIssuance,
        refresh_secret: &[u8; 32],
        recovery_secret: &[u8; 32],
    ) -> Result<AuthSession, ()> {
        let now = DateTime::now();
        let record = self
            .db
            .collection::<ChallengeRecord>(DEVICE_CHALLENGES_COLLECTION)
            .find_one(doc! { "nonce": &self.claims.nonce })
            .session(&mut *mongo_session)
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": self.user_id })
            .session(&mut *mongo_session)
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        let challenge_state_valid = record.status == "active"
            || (record.status == "claimed"
                && record.pending_issuance.as_ref() == Some(pending)
                && record.revoke_session_id == Some(pending.target_session_id));
        if !challenge_state_valid
            || pending.slot < 1
            || pending.slot > super::session_store::slot_max_for_role(&pending.role)
            || record.expires_at <= now
            || !device_challenge_assurance_valid(self.claims, &record, &user)
            || !pending_device_audience_valid(self.claims, pending)
        {
            return Err(());
        }
        // Make authoritative account invariants part of the transaction's write set;
        // a concurrent role/version/2FA change must conflict rather than follow a stale read.
        let user_fence = self
            .db
            .collection::<Document>("users")
            .update_one(
                doc! {
                    "_id": self.user_id,
                    "active": true,
                    "role": &pending.role,
                    "sessionVersion": pending.session_version_at_issue,
                    "twoFactorEnabled": self.claims.two_factor_enabled,
                },
                doc! { "$inc": { "authIssuanceFence": 1_i64 } },
            )
            .session(&mut *mongo_session)
            .await
            .map_err(|_| ())?;
        if user_fence.matched_count != 1 {
            return Err(());
        }

        let sessions = self.db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION);
        let target = sessions
            .find_one(doc! {
                "sessionId": { "$in": [pending.target_session_id, pending.replacement_session_id] },
                "userId": self.user_id,
                "status": "active",
                "ownsSlot": true,
                "slot": pending.slot,
                "role": &pending.role,
                "sessionVersionAtIssue": pending.session_version_at_issue,
                "absoluteExpiresAt": { "$gt": now },
            })
            .session(&mut *mongo_session)
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        if target.idle_expires_at.is_some_and(|idle| idle <= now) {
            return Err(());
        }

        let refresh_digest = super::session_tokens::digest_rotation_secret(
            super::session_tokens::RotationDigestDomain::Refresh,
            refresh_secret,
            self.rotation_key,
        );
        let recovery_digest = super::session_tokens::digest_rotation_secret(
            super::session_tokens::RotationDigestDomain::Recovery,
            recovery_secret,
            self.rotation_key,
        );
        let installed = if target.session_id == pending.target_session_id {
            let binary = |bytes: &[u8]| {
                Bson::Binary(mongodb::bson::Binary {
                    subtype: mongodb::bson::spec::BinarySubtype::Generic,
                    bytes: bytes.to_vec(),
                })
            };
            let mut set = doc! {
                "sessionId": pending.replacement_session_id,
                "replacedFromSessionId": pending.target_session_id,
                "ownsSlot": true,
                "role": &pending.role,
                "sessionVersionAtIssue": pending.session_version_at_issue,
                "deviceId": &pending.device_name,
                "userAgent": &pending.user_agent,
                "ipAddress": &pending.ip_address,
                "currentRefreshTokenDigest": binary(&refresh_digest),
                "nextRecoverySecretDigest": binary(&recovery_digest),
                "rotationDerivationVersion": "v1",
                "rotationKeyId": self.rotation_key_id,
                "lastSeenAt": DateTime::from_millis(pending.issued_at * 1000),
                "absoluteExpiresAt": DateTime::from_millis(pending.absolute_expires_at * 1000),
                "cleanupAt": DateTime::from_millis(pending.absolute_expires_at * 1000),
            };
            match pending.idle_expires_at {
                Some(idle) => set.insert("idleExpiresAt", DateTime::from_millis(idle * 1000)),
                None => set.insert("idleExpiresAt", Bson::Null),
            };
            let update = sessions
                .update_one(
                    doc! {
                        "sessionId": pending.target_session_id,
                        "userId": self.user_id,
                        "status": "active",
                        "ownsSlot": true,
                        "slot": pending.slot,
                        "role": &pending.role,
                        "sessionVersionAtIssue": pending.session_version_at_issue,
                        "absoluteExpiresAt": { "$gt": now },
                    },
                    doc! { "$set": set, "$inc": { "refreshGeneration": 1_i64 } },
                )
                .session(&mut *mongo_session)
                .await
                .map_err(|_| ())?;
            if update.modified_count != 1 {
                return Err(());
            }
            sessions
                .find_one(doc! { "sessionId": pending.replacement_session_id })
                .session(&mut *mongo_session)
                .await
                .map_err(|_| ())?
                .ok_or(())?
        } else if target.session_id == pending.replacement_session_id
            && target.replaced_from_session_id == Some(pending.target_session_id)
            && target.current_refresh_token_digest == refresh_digest
            && target.next_recovery_secret_digest == recovery_digest
        {
            target
        } else {
            return Err(());
        };

        let mut completion_filter = doc! {
            "nonce": &self.claims.nonce,
            "userId": self.user_id,
            "status": &record.status,
            "expiresAt": { "$gt": now },
            "loginAudience": mongodb::bson::to_bson(&self.claims.login_audience).map_err(|_| ())?,
            "role": &pending.role,
            "sessionVersion": pending.session_version_at_issue,
            "twoFactorEnabled": self.claims.two_factor_enabled,
            "twoFactorVerified": self.claims.two_factor_verified,
        };
        if record.status == "claimed" {
            completion_filter.insert("revokeSessionId", pending.target_session_id);
            completion_filter.insert(
                "pendingIssuance",
                mongodb::bson::to_bson(pending).map_err(|_| ())?,
            );
        }
        let completion = self
            .db
            .collection::<Document>(DEVICE_CHALLENGES_COLLECTION)
            .update_one(
                completion_filter,
                doc! { "$set": {
                    "status": "completed",
                    "completedAt": now,
                    "revokeSessionId": pending.target_session_id,
                    "pendingIssuance": mongodb::bson::to_bson(pending).map_err(|_| ())?,
                } },
            )
            .session(&mut *mongo_session)
            .await
            .map_err(|_| ())?;
        if completion.modified_count != 1 {
            return Err(());
        }
        Ok(installed)
    }
}

impl DeviceSelectionStore for MongoDeviceSelectionStore<'_> {
    async fn resolve_entry(
        &self,
        target: ObjectId,
        entry: &DeviceSelectionEntryContext,
    ) -> Result<ChallengeConsumeOutcome, IssuanceError> {
        let now = DateTime::now();
        let Some(record) = load_challenge_record(self.db, &self.claims.nonce)
            .await
            .map_err(|_| IssuanceError::Store)?
        else {
            return Err(IssuanceError::NotFound);
        };
        if record.expires_at < now && record.status != "completed" {
            return Err(IssuanceError::Expired);
        }
        let Some(user) = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": self.user_id })
            .await
            .map_err(|_| IssuanceError::Store)?
        else {
            return Err(IssuanceError::NotFound);
        };
        if !device_challenge_assurance_valid(self.claims, &record, &user) {
            return Err(IssuanceError::NotFound);
        }
        if record.status == "claimed" || record.status == "completed" {
            let Some(pending) = record.pending_issuance.as_ref() else {
                return Err(IssuanceError::NotFound);
            };
            if !pending_device_audience_valid(self.claims, pending) {
                return Err(IssuanceError::NotFound);
            }
            if pending.target_session_id != target {
                return Err(IssuanceError::Conflict);
            }
            return Ok(if record.status == "completed" {
                ChallengeConsumeOutcome::Completed(pending.clone())
            } else {
                ChallengeConsumeOutcome::Resume(pending.clone())
            });
        }
        if record.status != "active" || record.user_id != self.user_id {
            return Err(IssuanceError::NotFound);
        }
        let Some(target_session) = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! {
                "sessionId": target,
                "userId": self.user_id,
                "status": "active",
                "ownsSlot": true,
                "absoluteExpiresAt": { "$gt": now },
            })
            .await
            .map_err(|_| IssuanceError::Store)?
        else {
            return Err(IssuanceError::InvalidSession);
        };
        let current_role = crate::utils::bson::read_string(&user, "role");
        if super::read_i64(&user, "sessionVersion") != target_session.session_version_at_issue
            || !validate_slot_ownership_state(self.db, self.user_id, &current_role)
                .await
                .map_err(|_| IssuanceError::Store)?
        {
            return Err(IssuanceError::InvalidSession);
        }
        let proposed_policy =
            SessionPolicy::for_role(&current_role, entry.remember_me, entry.issued_at);
        let proposed = PendingIssuance {
            target_session_id: target,
            login_audience: Some(self.claims.login_audience),
            replacement_session_id: ObjectId::new(),
            slot: target_session.slot,
            session_version_at_issue: target_session.session_version_at_issue,
            role: current_role,
            issued_at: entry.issued_at,
            access_exp: proposed_policy.access_expires_at,
            access_jti: ObjectId::new().to_hex(),
            refresh_cookie_max_age_seconds: proposed_policy.absolute_expires_at - entry.issued_at,
            absolute_expires_at: proposed_policy.absolute_expires_at,
            idle_expires_at: proposed_policy.idle_expires_at,
            device_name: bounded_device_name(&entry.device_name),
            user_agent: entry.user_agent.clone(),
            ip_address: entry.ip_address.clone(),
        };
        Ok(ChallengeConsumeOutcome::ClaimedNow(proposed))
    }

    async fn commit_issuance(
        &self,
        pending: &PendingIssuance,
        refresh_secret: &[u8; 32],
        recovery_secret: &[u8; 32],
    ) -> Result<AuthSession, ()> {
        let mut session = self.db.client().start_session().await.map_err(|_| ())?;
        session.start_transaction().await.map_err(|_| ())?;
        let result = self
            .commit_issuance_in_transaction(&mut session, pending, refresh_secret, recovery_secret)
            .await;
        let installed = match result {
            Ok(value) => value,
            Err(()) => {
                let _ = session.abort_transaction().await;
                return Err(());
            }
        };
        match crate::services::idempotency::commit_mongo_transaction_with_unknown_retry(
            &mut session,
        )
        .await
        {
            crate::services::idempotency::TransactionCommitOutcome::Committed => Ok(installed),
            crate::services::idempotency::TransactionCommitOutcome::Ambiguous
            | crate::services::idempotency::TransactionCommitOutcome::FailedDefinitely => Err(()),
        }
    }

    async fn validate_current(
        &self,
        pending: &PendingIssuance,
        expected_digest: &[u8; 32],
    ) -> Result<(Document, AuthSession), ()> {
        let now = DateTime::now();
        let record = load_challenge_record(self.db, &self.claims.nonce)
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": self.user_id, "active": true })
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        let session = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": pending.replacement_session_id, "userId": self.user_id })
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        let user_version = super::read_i64(&user, "sessionVersion");
        let user_role = crate::utils::bson::read_string(&user, "role");
        let valid = record.status == "completed"
            && record.pending_issuance.as_ref() == Some(pending)
            && record.revoke_session_id == Some(pending.target_session_id)
            && device_challenge_assurance_valid(self.claims, &record, &user)
            && pending_device_audience_valid(self.claims, pending)
            && self.claims.login_audience.accepts_role(&user_role)
            && session.status == SessionStatus::Active
            && session.owns_slot
            && session.slot == pending.slot
            && session.role == pending.role
            && user_role == pending.role
            && session.session_version_at_issue == pending.session_version_at_issue
            && user_version == pending.session_version_at_issue
            && session.absolute_expires_at > now
            && session.idle_expires_at.is_none_or(|idle| idle > now)
            && session.current_refresh_token_digest.len() == expected_digest.len()
            && bool::from(
                session
                    .current_refresh_token_digest
                    .ct_eq(expected_digest.as_slice()),
            );
        valid.then_some((user, session)).ok_or(())
    }

    fn rotation_refresh_digest(&self, refresh_secret: &[u8; 32]) -> [u8; 32] {
        super::session_tokens::digest_rotation_secret(
            super::session_tokens::RotationDigestDomain::Refresh,
            refresh_secret,
            self.rotation_key,
        )
    }
    fn operation_nonce(&self) -> &str {
        &self.claims.nonce
    }
    fn refresh_derivation_key(&self) -> &[u8] {
        self.hash_secret
    }
}

pub async fn orchestrate_device_selection<S: DeviceSelectionStore, E: CredentialEncoder>(
    store: &S,
    encoder: &E,
    target: ObjectId,
    entry: DeviceSelectionEntryContext,
) -> Result<IssuanceResult, IssuanceError> {
    let pending = match store.resolve_entry(target, &entry).await? {
        ChallengeConsumeOutcome::ClaimedNow(value) | ChallengeConsumeOutcome::Resume(value) => {
            let refresh = derive_refresh_secret_for_operation(
                store.refresh_derivation_key(),
                store.operation_nonce(),
                &value.replacement_session_id.to_hex(),
            );
            let recovery = derive_recovery_secret_for_operation(
                store.refresh_derivation_key(),
                store.operation_nonce(),
                &value.replacement_session_id.to_hex(),
            );
            store
                .commit_issuance(&value, &refresh, &recovery)
                .await
                .map_err(|_| IssuanceError::InvalidSession)?;
            value
        }
        ChallengeConsumeOutcome::Completed(value) => value,
        ChallengeConsumeOutcome::Expired => return Err(IssuanceError::Expired),
        ChallengeConsumeOutcome::NotFound => return Err(IssuanceError::NotFound),
        ChallengeConsumeOutcome::Conflict => return Err(IssuanceError::Conflict),
        ChallengeConsumeOutcome::InvalidSession => return Err(IssuanceError::InvalidSession),
    };
    let refresh_secret = derive_refresh_secret_for_operation(
        store.refresh_derivation_key(),
        store.operation_nonce(),
        &pending.replacement_session_id.to_hex(),
    );
    let recovery_secret = derive_recovery_secret_for_operation(
        store.refresh_derivation_key(),
        store.operation_nonce(),
        &pending.replacement_session_id.to_hex(),
    );
    let digest = store.rotation_refresh_digest(&refresh_secret);
    let (user, session) = store
        .validate_current(&pending, &digest)
        .await
        .map_err(|_| IssuanceError::InvalidSession)?;
    let claims = AccessClaims {
        sub: session.user_id.to_hex(),
        sid: session.session_id.to_hex(),
        session_version: pending.session_version_at_issue,
        role: pending.role.clone(),
        iat: pending.issued_at,
        exp: pending.access_exp,
        jti: pending.access_jti.clone(),
        token_type: "access".into(),
    };
    let material = encoder
        .encode(
            &claims,
            session.session_id,
            &refresh_secret,
            &recovery_secret,
            pending.refresh_cookie_max_age_seconds,
        )
        .map_err(|_| IssuanceError::Credential)?;
    Ok(IssuanceResult {
        material,
        pending,
        user,
        session,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::routes::auth::session_store::{slot_max_for_role, SlotClaimFailure};

    const KEY: &[u8] = b"test-session-hash-secret-at-least-32-bytes";

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Fail {
        Claim,
        Rollover,
        Complete,
    }

    struct State {
        challenge: ChallengeConsumeOutcome,
        user: Document,
        session: AuthSession,
        fail: Option<Fail>,
    }
    struct MemStore {
        nonce: String,
        state: Mutex<State>,
    }

    fn entry(now: i64) -> DeviceSelectionEntryContext {
        DeviceSelectionEntryContext {
            remember_me: false,
            device_name: "new".into(),
            user_agent: "ua".into(),
            ip_address: "10.0.0.1".into(),
            issued_at: now,
        }
    }

    fn fixture() -> (Arc<MemStore>, ObjectId, DeviceSelectionEntryContext) {
        let uid = ObjectId::new();
        let old = ObjectId::new();
        let now = DateTime::now().timestamp_millis() / 1000;
        let session = AuthSession {
            session_id: old,
            user_id: uid,
            role: "member".into(),
            session_version_at_issue: 4,
            slot: 1,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "old".into(),
            user_agent: "ua".into(),
            ip_address: "10.0.0.1".into(),
            current_refresh_token_digest: vec![1; 32],
            consumed_refresh_token_digests: vec![],
            refresh_generation: 0,
            next_recovery_secret_digest: vec![],
            rotation_derivation_version: "v1".into(),
            rotation_key_id: String::new(),
            immediate_predecessor: None,
            status: SessionStatus::Active,
            created_at: DateTime::now(),
            last_seen_at: DateTime::now(),
            idle_expires_at: Some(DateTime::from_millis((now + 1800) * 1000)),
            absolute_expires_at: DateTime::from_millis((now + 3600) * 1000),
            cleanup_at: DateTime::from_millis((now + 3600) * 1000),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        let user = doc! { "_id": uid, "role": "member", "sessionVersion": 4_i64, "name": "Test" };
        (
            Arc::new(MemStore {
                nonce: "nonce".into(),
                state: Mutex::new(State {
                    challenge: ChallengeConsumeOutcome::NotFound,
                    user,
                    session,
                    fail: None,
                }),
            }),
            old,
            entry(now),
        )
    }

    impl DeviceSelectionStore for MemStore {
        async fn resolve_entry(
            &self,
            target: ObjectId,
            entry: &DeviceSelectionEntryContext,
        ) -> Result<ChallengeConsumeOutcome, IssuanceError> {
            let mut s = self.state.lock().unwrap();
            if s.fail == Some(Fail::Claim) {
                s.fail = None;
                return Err(IssuanceError::Store);
            }
            match &s.challenge {
                ChallengeConsumeOutcome::NotFound => {
                    if s.session.session_id != target {
                        return Err(IssuanceError::InvalidSession);
                    }
                    let proposed = PendingIssuance {
                        target_session_id: target,
                        login_audience: Some(LoginAudience::Member),
                        replacement_session_id: ObjectId::new(),
                        slot: s.session.slot,
                        session_version_at_issue: s.session.session_version_at_issue,
                        role: s.session.role.clone(),
                        issued_at: entry.issued_at,
                        access_exp: entry.issued_at + 900,
                        access_jti: "stable-jti".into(),
                        refresh_cookie_max_age_seconds: 3600,
                        absolute_expires_at: entry.issued_at + 3600,
                        idle_expires_at: Some(entry.issued_at + 1800),
                        device_name: entry.device_name.clone(),
                        user_agent: entry.user_agent.clone(),
                        ip_address: entry.ip_address.clone(),
                    };
                    s.challenge = ChallengeConsumeOutcome::ClaimedNow(proposed.clone());
                    Ok(ChallengeConsumeOutcome::ClaimedNow(proposed))
                }
                ChallengeConsumeOutcome::ClaimedNow(p) | ChallengeConsumeOutcome::Resume(p)
                    if p.target_session_id == target =>
                {
                    Ok(ChallengeConsumeOutcome::Resume(p.clone()))
                }
                ChallengeConsumeOutcome::Completed(p) if p.target_session_id == target => {
                    Ok(ChallengeConsumeOutcome::Completed(p.clone()))
                }
                _ => Err(IssuanceError::Conflict),
            }
        }

        async fn commit_issuance(
            &self,
            p: &PendingIssuance,
            refresh: &[u8; 32],
            recovery: &[u8; 32],
        ) -> Result<AuthSession, ()> {
            let mut s = self.state.lock().unwrap();
            if matches!(s.fail, Some(Fail::Claim | Fail::Rollover | Fail::Complete)) {
                s.fail = None;
                return Err(());
            }
            let role = crate::utils::bson::read_string(&s.user, "role");
            let version = super::super::read_i64(&s.user, "sessionVersion");
            let challenge_valid = matches!(
                &s.challenge,
                ChallengeConsumeOutcome::ClaimedNow(stored) | ChallengeConsumeOutcome::Resume(stored)
                    if stored == p
            );
            if !challenge_valid
                || p.login_audience != Some(LoginAudience::Member)
                || !LoginAudience::Member.accepts_role(&role)
                || role != p.role
                || version != p.session_version_at_issue
                || s.session.session_id != p.target_session_id
                || s.session.status != SessionStatus::Active
                || !s.session.owns_slot
                || s.session.slot != p.slot
                || s.session.role != p.role
                || s.session.session_version_at_issue != p.session_version_at_issue
            {
                return Err(());
            }
            s.session.session_id = p.replacement_session_id;
            s.session.replaced_from_session_id = Some(p.target_session_id);
            s.session.device_id = p.device_name.clone();
            s.session.current_refresh_token_digest = self.rotation_refresh_digest(refresh).to_vec();
            s.session.next_recovery_secret_digest =
                super::super::session_tokens::digest_rotation_secret(
                    super::super::session_tokens::RotationDigestDomain::Recovery,
                    recovery,
                    KEY,
                )
                .to_vec();
            s.challenge = ChallengeConsumeOutcome::Completed(p.clone());
            Ok(s.session.clone())
        }
        async fn validate_current(
            &self,
            p: &PendingIssuance,
            digest: &[u8; 32],
        ) -> Result<(Document, AuthSession), ()> {
            let s = self.state.lock().unwrap();
            let now = DateTime::now();
            let role = crate::utils::bson::read_string(&s.user, "role");
            let version = super::super::read_i64(&s.user, "sessionVersion");
            let valid = s.session.session_id == p.replacement_session_id
                && s.session.status == SessionStatus::Active
                && s.session.owns_slot
                && s.session.slot == p.slot
                && s.session.role == p.role
                && role == p.role
                && s.session.session_version_at_issue == p.session_version_at_issue
                && version == p.session_version_at_issue
                && s.session.absolute_expires_at > now
                && s.session.idle_expires_at.is_none_or(|v| v > now)
                && bool::from(
                    s.session
                        .current_refresh_token_digest
                        .ct_eq(digest.as_slice()),
                );
            valid.then(|| (s.user.clone(), s.session.clone())).ok_or(())
        }
        fn rotation_refresh_digest(&self, secret: &[u8; 32]) -> [u8; 32] {
            super::super::session_tokens::digest_rotation_secret(
                super::super::session_tokens::RotationDigestDomain::Refresh,
                secret,
                KEY,
            )
        }
        fn operation_nonce(&self) -> &str {
            &self.nonce
        }
        fn refresh_derivation_key(&self) -> &[u8] {
            KEY
        }
    }

    struct Encoder {
        fail: Mutex<bool>,
    }
    impl Encoder {
        fn ok() -> Self {
            Self {
                fail: Mutex::new(false),
            }
        }
    }
    impl CredentialEncoder for Encoder {
        fn encode(
            &self,
            c: &AccessClaims,
            sid: ObjectId,
            refresh: &[u8; 32],
            recovery: &[u8; 32],
            age: i64,
        ) -> Result<CredentialMaterial, ()> {
            if std::mem::take(&mut *self.fail.lock().unwrap()) {
                return Err(());
            }
            Ok(CredentialMaterial {
                access_token: serde_json::to_string(c).unwrap(),
                refresh_token: super::super::session_tokens::encode_refresh_token(
                    &sid.to_hex(),
                    refresh,
                )
                .unwrap(),
                recovery_token: super::super::session_tokens::encode_refresh_token(
                    &sid.to_hex(),
                    recovery,
                )
                .unwrap(),
                refresh_cookie_max_age_seconds: age,
                recovery_cookie_max_age_seconds: age,
            })
        }
    }

    #[tokio::test]
    async fn auth_session_issuance_concurrent_calls_converge_and_old_sid_is_absent() {
        let (store, old, entry) = fixture();
        let encoder = Arc::new(Encoder::ok());
        let (a, b) = tokio::join!(
            orchestrate_device_selection(&*store, &*encoder, old, entry.clone()),
            orchestrate_device_selection(&*store, &*encoder, old, entry.clone())
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.material, b.material);
        assert_ne!(a.session.session_id, old);
        assert_eq!(a.pending.access_jti, "stable-jti");
        assert_eq!(
            store.state.lock().unwrap().session.replaced_from_session_id,
            Some(old)
        );
    }

    #[tokio::test]
    async fn auth_session_issuance_different_target_after_claim_conflicts() {
        let (s, old, entry) = fixture();
        let e = Encoder::ok();
        orchestrate_device_selection(&*s, &e, old, entry.clone())
            .await
            .unwrap();
        assert_eq!(
            orchestrate_device_selection(&*s, &e, ObjectId::new(), entry)
                .await
                .unwrap_err(),
            IssuanceError::Conflict
        );
    }

    #[tokio::test]
    async fn auth_session_issuance_retries_each_interruption_and_response_loss() {
        for fail in [Fail::Claim, Fail::Rollover, Fail::Complete] {
            let (s, old, entry) = fixture();
            s.state.lock().unwrap().fail = Some(fail);
            let e = Encoder::ok();
            assert!(orchestrate_device_selection(&*s, &e, old, entry.clone())
                .await
                .is_err());
            let a = orchestrate_device_selection(&*s, &e, old, entry.clone())
                .await
                .unwrap();
            let b = orchestrate_device_selection(&*s, &e, old, entry)
                .await
                .unwrap();
            assert_eq!(a.material, b.material);
        }
    }

    #[tokio::test]
    async fn auth_session_issuance_encoder_failure_is_retryable() {
        let (s, old, entry) = fixture();
        let e = Encoder {
            fail: Mutex::new(true),
        };
        assert_eq!(
            orchestrate_device_selection(&*s, &e, old, entry.clone())
                .await
                .unwrap_err(),
            IssuanceError::Credential
        );
        assert!(orchestrate_device_selection(&*s, &e, old, entry)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn auth_session_issuance_completed_replay_rejects_all_current_state_changes() {
        enum Mutation {
            Revoked,
            Absolute,
            Idle,
            UserVersion,
            SessionVersion,
            Role,
            Owns,
            Slot,
            Digest,
        }
        for mutation in [
            Mutation::Revoked,
            Mutation::Absolute,
            Mutation::Idle,
            Mutation::UserVersion,
            Mutation::SessionVersion,
            Mutation::Role,
            Mutation::Owns,
            Mutation::Slot,
            Mutation::Digest,
        ] {
            let (s, old, entry) = fixture();
            let e = Encoder::ok();
            orchestrate_device_selection(&*s, &e, old, entry.clone())
                .await
                .unwrap();
            let mut st = s.state.lock().unwrap();
            match mutation {
                Mutation::Revoked => st.session.status = SessionStatus::Revoked,
                Mutation::Absolute => st.session.absolute_expires_at = DateTime::from_millis(0),
                Mutation::Idle => st.session.idle_expires_at = Some(DateTime::from_millis(0)),
                Mutation::UserVersion => {
                    st.user.insert("sessionVersion", 99_i64);
                }
                Mutation::SessionVersion => st.session.session_version_at_issue = 99,
                Mutation::Role => {
                    st.user.insert("role", "staff");
                }
                Mutation::Owns => st.session.owns_slot = false,
                Mutation::Slot => st.session.slot = 2,
                Mutation::Digest => st.session.current_refresh_token_digest = vec![9; 32],
            }
            drop(st);
            assert_eq!(
                orchestrate_device_selection(&*s, &e, old, entry)
                    .await
                    .unwrap_err(),
                IssuanceError::InvalidSession
            );
        }
    }

    /// Mirrors production route preflight: first request requires the old SID row; after rollover
    /// the old SID is absent but same target retries must still succeed.
    struct PreflightMemStore {
        nonce: String,
        state: Mutex<State>,
    }

    impl DeviceSelectionStore for PreflightMemStore {
        async fn resolve_entry(
            &self,
            target: ObjectId,
            entry: &DeviceSelectionEntryContext,
        ) -> Result<ChallengeConsumeOutcome, IssuanceError> {
            let mut s = self.state.lock().unwrap();
            match &s.challenge {
                ChallengeConsumeOutcome::NotFound => {
                    if s.session.session_id != target {
                        return Err(IssuanceError::InvalidSession);
                    }
                    let proposed = PendingIssuance {
                        target_session_id: target,
                        login_audience: Some(LoginAudience::Member),
                        replacement_session_id: ObjectId::new(),
                        slot: s.session.slot,
                        session_version_at_issue: s.session.session_version_at_issue,
                        role: s.session.role.clone(),
                        issued_at: entry.issued_at,
                        access_exp: entry.issued_at + 900,
                        access_jti: "stable-jti".into(),
                        refresh_cookie_max_age_seconds: 3600,
                        absolute_expires_at: entry.issued_at + 3600,
                        idle_expires_at: Some(entry.issued_at + 1800),
                        device_name: entry.device_name.clone(),
                        user_agent: entry.user_agent.clone(),
                        ip_address: entry.ip_address.clone(),
                    };
                    s.challenge = ChallengeConsumeOutcome::ClaimedNow(proposed.clone());
                    Ok(ChallengeConsumeOutcome::ClaimedNow(proposed))
                }
                ChallengeConsumeOutcome::ClaimedNow(p) | ChallengeConsumeOutcome::Resume(p)
                    if p.target_session_id == target =>
                {
                    Ok(ChallengeConsumeOutcome::Resume(p.clone()))
                }
                ChallengeConsumeOutcome::Completed(p) if p.target_session_id == target => {
                    Ok(ChallengeConsumeOutcome::Completed(p.clone()))
                }
                _ => Err(IssuanceError::Conflict),
            }
        }
        async fn commit_issuance(
            &self,
            p: &PendingIssuance,
            refresh: &[u8; 32],
            recovery: &[u8; 32],
        ) -> Result<AuthSession, ()> {
            let mut s = self.state.lock().unwrap();
            let role = crate::utils::bson::read_string(&s.user, "role");
            let version = super::super::read_i64(&s.user, "sessionVersion");
            let challenge_valid = matches!(
                &s.challenge,
                ChallengeConsumeOutcome::ClaimedNow(stored) | ChallengeConsumeOutcome::Resume(stored)
                    if stored == p
            );
            if !challenge_valid
                || p.login_audience != Some(LoginAudience::Member)
                || !LoginAudience::Member.accepts_role(&role)
                || role != p.role
                || version != p.session_version_at_issue
                || s.session.session_id != p.target_session_id
                || s.session.status != SessionStatus::Active
                || !s.session.owns_slot
                || s.session.slot != p.slot
                || s.session.role != p.role
                || s.session.session_version_at_issue != p.session_version_at_issue
            {
                return Err(());
            }
            s.session.session_id = p.replacement_session_id;
            s.session.replaced_from_session_id = Some(p.target_session_id);
            s.session.current_refresh_token_digest = self.rotation_refresh_digest(refresh).to_vec();
            s.session.next_recovery_secret_digest =
                super::super::session_tokens::digest_rotation_secret(
                    super::super::session_tokens::RotationDigestDomain::Recovery,
                    recovery,
                    KEY,
                )
                .to_vec();
            s.challenge = ChallengeConsumeOutcome::Completed(p.clone());
            Ok(s.session.clone())
        }
        async fn validate_current(
            &self,
            p: &PendingIssuance,
            digest: &[u8; 32],
        ) -> Result<(Document, AuthSession), ()> {
            let s = self.state.lock().unwrap();
            let role = crate::utils::bson::read_string(&s.user, "role");
            let version = super::super::read_i64(&s.user, "sessionVersion");
            let valid = p.login_audience == Some(LoginAudience::Member)
                && LoginAudience::Member.accepts_role(&role)
                && role == p.role
                && version == p.session_version_at_issue
                && s.session.session_id == p.replacement_session_id
                && bool::from(
                    s.session
                        .current_refresh_token_digest
                        .ct_eq(digest.as_slice()),
                );
            valid.then(|| (s.user.clone(), s.session.clone())).ok_or(())
        }
        fn rotation_refresh_digest(&self, secret: &[u8; 32]) -> [u8; 32] {
            super::super::session_tokens::digest_rotation_secret(
                super::super::session_tokens::RotationDigestDomain::Refresh,
                secret,
                KEY,
            )
        }
        fn operation_nonce(&self) -> &str {
            &self.nonce
        }
        fn refresh_derivation_key(&self) -> &[u8] {
            KEY
        }
    }

    fn preflight_fixture() -> (
        Arc<PreflightMemStore>,
        ObjectId,
        DeviceSelectionEntryContext,
    ) {
        let (mem, old, entry) = fixture();
        let st = mem.state.lock().unwrap();
        (
            Arc::new(PreflightMemStore {
                nonce: mem.nonce.clone(),
                state: Mutex::new(State {
                    challenge: st.challenge.clone(),
                    user: st.user.clone(),
                    session: st.session.clone(),
                    fail: None,
                }),
            }),
            old,
            entry,
        )
    }

    #[tokio::test]
    async fn auth_session_issuance_route_preflight_retry_after_rollover_when_old_sid_absent() {
        let (store, old, entry) = preflight_fixture();
        let e = Encoder::ok();
        let first = orchestrate_device_selection(&*store, &e, old, entry.clone())
            .await
            .unwrap();
        assert_ne!(store.state.lock().unwrap().session.session_id, old);
        assert_eq!(
            store.resolve_entry(old, &entry).await.unwrap(),
            ChallengeConsumeOutcome::Completed(first.pending.clone())
        );
        let replay = orchestrate_device_selection(&*store, &e, old, entry.clone())
            .await
            .unwrap();
        assert_eq!(first.material, replay.material);
    }

    #[tokio::test]
    async fn auth_session_issuance_route_preflight_encoder_failure_retry_after_old_sid_absent() {
        let (store, old, entry) = preflight_fixture();
        let e_fail = Encoder {
            fail: Mutex::new(true),
        };
        assert_eq!(
            orchestrate_device_selection(&*store, &e_fail, old, entry.clone())
                .await
                .unwrap_err(),
            IssuanceError::Credential
        );
        assert_ne!(store.state.lock().unwrap().session.session_id, old);
        let e_ok = Encoder::ok();
        let retry = orchestrate_device_selection(&*store, &e_ok, old, entry)
            .await
            .unwrap();
        assert_eq!(retry.pending.access_jti, "stable-jti");
    }

    struct Slots(Mutex<Vec<i32>>);
    impl SlotAdmissionStore for Slots {
        type Claimed = i32;
        async fn claim_next_slot(&self, max: i32) -> Result<i32, SlotClaimFailure> {
            let mut s = self.0.lock().unwrap();
            for n in 1..=max {
                if !s.contains(&n) {
                    s.push(n);
                    return Ok(n);
                }
            }
            Err(SlotClaimFailure::DeviceLimit)
        }
    }
    struct RejectBeforeMutationStore {
        outcome: ChallengeConsumeOutcome,
        validation_calls: std::sync::atomic::AtomicUsize,
        transaction_commit_calls: std::sync::atomic::AtomicUsize,
        mutation_calls: std::sync::atomic::AtomicUsize,
    }

    impl DeviceSelectionStore for RejectBeforeMutationStore {
        async fn resolve_entry(
            &self,
            _target: ObjectId,
            _entry: &DeviceSelectionEntryContext,
        ) -> Result<ChallengeConsumeOutcome, IssuanceError> {
            Ok(self.outcome.clone())
        }
        async fn commit_issuance(
            &self,
            pending: &PendingIssuance,
            _refresh: &[u8; 32],
            _recovery: &[u8; 32],
        ) -> Result<AuthSession, ()> {
            self.validation_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if pending.login_audience != Some(LoginAudience::Member) {
                return Err(());
            }
            self.mutation_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.transaction_commit_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(())
        }
        async fn validate_current(
            &self,
            pending: &PendingIssuance,
            _digest: &[u8; 32],
        ) -> Result<(Document, AuthSession), ()> {
            self.validation_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if pending.login_audience != Some(LoginAudience::Member) {
                return Err(());
            }
            panic!("valid pending was not expected in rejection test")
        }
        fn rotation_refresh_digest(&self, _secret: &[u8; 32]) -> [u8; 32] {
            [0; 32]
        }
        fn operation_nonce(&self) -> &str {
            "reject"
        }
        fn refresh_derivation_key(&self) -> &[u8] {
            KEY
        }
    }

    struct CountingEncoder(std::sync::atomic::AtomicUsize);
    impl CredentialEncoder for CountingEncoder {
        fn encode(
            &self,
            _claims: &AccessClaims,
            _sid: ObjectId,
            _refresh: &[u8; 32],
            _recovery: &[u8; 32],
            _age: i64,
        ) -> Result<CredentialMaterial, ()> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(())
        }
    }

    #[tokio::test]
    async fn malformed_audiences_have_zero_commit_mutation_or_encode_for_every_state() {
        let target = ObjectId::new();
        for malformed in [None, Some(LoginAudience::Staff)] {
            for state in ["claimed", "resume", "completed"] {
                let mut pending = PendingIssuance::new_for_test(target, 1, 4, 1);
                pending.login_audience = malformed;
                let outcome = match state {
                    "claimed" => ChallengeConsumeOutcome::ClaimedNow(pending),
                    "resume" => ChallengeConsumeOutcome::Resume(pending),
                    "completed" => ChallengeConsumeOutcome::Completed(pending),
                    _ => unreachable!(),
                };
                let store = RejectBeforeMutationStore {
                    outcome,
                    validation_calls: std::sync::atomic::AtomicUsize::new(0),
                    transaction_commit_calls: std::sync::atomic::AtomicUsize::new(0),
                    mutation_calls: std::sync::atomic::AtomicUsize::new(0),
                };
                let encoder = CountingEncoder(std::sync::atomic::AtomicUsize::new(0));
                assert_eq!(
                    orchestrate_device_selection(&store, &encoder, target, entry(1))
                        .await
                        .unwrap_err(),
                    IssuanceError::InvalidSession,
                    "state={state} audience={malformed:?}"
                );
                assert_eq!(
                    store
                        .validation_calls
                        .load(std::sync::atomic::Ordering::SeqCst),
                    1,
                    "state={state} audience={malformed:?}"
                );
                assert_eq!(
                    store
                        .transaction_commit_calls
                        .load(std::sync::atomic::Ordering::SeqCst),
                    0,
                    "state={state} audience={malformed:?}"
                );
                assert_eq!(
                    store
                        .mutation_calls
                        .load(std::sync::atomic::Ordering::SeqCst),
                    0,
                    "state={state} audience={malformed:?}"
                );
                assert_eq!(
                    encoder.0.load(std::sync::atomic::Ordering::SeqCst),
                    0,
                    "state={state} audience={malformed:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn auth_session_issuance_slot_admission_never_exceeds_role_boundary() {
        for (role, max) in [("member", 5), ("staff", 2)] {
            let s = Arc::new(Slots(Mutex::new(vec![])));
            let mut joins = vec![];
            for _ in 0..12 {
                let s = s.clone();
                joins.push(tokio::spawn(async move {
                    orchestrate_slot_admission(&*s, role).await
                }));
            }
            let mut ok = 0;
            for j in joins {
                if j.await.unwrap().is_ok() {
                    ok += 1
                }
            }
            assert_eq!(ok, max);
            assert_eq!(slot_max_for_role(role), max);
        }
    }
}
