use hmac::{Hmac, Mac};
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    error::{Error as MongoError, ErrorKind, WriteFailure},
    options::IndexOptions,
    Database, IndexModel,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

mod digest_bytes_bson {
    use super::*;

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        mongodb::bson::Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: bytes.to_vec(),
        })
        .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = mongodb::bson::Bson::deserialize(deserializer)?;
        match value {
            mongodb::bson::Bson::Binary(binary) => Ok(binary.bytes),
            mongodb::bson::Bson::Array(values) => values
                .into_iter()
                .map(|value| match value {
                    mongodb::bson::Bson::Int32(byte) => {
                        u8::try_from(byte).map_err(serde::de::Error::custom)
                    }
                    mongodb::bson::Bson::Int64(byte) => {
                        u8::try_from(byte).map_err(serde::de::Error::custom)
                    }
                    other => Err(serde::de::Error::custom(format!(
                        "invalid digest byte: {other:?}"
                    ))),
                })
                .collect(),
            _ => Err(serde::de::Error::custom(
                "digest bytes must be BSON binary or byte array",
            )),
        }
    }
}
use serde_json::{json, Value};
use sha2::Sha256;

use super::{
    policy::{
        SessionPolicy, MAX_CONSUMED_REFRESH_DIGESTS, MAX_UNLOCK_REAUTH_ATTEMPTS,
        STAFF_IDLE_SECONDS, STAFF_WARNING_SECONDS,
    },
    session_tokens::{digest_refresh_secret, new_refresh_secret},
    types::{DeviceSelectionClaims, LoginAudience},
};

pub const MEMBER_SLOT_MAX: i32 = 5;
pub const STAFF_SLOT_MAX: i32 = 2;
pub const MAX_SESSION_SUMMARIES: usize = 20;

pub const AUTH_SESSIONS_COLLECTION: &str = "authsessions";
pub const AUTH_SECURITY_AUDITS_COLLECTION: &str = "authsecurityaudits";
pub const DEVICE_CHALLENGES_COLLECTION: &str = "authdevicechallenges";
pub const AUTH_SESSION_ID_INDEX: &str = "uniq_auth_session_session_id";
pub const AUTH_SESSION_SLOT_INDEX: &str = "uniq_auth_session_owned_slot";

pub fn active_session_limit(role: &str) -> i64 {
    i64::from(slot_max_for_role(role))
}

pub fn slot_max_for_role(role: &str) -> i32 {
    if matches!(role, "owner" | "admin" | "cs" | "staff") {
        STAFF_SLOT_MAX
    } else {
        MEMBER_SLOT_MAX
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChallengeConsumeOutcome {
    ClaimedNow(PendingIssuance),
    Resume(PendingIssuance),
    Completed(PendingIssuance),
    Expired,
    NotFound,
    Conflict,
    InvalidSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingIssuance {
    pub target_session_id: ObjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_audience: Option<LoginAudience>,
    pub replacement_session_id: ObjectId,
    pub slot: i32,
    pub session_version_at_issue: i64,
    pub role: String,
    pub issued_at: i64,
    pub access_exp: i64,
    pub access_jti: String,
    pub refresh_cookie_max_age_seconds: i64,
    pub absolute_expires_at: i64,
    pub idle_expires_at: Option<i64>,
    pub device_name: String,
    pub user_agent: String,
    pub ip_address: String,
}

#[cfg(test)]
impl PendingIssuance {
    pub(super) fn new_for_test(
        target_session_id: ObjectId,
        slot: i32,
        session_version_at_issue: i64,
        now: i64,
    ) -> Self {
        Self {
            target_session_id,
            login_audience: Some(LoginAudience::Member),
            replacement_session_id: ObjectId::new(),
            slot,
            session_version_at_issue,
            role: "member".into(),
            issued_at: now,
            access_exp: now + 60,
            access_jti: ObjectId::new().to_hex(),
            refresh_cookie_max_age_seconds: 60,
            absolute_expires_at: now + 60,
            idle_expires_at: None,
            device_name: "d".into(),
            user_agent: "ua".into(),
            ip_address: "127.0.0.1".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeRecord {
    pub nonce: String,
    pub user_id: ObjectId,
    pub status: String,
    pub expires_at: DateTime,
    #[serde(default)]
    pub remember_me: bool,
    #[serde(default)]
    pub login_audience: Option<LoginAudience>,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub session_version: i64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub two_factor_enabled: bool,
    #[serde(default)]
    pub two_factor_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoke_session_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_issuance: Option<PendingIssuance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotClaimFailure {
    DeviceLimit,
    Store,
}

/// True only when every factor required at challenge creation remains satisfied.
pub fn required_authentication_factors_satisfied(
    challenge_two_factor_enabled: bool,
    challenge_two_factor_verified: bool,
    current_two_factor_enabled: bool,
) -> bool {
    challenge_two_factor_enabled == current_two_factor_enabled
        && (!current_two_factor_enabled || challenge_two_factor_verified)
}

/// Validates every durable and signed binding against the authoritative current user.
/// This must run before challenge status shortcuts so claimed/completed retries cannot
/// bypass audience or account-state changes.
pub fn pending_device_audience_valid(
    claims: &DeviceSelectionClaims,
    pending: &PendingIssuance,
) -> bool {
    pending.login_audience == Some(claims.login_audience)
        && claims.login_audience.accepts_role(&pending.role)
}

pub fn device_challenge_assurance_valid(
    claims: &DeviceSelectionClaims,
    record: &ChallengeRecord,
    user: &Document,
) -> bool {
    let Ok(subject) = ObjectId::parse_str(&claims.sub) else {
        return false;
    };
    let Some(stored_audience) = record.login_audience else {
        return false;
    };
    let current_role = crate::utils::bson::read_string(user, "role");
    let current_two_factor_enabled = user.get_bool("twoFactorEnabled").unwrap_or(false);

    claims.purpose == "device-selection"
        && subject == record.user_id
        && stored_audience == claims.login_audience
        && user.get_object_id("_id").is_ok_and(|id| id == subject)
        && user.get_bool("active") == Ok(true)
        && claims.login_audience.accepts_role(&current_role)
        && current_role == claims.role
        && current_role == record.role
        && super::read_i64(user, "sessionVersion") == claims.session_version
        && record.session_version == claims.session_version
        && record.two_factor_enabled == claims.two_factor_enabled
        && record.two_factor_verified == claims.two_factor_verified
        && required_authentication_factors_satisfied(
            claims.two_factor_enabled,
            claims.two_factor_verified,
            current_two_factor_enabled,
        )
}

pub fn new_device_selection_claims(
    user_id: ObjectId,
    nonce: &str,
    now: i64,
    login_audience: LoginAudience,
) -> DeviceSelectionClaims {
    DeviceSelectionClaims {
        sub: user_id.to_hex(),
        login_audience,
        nonce: nonce.into(),
        purpose: "device-selection".into(),
        iat: now,
        exp: now + 5 * 60,
        remember_me: false,
        device_name: String::new(),
        session_version: 0,
        role: String::new(),
        two_factor_enabled: false,
        two_factor_verified: true,
    }
}

#[cfg(test)]
mod assurance_tests {
    use super::{
        device_challenge_assurance_valid, new_device_selection_claims,
        pending_device_audience_valid, required_authentication_factors_satisfied, ChallengeRecord,
        LoginAudience,
    };
    use mongodb::bson::{doc, oid::ObjectId, DateTime};

    fn fixture(
        audience: LoginAudience,
        role: &str,
    ) -> (
        super::DeviceSelectionClaims,
        ChallengeRecord,
        mongodb::bson::Document,
    ) {
        let user_id = ObjectId::new();
        let mut claims = new_device_selection_claims(user_id, "n", 1, audience);
        claims.role = role.into();
        claims.session_version = 7;
        let record = ChallengeRecord {
            nonce: "n".into(),
            user_id,
            status: "active".into(),
            expires_at: DateTime::from_millis(10_000),
            remember_me: false,
            login_audience: Some(audience),
            device_name: "device".into(),
            session_version: 7,
            role: role.into(),
            two_factor_enabled: false,
            two_factor_verified: true,
            revoke_session_id: None,
            pending_issuance: None,
        };
        let user = doc! {
            "_id": user_id,
            "active": true,
            "role": role,
            "sessionVersion": 7_i64,
            "twoFactorEnabled": false,
        };
        (claims, record, user)
    }

    #[test]
    fn challenge_assurance_matrix_covers_registration_login_otp_and_state_changes() {
        let claims = new_device_selection_claims(ObjectId::new(), "n", 1, LoginAudience::Member);
        assert!(claims.two_factor_verified); // registration/no-2FA and direct no-2FA login
        assert!(!claims.two_factor_enabled);
        assert!(required_authentication_factors_satisfied(
            false, true, false
        ));
        assert!(required_authentication_factors_satisfied(true, true, true)); // OTP
        assert!(!required_authentication_factors_satisfied(
            true, false, true
        )); // pre-OTP
        assert!(!required_authentication_factors_satisfied(
            false, true, true
        )); // activated after challenge
        assert!(!required_authentication_factors_satisfied(
            true, true, false
        )); // disabled/state changed
    }

    #[test]
    fn challenge_assurance_accepts_exact_member_and_staff_roles() {
        for (audience, role) in [
            (LoginAudience::Member, "member"),
            (LoginAudience::Staff, "owner"),
            (LoginAudience::Staff, "admin"),
            (LoginAudience::Staff, "cs"),
        ] {
            let (claims, record, user) = fixture(audience, role);
            assert!(device_challenge_assurance_valid(&claims, &record, &user));
        }
    }

    #[test]
    fn challenge_assurance_rejects_missing_mismatched_and_literal_staff_audience() {
        let (claims, mut record, user) = fixture(LoginAudience::Member, "member");
        record.login_audience = None;
        assert!(!device_challenge_assurance_valid(&claims, &record, &user));

        record.login_audience = Some(LoginAudience::Staff);
        assert!(!device_challenge_assurance_valid(&claims, &record, &user));

        let (claims, record, user) = fixture(LoginAudience::Staff, "staff");
        assert!(!device_challenge_assurance_valid(&claims, &record, &user));
    }

    #[test]
    fn old_challenge_without_audience_decodes_but_fails_assurance() {
        let (claims, record, user) = fixture(LoginAudience::Member, "member");
        let mut document = mongodb::bson::to_document(&record).unwrap();
        document.remove("loginAudience");

        let decoded: ChallengeRecord = mongodb::bson::from_document(document).unwrap();
        assert_eq!(decoded.login_audience, None);
        assert!(!device_challenge_assurance_valid(&claims, &decoded, &user));
    }

    #[test]
    fn signed_device_claim_serializes_the_login_audience() {
        let (claims, _, _) = fixture(LoginAudience::Staff, "admin");
        let value = serde_json::to_value(&claims).unwrap();
        assert_eq!(
            value.get("loginAudience").and_then(|v| v.as_str()),
            Some("staff")
        );
    }

    #[test]
    fn pending_issuance_requires_matching_audience_and_exact_role_class() {
        let user_id = ObjectId::new();
        let member_claims =
            new_device_selection_claims(user_id, "member", 1, LoginAudience::Member);
        let mut pending = super::PendingIssuance::new_for_test(user_id, 1, 0, 1);
        assert!(pending_device_audience_valid(&member_claims, &pending));

        pending.login_audience = None;
        assert!(!pending_device_audience_valid(&member_claims, &pending));
        pending.login_audience = Some(LoginAudience::Staff);
        assert!(!pending_device_audience_valid(&member_claims, &pending));

        let staff_claims = new_device_selection_claims(user_id, "staff", 1, LoginAudience::Staff);
        pending.login_audience = Some(LoginAudience::Staff);
        pending.role = "staff".into();
        assert!(!pending_device_audience_valid(&staff_claims, &pending));
        pending.role = "admin".into();
        assert!(pending_device_audience_valid(&staff_claims, &pending));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedSession {
    pub session_id: String,
    pub device_label: String,
    pub user_agent_summary: String,
    pub last_used_at: DateTime,
    pub created_at: DateTime,
    pub ip_context: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(flatten)]
    pub sanitized: SanitizedSession,
    pub current: bool,
}

pub fn bounded_session_summaries(
    mut sessions: Vec<AuthSession>,
    current_sid: ObjectId,
) -> Vec<SessionSummary> {
    sessions.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
    sessions.truncate(MAX_SESSION_SUMMARIES);
    sessions
        .into_iter()
        .map(|session| SessionSummary {
            current: session.session_id == current_sid,
            sanitized: sanitize_session(&session),
        })
        .collect()
}

pub fn sanitize_session(session: &AuthSession) -> SanitizedSession {
    SanitizedSession {
        session_id: session.session_id.to_hex(),
        device_label: session.device_id.clone(),
        user_agent_summary: session.user_agent.chars().take(80).collect(),
        last_used_at: session.last_seen_at,
        created_at: session.created_at,
        ip_context: coarse_ip_public(&session.ip_address),
    }
}

pub fn coarse_ip_public(ip: &str) -> String {
    let parts: Vec<_> = ip.split('.').collect();
    if parts.len() == 4 {
        format!("{}.{}.x.x", parts[0], parts[1])
    } else {
        "unknown".into()
    }
}

pub fn derive_refresh_secret_for_operation(
    hash_secret: &[u8],
    nonce: &str,
    session_id_hex: &str,
) -> [u8; 32] {
    derive_device_selection_secret(
        hash_secret,
        nonce,
        session_id_hex,
        b"device-selection-refresh-v1\0",
    )
}

pub fn derive_recovery_secret_for_operation(
    hash_secret: &[u8],
    nonce: &str,
    session_id_hex: &str,
) -> [u8; 32] {
    derive_device_selection_secret(
        hash_secret,
        nonce,
        session_id_hex,
        b"device-selection-recovery-v1\0",
    )
}

fn derive_device_selection_secret(
    hash_secret: &[u8],
    nonce: &str,
    session_id_hex: &str,
    label: &[u8],
) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(hash_secret).expect("HMAC key");
    mac.update(label);
    mac.update(nonce.as_bytes());
    mac.update(b"\0");
    mac.update(session_id_hex.as_bytes());
    mac.finalize().into_bytes().into()
}

fn exact_key_pattern(details: &mongodb::bson::Document) -> bool {
    details.get_document("keyPattern").is_ok_and(|pattern| {
        pattern.len() == 2 && pattern.get_i32("userId") == Ok(1) && pattern.get_i32("slot") == Ok(1)
    })
}

fn slot_duplicate_metadata(code: i32, details: Option<&mongodb::bson::Document>) -> bool {
    code == 11000
        && details.is_some_and(|details| {
            details.get_str("indexName") == Ok(AUTH_SESSION_SLOT_INDEX)
                || exact_key_pattern(details)
        })
}

fn named_slot_index_message(message: &str) -> bool {
    message
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|pair| pair[0] == "index:" && pair[1] == AUTH_SESSION_SLOT_INDEX)
}

fn slot_duplicate_error_kind(kind: &ErrorKind) -> bool {
    match kind {
        ErrorKind::Write(WriteFailure::WriteError(write)) => {
            slot_duplicate_metadata(write.code, write.details.as_ref())
                || (write.code == 11000
                    && write.details.is_none()
                    && named_slot_index_message(&write.message))
        }
        ErrorKind::InsertMany(failure) if failure.write_concern_error.is_none() => {
            failure.write_errors.as_ref().is_some_and(|errors| {
                errors.len() == 1
                    && slot_duplicate_metadata(errors[0].code, errors[0].details.as_ref())
            })
        }
        _ => false,
    }
}

pub fn slot_duplicate_key(error: &MongoError) -> bool {
    slot_duplicate_error_kind(error.kind.as_ref())
}

/// Builds the exact generation-zero session installed by legacy migration. The caller supplies
/// the already-persisted SID and slot; this helper never allocates either.
pub fn exact_migration_session_document(
    fingerprint: &[u8; 32],
    user_id: ObjectId,
    target_session_id: ObjectId,
    role: &str,
    security_epoch: i64,
    slot: i32,
    refresh_digest: &[u8; 32],
    recovery_digest: &[u8; 32],
    rotation_key_id: &str,
    absolute_expires_at: DateTime,
    idle_expires_at: Option<DateTime>,
    now: DateTime,
) -> mongodb::bson::Document {
    let binary = |bytes: &[u8]| {
        mongodb::bson::Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: bytes.to_vec(),
        })
    };
    let mut row = doc! {
        "sessionId": target_session_id, "userId": user_id, "role": role,
        "sessionVersionAtIssue": security_epoch, "slot": slot, "ownsSlot": true,
        "deviceId": "legacy-migration", "userAgent": "legacy-migration", "ipAddress": "migration",
        "currentRefreshTokenDigest": binary(refresh_digest),
        "nextRecoverySecretDigest": binary(recovery_digest),
        "rotationDerivationVersion": "v1", "rotationKeyId": rotation_key_id,
        "refreshGeneration": 0_i64, "status": "active", "createdAt": now, "lastSeenAt": now,
        "absoluteExpiresAt": absolute_expires_at, "cleanupAt": absolute_expires_at,
        "migrationOperationMarker": binary(fingerprint),
    };
    if let Some(idle) = idle_expires_at {
        row.insert("idleExpiresAt", idle);
    }
    row
}

/// Full integrity predicate shared by exact installation recovery and verification.
pub fn exact_migration_session_filter(
    fingerprint: &[u8; 32],
    user_id: ObjectId,
    target_session_id: ObjectId,
    role: &str,
    security_epoch: i64,
    slot: i32,
    refresh_digest: &[u8; 32],
    recovery_digest: &[u8; 32],
) -> mongodb::bson::Document {
    let binary = |bytes: &[u8]| {
        mongodb::bson::Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: bytes.to_vec(),
        })
    };
    doc! { "sessionId":target_session_id, "userId":user_id, "role":role,
    "sessionVersionAtIssue":security_epoch, "slot":slot, "ownsSlot":true,
    "refreshGeneration":0_i64, "status":"active",
    "currentRefreshTokenDigest":binary(refresh_digest),
    "nextRecoverySecretDigest":binary(recovery_digest),
    "migrationOperationMarker":binary(fingerprint) }
}

/// Fail-closed admission check for legacy, duplicated, or out-of-role slot ownership.
/// Operators may make this pass by idempotently setting `ownsSlot=true` and unique in-range
/// slots on every active/locked session, or deliberately revoking and releasing excess rows.
pub async fn validate_slot_ownership_state(
    db: &Database,
    user_id: ObjectId,
    role: &str,
) -> mongodb::error::Result<bool> {
    let max = slot_max_for_role(role);
    let mut cursor = db
        .collection::<mongodb::bson::Document>(AUTH_SESSIONS_COLLECTION)
        .find(doc! { "userId": user_id, "status": { "$in": ["active", "locked"] } })
        .await?;
    let mut seen = std::collections::HashSet::new();
    while cursor.advance().await? {
        let row = cursor.deserialize_current()?;
        let owned = row.get_bool("ownsSlot").unwrap_or(false);
        let slot = row.get_i32("slot").ok();
        if !owned || slot.is_none_or(|value| value < 1 || value > max || !seen.insert(value)) {
            return Ok(false);
        }
    }
    Ok(seen.len() <= max as usize)
}

pub async fn ensure_slot_indexes_ready(db: &Database) -> mongodb::error::Result<()> {
    ensure_auth_session_indexes(db).await?;
    ensure_device_challenge_indexes(db).await
}

pub async fn active_sessions_for_display(
    db: &Database,
    user_id: ObjectId,
) -> mongodb::error::Result<Vec<AuthSession>> {
    let now = DateTime::now();
    let mut cursor = db
        .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
        .find(doc! {
            "userId": user_id,
            "status": "active",
            "absoluteExpiresAt": { "$gt": now }
        })
        .await?;
    let mut sessions = Vec::new();
    while cursor.advance().await? {
        sessions.push(cursor.deserialize_current()?);
    }
    sessions.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
    sessions.truncate(MAX_SESSION_SUMMARIES);
    Ok(sessions)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeSessionResult {
    RevokedNow,
    AlreadyTerminal,
    NotOwned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlobalRevokeResult {
    pub session_version: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlobalRevokePending {
    pub operation_id: ObjectId,
    pub session_version: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalRevokeFinish {
    Completed(i64),
    AlreadyCompleted(i64),
    Follow(GlobalRevokePending),
}

pub trait SessionManagementStore {
    async fn revoke_owned(
        &self,
        user_id: ObjectId,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<RevokeSessionResult, ()>;
    async fn begin_global(
        &self,
        user_id: ObjectId,
        proposed_operation_id: ObjectId,
        now: DateTime,
    ) -> Result<GlobalRevokePending, ()>;
    async fn revoke_all(
        &self,
        user_id: ObjectId,
        operation_id: ObjectId,
        now: DateTime,
    ) -> Result<(), ()>;
    async fn finish_global(
        &self,
        user_id: ObjectId,
        operation_id: ObjectId,
        operation_epoch: i64,
        now: DateTime,
    ) -> Result<GlobalRevokeFinish, ()>;
}

pub async fn orchestrate_device_revoke<S: SessionManagementStore>(
    store: &S,
    user_id: ObjectId,
    sid: ObjectId,
    now: DateTime,
) -> Result<RevokeSessionResult, ()> {
    store.revoke_owned(user_id, sid, now).await
}

/// Standalone-safe global revocation. Beginning is one atomic user-document update which increments
/// the epoch and installs `globalRevocationPending`; access middleware fails closed while it exists.
/// Session updates and finalization are separate idempotent document operations, never claimed atomic.
pub async fn orchestrate_global_revoke<S: SessionManagementStore>(
    store: &S,
    user_id: ObjectId,
    now: DateTime,
) -> Result<GlobalRevokeResult, ()> {
    let mut pending = store.begin_global(user_id, ObjectId::new(), now).await?;
    for _ in 0..2 {
        store.revoke_all(user_id, pending.operation_id, now).await?;
        match store
            .finish_global(user_id, pending.operation_id, pending.session_version, now)
            .await?
        {
            GlobalRevokeFinish::Completed(session_version)
            | GlobalRevokeFinish::AlreadyCompleted(session_version) => {
                return Ok(GlobalRevokeResult { session_version });
            }
            GlobalRevokeFinish::Follow(current) => pending = current,
        }
    }
    Err(())
}

pub async fn create_device_limit_challenge(
    db: &Database,
    claims: &DeviceSelectionClaims,
) -> mongodb::error::Result<()> {
    let user_id = ObjectId::parse_str(&claims.sub).expect("validated user id");
    db.collection::<mongodb::bson::Document>(DEVICE_CHALLENGES_COLLECTION)
        .insert_one(doc! {
            "nonce": &claims.nonce,
            "userId": user_id,
            "status": "active",
            "rememberMe": claims.remember_me,
            "loginAudience": mongodb::bson::to_bson(&claims.login_audience)?,
            "deviceName": &claims.device_name,
            "sessionVersion": claims.session_version,
            "role": &claims.role,
            "twoFactorEnabled": claims.two_factor_enabled,
            "twoFactorVerified": claims.two_factor_verified,
            "expiresAt": DateTime::from_millis(claims.exp * 1000),
            "createdAt": DateTime::now(),
        })
        .await?;
    super::security_audit::metric_device_challenge("created");
    let span_trace = crate::services::correlation::current_span_correlation_trace_id();
    let correlation = crate::services::correlation::resolve_correlation_untrusted(
        &axum::http::HeaderMap::new(),
        span_trace.as_deref(),
    );
    super::security_audit::write_security_audit(
        db,
        super::security_audit::SecurityAuditEvent {
            event: super::security_audit::EVENT_DEVICE_CHALLENGE_CREATED,
            outcome: "created",
            user_id: Some(user_id),
            session_id: None,
            trace_id: correlation.trace_id,
            correlation_source: correlation.source.as_str(),
            action_group: None,
            reason: Some("device_limit"),
            device: Some(super::security_audit::bounded_device_context(
                &claims.device_name,
                "",
                "",
            )),
        },
    )
    .await;
    Ok(())
}

pub async fn load_challenge_record(
    db: &Database,
    nonce: &str,
) -> mongodb::error::Result<Option<ChallengeRecord>> {
    db.collection::<ChallengeRecord>(DEVICE_CHALLENGES_COLLECTION)
        .find_one(doc! { "nonce": nonce })
        .await
}

pub fn classify_challenge_for_target(
    record: &ChallengeRecord,
    user_id: ObjectId,
    target_id: ObjectId,
    now: DateTime,
) -> ChallengeConsumeOutcome {
    if record.user_id != user_id {
        return ChallengeConsumeOutcome::NotFound;
    }
    if record.expires_at < now && record.status != "completed" {
        return ChallengeConsumeOutcome::Expired;
    }
    if record.status == "completed" {
        return record
            .pending_issuance
            .clone()
            .map(ChallengeConsumeOutcome::Completed)
            .unwrap_or(ChallengeConsumeOutcome::NotFound);
    }
    if record.status == "claimed" {
        return match record.revoke_session_id {
            Some(id) if id == target_id => record
                .pending_issuance
                .clone()
                .map(ChallengeConsumeOutcome::Resume)
                .unwrap_or(ChallengeConsumeOutcome::NotFound),
            Some(_) => ChallengeConsumeOutcome::Conflict,
            None => ChallengeConsumeOutcome::NotFound,
        };
    }
    if record.status != "active" {
        return ChallengeConsumeOutcome::NotFound;
    }
    // An active record has not yet been precommitted, so classification alone cannot claim it.
    ChallengeConsumeOutcome::NotFound
}

pub async fn claim_challenge_for_target(
    db: &Database,
    claims: &DeviceSelectionClaims,
    target_id: ObjectId,
    pending: &PendingIssuance,
) -> mongodb::error::Result<ChallengeConsumeOutcome> {
    let user_id = ObjectId::parse_str(&claims.sub).expect("validated user id");
    let now = DateTime::now();
    let Some(record) = load_challenge_record(db, &claims.nonce).await? else {
        return Ok(ChallengeConsumeOutcome::NotFound);
    };
    if record.status != "active" {
        return Ok(classify_challenge_for_target(
            &record, user_id, target_id, now,
        ));
    }
    if record.user_id != user_id {
        return Ok(ChallengeConsumeOutcome::NotFound);
    }
    if record.expires_at <= now {
        return Ok(ChallengeConsumeOutcome::Expired);
    }

    let sessions = db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION);
    let target_ok = sessions
        .find_one(doc! {
            "sessionId": target_id,
            "userId": user_id,
            "status": "active",
            "absoluteExpiresAt": { "$gt": now }
        })
        .await?
        .is_some();
    if !target_ok {
        return Ok(ChallengeConsumeOutcome::InvalidSession);
    }

    let result = db
        .collection::<mongodb::bson::Document>(DEVICE_CHALLENGES_COLLECTION)
        .update_one(
            doc! {
                "nonce": &claims.nonce,
                "userId": user_id,
                "status": "active",
                "expiresAt": { "$gt": now },
                "loginAudience": mongodb::bson::to_bson(&claims.login_audience)?,
                "role": &claims.role,
                "sessionVersion": claims.session_version,
                "twoFactorEnabled": claims.two_factor_enabled,
                "twoFactorVerified": claims.two_factor_verified,
            },
            doc! {
                "$set": {
                    "status": "claimed",
                    "revokeSessionId": target_id,
                    "claimedAt": now,
                    "pendingIssuance": mongodb::bson::to_bson(pending)?,
                }
            },
        )
        .await?;
    if result.modified_count == 1 {
        return Ok(ChallengeConsumeOutcome::ClaimedNow(pending.clone()));
    }
    let Some(record) = load_challenge_record(db, &claims.nonce).await? else {
        return Ok(ChallengeConsumeOutcome::NotFound);
    };
    Ok(classify_challenge_for_target(
        &record, user_id, target_id, now,
    ))
}

pub async fn complete_challenge_record(
    db: &Database,
    nonce: &str,
    user_id: ObjectId,
    expected: &PendingIssuance,
) -> mongodb::error::Result<Option<PendingIssuance>> {
    let result = db
        .collection::<mongodb::bson::Document>(DEVICE_CHALLENGES_COLLECTION)
        .update_one(
            doc! {
                "nonce": nonce,
                "userId": user_id,
                "status": "claimed",
                "loginAudience": mongodb::bson::to_bson(&expected.login_audience)?,
                "role": &expected.role,
                "sessionVersion": expected.session_version_at_issue,
                "revokeSessionId": expected.target_session_id,
                "pendingIssuance": mongodb::bson::to_bson(expected)?,
            },
            doc! {
                "$set": {
                    "status": "completed",
                    "completedAt": DateTime::now(),
                }
            },
        )
        .await?;
    let record = load_challenge_record(db, nonce).await?;
    if result.modified_count == 0 {
        // A concurrent completer may have won, but only the exact same immutable
        // pending issuance is acceptable for idempotent response-loss recovery.
        return Ok(record.and_then(|r| {
            (r.status == "completed" && r.pending_issuance.as_ref() == Some(expected))
                .then_some(expected.clone())
        }));
    }
    Ok(record.and_then(|r| {
        (r.status == "completed" && r.pending_issuance.as_ref() == Some(expected))
            .then_some(expected.clone())
    }))
}

pub async fn try_claim_session_slot(
    db: &Database,
    user_id: ObjectId,
    role: &str,
    session_version_at_issue: i64,
    device_id: &str,
    user_agent: &str,
    ip_address: &str,
    policy: SessionPolicy,
    now: i64,
    refresh_secret: [u8; 32],
    recovery_secret: [u8; 32],
    rotation_key_id: &str,
    rotation_key: &[u8; 32],
    hash_secret: &[u8],
) -> Result<AuthSession, SlotClaimFailure> {
    if !validate_slot_ownership_state(db, user_id, role)
        .await
        .map_err(|_| SlotClaimFailure::Store)?
    {
        return Err(SlotClaimFailure::Store);
    }
    let max_slot = slot_max_for_role(role);
    let collection = db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION);
    let digest = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &refresh_secret,
        rotation_key,
    )
    .to_vec();
    let recovery_digest = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &recovery_secret,
        rotation_key,
    )
    .to_vec();
    let now_dt = DateTime::from_millis(now * 1000);
    for slot in 1..=max_slot {
        let sid = ObjectId::new();
        let session = AuthSession {
            session_id: sid,
            user_id,
            role: role.to_string(),
            session_version_at_issue,
            slot,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: device_id.to_string(),
            user_agent: user_agent.to_string(),
            ip_address: ip_address.to_string(),
            current_refresh_token_digest: digest.clone(),
            next_recovery_secret_digest: recovery_digest.clone(),
            rotation_derivation_version: "v1".into(),
            rotation_key_id: rotation_key_id.to_string(),
            immediate_predecessor: None,
            consumed_refresh_token_digests: vec![],
            refresh_generation: 0,
            status: SessionStatus::Active,
            created_at: now_dt,
            last_seen_at: now_dt,
            idle_expires_at: policy
                .idle_expires_at
                .map(|v| DateTime::from_millis(v * 1000)),
            absolute_expires_at: DateTime::from_millis(policy.absolute_expires_at * 1000),
            cleanup_at: DateTime::from_millis(policy.absolute_expires_at * 1000),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        match collection.insert_one(&session).await {
            Ok(_) => return Ok(session),
            Err(err) if slot_duplicate_key(&err) => continue,
            Err(_) => return Err(SlotClaimFailure::Store),
        }
    }
    Err(SlotClaimFailure::DeviceLimit)
}

pub async fn rollover_session_identity(
    db: &Database,
    user_id: ObjectId,
    old_session_id: ObjectId,
    replacement_session_id: ObjectId,
    role: &str,
    session_version_at_issue: i64,
    device_id: &str,
    user_agent: &str,
    ip_address: &str,
    policy: SessionPolicy,
    now: i64,
    refresh_secret: &[u8; 32],
    recovery_secret: &[u8; 32],
    rotation_key_id: &str,
    rotation_key: &[u8; 32],
    hash_secret: &[u8],
) -> Result<AuthSession, ()> {
    let now_dt = DateTime::from_millis(now * 1000);
    let digest = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        refresh_secret,
        rotation_key,
    )
    .to_vec();
    let recovery_digest = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        recovery_secret,
        rotation_key,
    )
    .to_vec();
    use mongodb::bson::Bson;
    let mut set_fields = mongodb::bson::Document::new();
    set_fields.insert("sessionId", replacement_session_id);
    set_fields.insert("replacedFromSessionId", old_session_id);
    set_fields.insert("ownsSlot", true);
    set_fields.insert("role", role);
    set_fields.insert("sessionVersionAtIssue", session_version_at_issue);
    set_fields.insert("deviceId", device_id);
    set_fields.insert("userAgent", user_agent);
    set_fields.insert("ipAddress", ip_address);
    set_fields.insert(
        "currentRefreshTokenDigest",
        Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: digest,
        }),
    );
    set_fields.insert(
        "nextRecoverySecretDigest",
        Bson::Binary(mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: recovery_digest,
        }),
    );
    set_fields.insert("rotationDerivationVersion", "v1");
    set_fields.insert("rotationKeyId", rotation_key_id);
    set_fields.insert("lastSeenAt", now_dt);
    if let Some(idle) = policy.idle_expires_at {
        set_fields.insert("idleExpiresAt", DateTime::from_millis(idle * 1000));
    }
    set_fields.insert(
        "absoluteExpiresAt",
        DateTime::from_millis(policy.absolute_expires_at * 1000),
    );
    set_fields.insert(
        "cleanupAt",
        DateTime::from_millis(policy.absolute_expires_at * 1000),
    );
    let mut update = mongodb::bson::Document::new();
    update.insert("$set", set_fields);
    update.insert("$inc", doc! { "refreshGeneration": 1_i64 });
    let result = db
        .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
        .update_one(
            doc! {
                "sessionId": old_session_id,
                "userId": user_id,
                "status": "active",
                "absoluteExpiresAt": { "$gt": now_dt }
            },
            update,
        )
        .await
        .map_err(|_| ())?;
    if result.modified_count == 0 {
        return db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! {
                "sessionId": replacement_session_id,
                "userId": user_id,
                "status": "active",
                "ownsSlot": true,
                "slot": { "$gte": 1, "$lte": slot_max_for_role(role) },
                "sessionVersionAtIssue": session_version_at_issue,
                "replacedFromSessionId": old_session_id,
            })
            .await
            .map_err(|_| ())?
            .ok_or(());
    }
    db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
        .find_one(doc! { "sessionId": replacement_session_id })
        .await
        .map_err(|_| ())?
        .ok_or(())
}

pub async fn mark_session_issuance_failed(
    db: &Database,
    session_id: ObjectId,
) -> mongodb::error::Result<()> {
    db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
        .update_one(
            doc! { "sessionId": session_id },
            doc! {
                "$set": {
                    "status": "revoked",
                    "revokeReason": "issuance_failed",
                    "revokedAt": DateTime::now(),
                    "ownsSlot": false,
                }
            },
        )
        .await?;
    Ok(())
}

pub fn sign_device_selection_token(
    claims: &DeviceSelectionClaims,
    jwt_secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
}

pub fn device_limit_value(token: String, sessions: &[AuthSession]) -> Value {
    json!({ "code": "AUTH_DEVICE_LIMIT_REACHED", "message": "Device limit reached", "challengeToken": token,
        "sessions": sessions.iter().map(sanitize_session).collect::<Vec<_>>() })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Active,
    Locked,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_id: ObjectId,
    pub user_id: ObjectId,
    pub role: String,
    pub session_version_at_issue: i64,
    pub slot: i32,
    #[serde(default)]
    pub owns_slot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_from_session_id: Option<ObjectId>,
    pub device_id: String,
    pub user_agent: String,
    pub ip_address: String,
    #[serde(with = "digest_bytes_bson")]
    pub current_refresh_token_digest: Vec<u8>,
    #[serde(default, with = "digest_bytes_bson")]
    pub next_recovery_secret_digest: Vec<u8>,
    #[serde(default = "default_rotation_version")]
    pub rotation_derivation_version: String,
    #[serde(default)]
    pub rotation_key_id: String,
    #[serde(default)]
    pub immediate_predecessor: Option<ImmediatePredecessor>,
    #[serde(default)]
    pub consumed_refresh_token_digests: Vec<ConsumedRefreshDigest>,
    pub refresh_generation: i64,
    pub status: SessionStatus,
    pub created_at: DateTime,
    pub last_seen_at: DateTime,
    pub idle_expires_at: Option<DateTime>,
    pub absolute_expires_at: DateTime,
    pub cleanup_at: DateTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_operation_marker: Option<Vec<u8>>,
    #[serde(default)]
    pub unlock_password_attempts: i32,
    #[serde(default)]
    pub unlock_otp_attempts: i32,
}

fn default_rotation_version() -> String {
    "v1".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImmediatePredecessor {
    pub generation: i64,
    #[serde(with = "digest_bytes_bson")]
    pub refresh_token_digest: Vec<u8>,
    #[serde(with = "digest_bytes_bson")]
    pub recovery_secret_digest: Vec<u8>,
    pub derivation_version: String,
    pub key_id: String,
    pub committed_at: DateTime,
    pub race_grace_until: DateTime,
    pub recovery_expires_at: DateTime,
    #[serde(default)]
    pub recovery_seed_ciphertext: Vec<u8>,
    #[serde(default)]
    pub recovery_seed_nonce: Vec<u8>,
    #[serde(default)]
    pub recovery_encryption_key_id: String,
    #[serde(default)]
    pub recovery_encryption_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedRefreshDigest {
    pub generation: i64,
    #[serde(with = "digest_bytes_bson")]
    pub refresh_token_digest: Vec<u8>,
    pub consumed_at: DateTime,
}

impl AuthSession {
    pub fn can_record_consumed_digest(&self) -> bool {
        self.consumed_refresh_token_digests.len() < MAX_CONSUMED_REFRESH_DIGESTS
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshCredentials {
    pub refresh: zeroize::Zeroizing<[u8; 32]>,
    pub recovery: zeroize::Zeroizing<[u8; 32]>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Rotated { credentials: RefreshCredentials },
    Recovered { credentials: RefreshCredentials },
    ConcurrentPredecessor,
    RecoveryExpired,
    Reused,
    Invalid,
    Expired,
    Revoked,
    AccountDisabled,
    SessionVersionMismatch,
    IdleLocked,
    HistoryFull,
    RecoveryUnavailable,
    Store,
}
#[derive(Debug, Clone)]
pub struct RefreshContext {
    pub session: AuthSession,
    pub user_active: bool,
    pub current_user_session_version_at_issue: i64,
    pub current_role: String,
}
#[derive(Debug, Clone)]
pub struct RotationProposal {
    pub sid: ObjectId,
    pub expected_session_version_at_issue: i64,
    pub expected_generation: i64,
    pub expected_refresh_digest: [u8; 32],
    pub expected_recovery_digest: [u8; 32],
    pub successor_refresh_digest: [u8; 32],
    pub successor_recovery_digest: [u8; 32],
    pub successor_key_id: String,
    pub predecessor: ImmediatePredecessor,
    pub successor_generation: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CasInstallResult {
    Installed,
    Miss,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalRevokeResult {
    RevokedOne,
    ModifiedZero,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoutResult {
    RevokedNow,
    AlreadyTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityOutcome {
    Recorded {
        warning_at: DateTime,
        idle_expires_at: DateTime,
    },
    Throttled {
        warning_at: DateTime,
        idle_expires_at: DateTime,
    },
    IdleLocked,
    Expired,
    Revoked,
    Invalid,
    NotStaff,
    AccountDisabled,
    SessionVersionMismatch,
    Store,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatusSession {
    pub session_id: ObjectId,
    pub user_id: ObjectId,
    pub role: String,
    pub session_version_at_issue: i64,
    pub status: SessionStatus,
    pub absolute_expires_at: DateTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_expires_at: Option<DateTime>,
}

pub fn activity_status_session_projection() -> Document {
    doc! {
        "_id": 0,
        "sessionId": 1,
        "userId": 1,
        "role": 1,
        "sessionVersionAtIssue": 1,
        "status": 1,
        "absoluteExpiresAt": 1,
        "idleExpiresAt": 1,
    }
}

pub fn activity_status_user_projection() -> Document {
    doc! {
        "_id": 1,
        "active": 1,
        "sessionVersion": 1,
        "role": 1,
    }
}

/// Authoritative user fields required for staff idle status eligibility (projection allow-list).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityStatusUser {
    pub user_id: ObjectId,
    pub active: bool,
    pub session_version: i64,
    pub role: String,
}

/// Fail closed on missing or wrong BSON types for required authoritative user fields.
pub fn decode_activity_status_user(user: &Document) -> Result<ActivityStatusUser, ()> {
    let user_id = user.get_object_id("_id").map_err(|_| ())?;
    let active = user.get_bool("active").map_err(|_| ())?;
    let session_version = match user.get("sessionVersion") {
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        _ => return Err(()),
    };
    let role = user.get_str("role").map_err(|_| ())?.to_string();
    Ok(ActivityStatusUser {
        user_id,
        active,
        session_version,
        role,
    })
}

#[derive(Debug, Clone)]
pub struct ActivityStatusContext {
    pub session: ActivityStatusSession,
    pub user_active: bool,
    pub current_user_session_version_at_issue: i64,
    pub current_role: String,
}

pub trait ActivityStatusStore {
    async fn load_activity_status_context(
        &self,
        sid: ObjectId,
    ) -> Result<Option<ActivityStatusContext>, ()>;
}

pub trait ActivityStore {
    async fn load_activity_session(&self, sid: ObjectId) -> Result<Option<AuthSession>, ()>;
    async fn compare_and_record_activity(
        &self,
        sid: ObjectId,
        previous: DateTime,
        now: DateTime,
        idle_expires_at: DateTime,
    ) -> Result<bool, ()>;
    async fn compare_and_lock_idle(&self, sid: ObjectId, now: DateTime) -> Result<bool, ()>;
}

fn staff_role(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "cs" | "staff")
}

pub async fn orchestrate_staff_activity_status<S: ActivityStatusStore>(
    store: &S,
    sid: ObjectId,
    trusted_user_id: ObjectId,
    now: DateTime,
) -> ActivityOutcome {
    let Some(ctx) = (match store.load_activity_status_context(sid).await {
        Ok(value) => value,
        Err(_) => return ActivityOutcome::Store,
    }) else {
        return ActivityOutcome::Invalid;
    };
    let session = &ctx.session;
    if session.session_id != sid || session.user_id != trusted_user_id {
        return ActivityOutcome::Invalid;
    }
    if !ctx.user_active {
        return ActivityOutcome::AccountDisabled;
    }
    if session.session_version_at_issue != ctx.current_user_session_version_at_issue
        || session.role != ctx.current_role
    {
        return ActivityOutcome::SessionVersionMismatch;
    }
    if session.absolute_expires_at <= now || session.status == SessionStatus::Expired {
        return ActivityOutcome::Expired;
    }
    if session.status == SessionStatus::Revoked {
        return ActivityOutcome::Revoked;
    }
    if session.status == SessionStatus::Locked {
        return ActivityOutcome::IdleLocked;
    }
    if session.status != SessionStatus::Active {
        return ActivityOutcome::Invalid;
    }
    if session.idle_expires_at.is_some_and(|expiry| expiry <= now) {
        return ActivityOutcome::IdleLocked;
    }
    if !staff_role(&session.role) {
        return ActivityOutcome::NotStaff;
    }
    persisted_activity_deadlines_from_idle(session.idle_expires_at)
}

pub async fn orchestrate_staff_activity<S: ActivityStore>(
    store: &S,
    sid: ObjectId,
    now: DateTime,
) -> ActivityOutcome {
    let Some(session) = (match store.load_activity_session(sid).await {
        Ok(value) => value,
        Err(_) => return ActivityOutcome::Store,
    }) else {
        return ActivityOutcome::Invalid;
    };
    if !staff_role(&session.role) {
        return ActivityOutcome::NotStaff;
    }
    if session.absolute_expires_at <= now || session.status == SessionStatus::Expired {
        return ActivityOutcome::Expired;
    }
    if session.status == SessionStatus::Locked {
        return ActivityOutcome::IdleLocked;
    }
    if session.status != SessionStatus::Active {
        return ActivityOutcome::Invalid;
    }
    if session.idle_expires_at.is_some_and(|expiry| expiry <= now) {
        return match store.compare_and_lock_idle(sid, now).await {
            Ok(true) => {
                super::security_audit::metric_idle_outcome("locked");
                ActivityOutcome::IdleLocked
            }
            Ok(false) => ActivityOutcome::IdleLocked,
            Err(_) => ActivityOutcome::Store,
        };
    }
    let previous = session.last_seen_at;
    if now.timestamp_millis() - previous.timestamp_millis() < 60_000 {
        return persisted_activity_deadlines(&session);
    }
    let idle_expires_at = DateTime::from_millis(now.timestamp_millis() + STAFF_IDLE_SECONDS * 1000);
    let warning_at = DateTime::from_millis(now.timestamp_millis() + STAFF_WARNING_SECONDS * 1000);
    match store
        .compare_and_record_activity(sid, previous, now, idle_expires_at)
        .await
    {
        Ok(true) => ActivityOutcome::Recorded {
            warning_at,
            idle_expires_at,
        },
        Ok(false) => match store.load_activity_session(sid).await {
            Ok(Some(authoritative)) => authoritative_activity_outcome(&authoritative, now),
            Ok(None) => ActivityOutcome::Invalid,
            Err(_) => ActivityOutcome::Store,
        },
        Err(_) => ActivityOutcome::Store,
    }
}

fn persisted_activity_deadlines(session: &AuthSession) -> ActivityOutcome {
    persisted_activity_deadlines_from_idle(session.idle_expires_at)
}

fn persisted_activity_deadlines_from_idle(idle_expires_at: Option<DateTime>) -> ActivityOutcome {
    match idle_expires_at {
        Some(idle_expires_at) => ActivityOutcome::Throttled {
            warning_at: DateTime::from_millis(
                idle_expires_at.timestamp_millis()
                    - (STAFF_IDLE_SECONDS - STAFF_WARNING_SECONDS) * 1000,
            ),
            idle_expires_at,
        },
        None => ActivityOutcome::Invalid,
    }
}

fn authoritative_activity_outcome(session: &AuthSession, now: DateTime) -> ActivityOutcome {
    if !staff_role(&session.role) {
        return ActivityOutcome::NotStaff;
    }
    if session.absolute_expires_at <= now || session.status == SessionStatus::Expired {
        return ActivityOutcome::Expired;
    }
    if session.status == SessionStatus::Locked
        || session.idle_expires_at.is_some_and(|expiry| expiry <= now)
    {
        return ActivityOutcome::IdleLocked;
    }
    if session.status != SessionStatus::Active {
        return ActivityOutcome::Invalid;
    }
    persisted_activity_deadlines(session)
}

#[derive(Debug, Clone)]
pub struct UnlockContext {
    pub refresh: RefreshContext,
    pub password_hash: String,
    pub two_factor_enabled: bool,
    pub two_factor_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockOutcome {
    Unlocked { credentials: RefreshCredentials },
    Recovered { credentials: RefreshCredentials },
    ReauthPasswordInvalid,
    ReauthOtpInvalid,
    ReauthAttemptsExhausted,
    ConcurrentPredecessor,
    RecoveryExpired,
    Reused,
    Invalid,
    Expired,
    Revoked,
    AccountDisabled,
    SessionVersionMismatch,
    NotStaff,
    NotLockEligible,
    HistoryFull,
    RecoveryUnavailable,
    Store,
}

#[derive(Debug, Clone)]
pub struct UnlockProposal {
    pub rotation: RotationProposal,
    pub idle_expires_at: DateTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockAttemptResult {
    Consumed(i32),
    Exhausted,
    Miss,
}

pub trait UnlockStore: RefreshStore {
    async fn load_unlock_context(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
    ) -> Result<Option<UnlockContext>, ()>;
    async fn compare_and_unlock_with_successors(
        &self,
        proposal: &UnlockProposal,
    ) -> Result<CasInstallResult, ()>;
    async fn record_unlock_password_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<UnlockAttemptResult, ()>;
    async fn record_unlock_otp_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<UnlockAttemptResult, ()>;
    async fn write_unlock_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        success: bool,
        now: DateTime,
    );
}

pub trait RefreshStore {
    async fn load_authoritative(&self, sid: ObjectId) -> Result<Option<RefreshContext>, ()>;
    async fn compare_and_install_successors(
        &self,
        proposal: &RotationProposal,
    ) -> Result<CasInstallResult, ()>;
    async fn conditional_revoke_for_reuse(
        &self,
        sid: ObjectId,
        generation: i64,
        now: DateTime,
    ) -> Result<ConditionalRevokeResult, ()>;
    async fn write_reuse_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        revoked: bool,
        now: DateTime,
    );
    async fn logout(&self, sid: ObjectId, now: DateTime) -> Result<LogoutResult, ()>;
}
fn digest_vec_equal(left: &[u8], right: &[u8; 32]) -> bool {
    left.len() == 32 && subtle::ConstantTimeEq::ct_eq(left, right.as_slice()).into()
}
pub(crate) fn authoritative(c: &RefreshContext, now: DateTime) -> Option<RefreshOutcome> {
    let s = &c.session;
    if !c.user_active {
        Some(RefreshOutcome::AccountDisabled)
    } else if s.session_version_at_issue != c.current_user_session_version_at_issue {
        Some(RefreshOutcome::SessionVersionMismatch)
    } else if s.status == SessionStatus::Revoked {
        Some(RefreshOutcome::Revoked)
    } else if s.status == SessionStatus::Expired || s.absolute_expires_at <= now {
        Some(RefreshOutcome::Expired)
    } else if s.status == SessionStatus::Locked || s.idle_expires_at.is_some_and(|v| v <= now) {
        Some(RefreshOutcome::IdleLocked)
    } else if !s.can_record_consumed_digest() {
        Some(RefreshOutcome::HistoryFull)
    } else {
        None
    }
}

pub(crate) fn access_ttl_seconds(role: &str) -> i64 {
    if matches!(role, "owner" | "admin" | "cs" | "staff") {
        300
    } else {
        900
    }
}

fn verify_derived_successor_digests(
    derived: &super::session_tokens::DerivedSuccessors,
    rotation_key: &[u8; 32],
    expected_refresh: &[u8],
    expected_recovery: &[u8],
) -> bool {
    let rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &derived.refresh,
        rotation_key,
    );
    let kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &derived.recovery,
        rotation_key,
    );
    digest_vec_equal(expected_refresh, &rd) && digest_vec_equal(expected_recovery, &kd)
}

pub async fn orchestrate_refresh<S: RefreshStore>(
    store: &S,
    sid: ObjectId,
    refresh: [u8; 32],
    recovery: [u8; 32],
    keys: &crate::state::RotationKeyRing,
    encryption_keys: &crate::state::RecoveryEncryptionKeyRing,
    now: DateTime,
) -> RefreshOutcome {
    let outcome =
        orchestrate_refresh_inner(store, sid, refresh, recovery, keys, encryption_keys, now).await;
    super::security_audit::metric_refresh_outcome(
        super::security_audit::refresh_outcome_metric_label(&outcome),
    );
    outcome
}

async fn orchestrate_refresh_inner<S: RefreshStore>(
    store: &S,
    sid: ObjectId,
    refresh: [u8; 32],
    recovery: [u8; 32],
    keys: &crate::state::RotationKeyRing,
    encryption_keys: &crate::state::RecoveryEncryptionKeyRing,
    now: DateTime,
) -> RefreshOutcome {
    let Some(c) = (match store.load_authoritative(sid).await {
        Ok(v) => v,
        Err(_) => return RefreshOutcome::Store,
    }) else {
        return RefreshOutcome::Invalid;
    };
    if let Some(o) = authoritative(&c, now) {
        return o;
    }
    let s = &c.session;
    let Some(stored_key) = keys.get(&s.rotation_key_id) else {
        return RefreshOutcome::RecoveryUnavailable;
    };
    let (active_key_id, active_key) = keys.active();
    let rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &refresh,
        stored_key,
    );
    let kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &recovery,
        stored_key,
    );
    if digest_vec_equal(&s.current_refresh_token_digest, &rd)
        && digest_vec_equal(&s.next_recovery_secret_digest, &kd)
    {
        let Some(next_generation) = s.refresh_generation.checked_add(1) else {
            return RefreshOutcome::HistoryFull;
        };
        let Ok(derived) = super::session_tokens::derive_rotation_successors(
            stored_key,
            sid,
            next_generation as u64,
            &recovery,
        ) else {
            return RefreshOutcome::Store;
        };
        let next_rd = super::session_tokens::digest_rotation_secret(
            super::session_tokens::RotationDigestDomain::Refresh,
            &derived.refresh,
            active_key,
        );
        let next_kd = super::session_tokens::digest_rotation_secret(
            super::session_tokens::RotationDigestDomain::Recovery,
            &derived.recovery,
            active_key,
        );
        let recovery_end = DateTime::from_millis(
            (now.timestamp_millis() + 60_000).min(s.absolute_expires_at.timestamp_millis()),
        );
        let (enc_key_id, enc_key) = encryption_keys.active();
        let aad = super::recovery_aead::build_recovery_aad(
            sid,
            s.refresh_generation as u64,
            next_generation as u64,
            &s.rotation_derivation_version,
            &s.rotation_key_id,
            recovery_end,
        );
        let encrypted =
            match super::recovery_aead::encrypt_recovery_seed(enc_key, enc_key_id, &recovery, &aad)
            {
                Ok(v) => v,
                Err(_) => return RefreshOutcome::Store,
            };
        let p = RotationProposal {
            sid,
            expected_session_version_at_issue: s.session_version_at_issue,
            expected_generation: s.refresh_generation,
            expected_refresh_digest: rd,
            expected_recovery_digest: kd,
            successor_refresh_digest: next_rd,
            successor_recovery_digest: next_kd,
            successor_key_id: active_key_id.into(),
            predecessor: ImmediatePredecessor {
                generation: s.refresh_generation,
                refresh_token_digest: rd.to_vec(),
                recovery_secret_digest: kd.to_vec(),
                derivation_version: s.rotation_derivation_version.clone(),
                key_id: s.rotation_key_id.clone(),
                committed_at: now,
                race_grace_until: DateTime::from_millis(now.timestamp_millis() + 5_000),
                recovery_expires_at: recovery_end,
                recovery_seed_ciphertext: encrypted.ciphertext,
                recovery_seed_nonce: encrypted.nonce.to_vec(),
                recovery_encryption_key_id: encrypted.key_id,
                recovery_encryption_version: encrypted.version,
            },
            successor_generation: next_generation,
        };
        return match store.compare_and_install_successors(&p).await {
            Ok(CasInstallResult::Installed) => {
                let Some(reloaded) = (match store.load_authoritative(sid).await {
                    Ok(value) => value,
                    Err(_) => return RefreshOutcome::Store,
                }) else {
                    return RefreshOutcome::Invalid;
                };
                if let Some(outcome) = authoritative(&reloaded, now) {
                    return outcome;
                }
                RefreshOutcome::Rotated {
                    credentials: RefreshCredentials {
                        refresh: derived.refresh,
                        recovery: derived.recovery,
                    },
                }
            }
            Ok(CasInstallResult::Miss) => {
                classify_pair(store, sid, refresh, recovery, keys, encryption_keys, now).await
            }
            Err(_) => RefreshOutcome::Store,
        };
    }
    classify_pair(store, sid, refresh, recovery, keys, encryption_keys, now).await
}

pub(crate) fn derive_recovery_successors(
    key: &[u8; 32],
    sid: ObjectId,
    successor_generation: u64,
    old_recovery: &super::recovery_aead::ZeroizingSeed,
) -> Result<super::session_tokens::DerivedSuccessors, super::session_tokens::RotationTokenError> {
    super::session_tokens::derive_rotation_successors(
        key,
        sid,
        successor_generation,
        old_recovery.as_bytes(),
    )
}

async fn recover_from_old_seed<S: RefreshStore>(
    store: &S,
    c: &RefreshContext,
    sid: ObjectId,
    old_recovery: &[u8; 32],
    p: &ImmediatePredecessor,
    keys: &crate::state::RotationKeyRing,
    now: DateTime,
) -> RefreshOutcome {
    let s = &c.session;
    let Some(key) = keys.get(&p.key_id) else {
        return RefreshOutcome::RecoveryUnavailable;
    };
    let successor_gen = (p.generation + 1) as u64;
    let Ok(derived) =
        super::session_tokens::derive_rotation_successors(key, sid, successor_gen, old_recovery)
    else {
        return RefreshOutcome::Store;
    };
    let Some(successor_key) = keys.get(&s.rotation_key_id) else {
        return RefreshOutcome::RecoveryUnavailable;
    };
    if !verify_derived_successor_digests(
        &derived,
        successor_key,
        &s.current_refresh_token_digest,
        &s.next_recovery_secret_digest,
    ) {
        return RefreshOutcome::RecoveryUnavailable;
    }
    let Some(reloaded) = (match store.load_authoritative(sid).await {
        Ok(v) => v,
        Err(_) => return RefreshOutcome::Store,
    }) else {
        return RefreshOutcome::Invalid;
    };
    if let Some(o) = authoritative(&reloaded, now) {
        return o;
    }
    RefreshOutcome::Recovered {
        credentials: RefreshCredentials {
            refresh: derived.refresh,
            recovery: derived.recovery,
        },
    }
}

async fn classify_pair<S: RefreshStore>(
    store: &S,
    sid: ObjectId,
    refresh: [u8; 32],
    recovery: [u8; 32],
    keys: &crate::state::RotationKeyRing,
    encryption_keys: &crate::state::RecoveryEncryptionKeyRing,
    now: DateTime,
) -> RefreshOutcome {
    let Some(c) = (match store.load_authoritative(sid).await {
        Ok(v) => v,
        Err(_) => return RefreshOutcome::Store,
    }) else {
        return RefreshOutcome::Invalid;
    };
    if let Some(o) = authoritative(&c, now) {
        return o;
    }
    let s = &c.session;
    let Some(p) = &s.immediate_predecessor else {
        return RefreshOutcome::Invalid;
    };
    let Some(predecessor_key) = keys.get(&p.key_id) else {
        return RefreshOutcome::RecoveryUnavailable;
    };
    let Some(current_key) = keys.get(&s.rotation_key_id) else {
        return RefreshOutcome::RecoveryUnavailable;
    };
    let predecessor_rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &refresh,
        predecessor_key,
    );
    let predecessor_kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &recovery,
        predecessor_key,
    );
    let current_rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &refresh,
        current_key,
    );
    let current_kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &recovery,
        current_key,
    );
    let old_r = digest_vec_equal(&p.refresh_token_digest, &predecessor_rd);
    let old_k = digest_vec_equal(&p.recovery_secret_digest, &predecessor_kd);
    let cur_r = digest_vec_equal(&s.current_refresh_token_digest, &current_rd);
    let new_k = digest_vec_equal(&s.next_recovery_secret_digest, &current_kd);
    if (old_r && old_k) || (cur_r && old_k) {
        if now > p.recovery_expires_at {
            return RefreshOutcome::RecoveryExpired;
        }
        return recover_from_old_seed(store, &c, sid, &recovery, p, keys, now).await;
    }
    if old_r && new_k {
        if now > p.recovery_expires_at {
            return RefreshOutcome::RecoveryExpired;
        }
        if p.recovery_seed_nonce.len() != 24
            || p.recovery_encryption_version.is_empty()
            || p.recovery_seed_ciphertext.is_empty()
        {
            return RefreshOutcome::RecoveryUnavailable;
        }
        let Some(enc_key) = encryption_keys.get(&p.recovery_encryption_key_id) else {
            return RefreshOutcome::RecoveryUnavailable;
        };
        let mut nonce = [0_u8; 24];
        nonce.copy_from_slice(&p.recovery_seed_nonce);
        let aad = super::recovery_aead::build_recovery_aad(
            sid,
            p.generation as u64,
            (p.generation + 1) as u64,
            &p.derivation_version,
            &p.key_id,
            p.recovery_expires_at,
        );
        let decrypted = match super::recovery_aead::decrypt_recovery_seed(
            enc_key,
            &p.recovery_encryption_version,
            &nonce,
            &p.recovery_seed_ciphertext,
            &aad,
        ) {
            Ok(v) => v,
            Err(_) => return RefreshOutcome::RecoveryUnavailable,
        };
        return recover_from_old_seed(store, &c, sid, decrypted.as_bytes(), p, keys, now).await;
    }
    if old_r {
        if now <= p.race_grace_until {
            return RefreshOutcome::ConcurrentPredecessor;
        }
        return revoke_reuse(store, s, now).await;
    }
    if s.consumed_refresh_token_digests
        .iter()
        .any(|v| digest_vec_equal(&v.refresh_token_digest, &predecessor_rd))
    {
        return revoke_reuse(store, s, now).await;
    }
    RefreshOutcome::Invalid
}
async fn revoke_reuse<S: RefreshStore>(
    store: &S,
    s: &AuthSession,
    now: DateTime,
) -> RefreshOutcome {
    match store
        .conditional_revoke_for_reuse(s.session_id, s.refresh_generation, now)
        .await
    {
        Ok(ConditionalRevokeResult::RevokedOne) => {
            store
                .write_reuse_audit(s.session_id, s.user_id, true, now)
                .await;
            RefreshOutcome::Reused
        }
        Ok(ConditionalRevokeResult::ModifiedZero) => {
            store
                .write_reuse_audit(s.session_id, s.user_id, false, now)
                .await;
            match store.load_authoritative(s.session_id).await {
                Ok(Some(c)) => authoritative(&c, now).unwrap_or(RefreshOutcome::Reused),
                Ok(None) => RefreshOutcome::Invalid,
                Err(_) => RefreshOutcome::Store,
            }
        }
        Err(_) => RefreshOutcome::Store,
    }
}
fn lock_eligible(session: &AuthSession, now: DateTime) -> bool {
    session.status == SessionStatus::Locked
        || (session.status == SessionStatus::Active
            && session.idle_expires_at.is_some_and(|v| v <= now))
}

pub(crate) fn unlock_precedence(c: &UnlockContext, now: DateTime) -> Option<UnlockOutcome> {
    let s = &c.refresh.session;
    // Section 19.2 ordering is security-significant: establish lock eligibility,
    // then absolute expiry, before account/epoch/role coherence or credentials.
    if !lock_eligible(s, now) {
        Some(if s.status == SessionStatus::Revoked {
            UnlockOutcome::Revoked
        } else {
            UnlockOutcome::NotLockEligible
        })
    } else if s.absolute_expires_at <= now {
        Some(UnlockOutcome::Expired)
    } else if !c.refresh.user_active {
        Some(UnlockOutcome::AccountDisabled)
    } else if !staff_role(&s.role) || s.role != c.refresh.current_role {
        Some(UnlockOutcome::NotStaff)
    } else if s.session_version_at_issue != c.refresh.current_user_session_version_at_issue {
        Some(UnlockOutcome::SessionVersionMismatch)
    } else if !s.can_record_consumed_digest() {
        Some(UnlockOutcome::HistoryFull)
    } else {
        None
    }
}

pub async fn orchestrate_unlock<S: UnlockStore>(
    store: &S,
    sid: ObjectId,
    user_id: ObjectId,
    refresh: [u8; 32],
    recovery: [u8; 32],
    password: &str,
    otp_code: Option<&str>,
    keys: &crate::state::RotationKeyRing,
    encryption_keys: &crate::state::RecoveryEncryptionKeyRing,
    now: DateTime,
) -> UnlockOutcome {
    let Some(ctx) = (match store.load_unlock_context(sid, user_id).await {
        Ok(v) => v,
        Err(_) => return UnlockOutcome::Store,
    }) else {
        return UnlockOutcome::Invalid;
    };
    if let Some(outcome) = unlock_precedence(&ctx, now) {
        return outcome;
    }
    let s = &ctx.refresh.session;
    if s.user_id != user_id {
        return UnlockOutcome::Invalid;
    }
    // Authenticate the HttpOnly credential pair before bcrypt/TOTP or any failure-counter write.
    // Otherwise an attacker who only knows a locked staff SID can fabricate syntactically valid
    // cookie values and spend the victim's bounded unlock attempts without possessing the session.
    // Unlock accepts only the current pair; predecessor/recovery classification belongs to refresh,
    // which handles response-loss recovery without re-running password/OTP verification.
    let Some(stored_key) = keys.get(&s.rotation_key_id) else {
        return UnlockOutcome::RecoveryUnavailable;
    };
    let rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &refresh,
        stored_key,
    );
    let kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &recovery,
        stored_key,
    );
    if !digest_vec_equal(&s.current_refresh_token_digest, &rd)
        || !digest_vec_equal(&s.next_recovery_secret_digest, &kd)
    {
        return UnlockOutcome::Invalid;
    }
    if s.unlock_password_attempts >= MAX_UNLOCK_REAUTH_ATTEMPTS
        || s.unlock_otp_attempts >= MAX_UNLOCK_REAUTH_ATTEMPTS
    {
        return UnlockOutcome::ReauthAttemptsExhausted;
    }
    if !bcrypt::verify(password, &ctx.password_hash).unwrap_or(false) {
        let outcome = match store.record_unlock_password_failure(sid, now).await {
            Ok(UnlockAttemptResult::Consumed(count)) if count >= MAX_UNLOCK_REAUTH_ATTEMPTS => {
                UnlockOutcome::ReauthAttemptsExhausted
            }
            Ok(UnlockAttemptResult::Consumed(_)) => UnlockOutcome::ReauthPasswordInvalid,
            Ok(UnlockAttemptResult::Exhausted) => UnlockOutcome::ReauthAttemptsExhausted,
            Ok(UnlockAttemptResult::Miss) => match store.load_unlock_context(sid, user_id).await {
                Ok(Some(current)) => unlock_precedence(&current, now)
                    .unwrap_or(UnlockOutcome::ReauthAttemptsExhausted),
                Ok(None) => UnlockOutcome::Invalid,
                Err(_) => UnlockOutcome::Store,
            },
            Err(_) => UnlockOutcome::Store,
        };
        store.write_unlock_audit(sid, user_id, false, now).await;
        return outcome;
    }
    if ctx.two_factor_enabled {
        let code = super::totp::normalize_otp_code(otp_code);
        if code.is_empty() || !super::totp::is_valid_totp_code(&code, &ctx.two_factor_secret) {
            let outcome = match store.record_unlock_otp_failure(sid, now).await {
                Ok(UnlockAttemptResult::Consumed(count)) if count >= MAX_UNLOCK_REAUTH_ATTEMPTS => {
                    UnlockOutcome::ReauthAttemptsExhausted
                }
                Ok(UnlockAttemptResult::Consumed(_)) => UnlockOutcome::ReauthOtpInvalid,
                Ok(UnlockAttemptResult::Exhausted) => UnlockOutcome::ReauthAttemptsExhausted,
                Ok(UnlockAttemptResult::Miss) => {
                    match store.load_unlock_context(sid, user_id).await {
                        Ok(Some(current)) => unlock_precedence(&current, now)
                            .unwrap_or(UnlockOutcome::ReauthAttemptsExhausted),
                        Ok(None) => UnlockOutcome::Invalid,
                        Err(_) => UnlockOutcome::Store,
                    }
                }
                Err(_) => UnlockOutcome::Store,
            };
            store.write_unlock_audit(sid, user_id, false, now).await;
            return outcome;
        }
    }
    let (active_key_id, active_key) = keys.active();
    let Some(next_generation) = s.refresh_generation.checked_add(1) else {
        return UnlockOutcome::HistoryFull;
    };
    let Ok(derived) = super::session_tokens::derive_rotation_successors(
        stored_key,
        sid,
        next_generation as u64,
        &recovery,
    ) else {
        return UnlockOutcome::Store;
    };
    let next_rd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Refresh,
        &derived.refresh,
        active_key,
    );
    let next_kd = super::session_tokens::digest_rotation_secret(
        super::session_tokens::RotationDigestDomain::Recovery,
        &derived.recovery,
        active_key,
    );
    let recovery_end = DateTime::from_millis(
        (now.timestamp_millis() + 60_000).min(s.absolute_expires_at.timestamp_millis()),
    );
    let (enc_key_id, enc_key) = encryption_keys.active();
    let aad = super::recovery_aead::build_recovery_aad(
        sid,
        s.refresh_generation as u64,
        next_generation as u64,
        &s.rotation_derivation_version,
        &s.rotation_key_id,
        recovery_end,
    );
    let encrypted =
        match super::recovery_aead::encrypt_recovery_seed(enc_key, enc_key_id, &recovery, &aad) {
            Ok(v) => v,
            Err(_) => return UnlockOutcome::Store,
        };
    let idle_expires_at = DateTime::from_millis(now.timestamp_millis() + STAFF_IDLE_SECONDS * 1000);
    let proposal = UnlockProposal {
        rotation: RotationProposal {
            sid,
            expected_session_version_at_issue: s.session_version_at_issue,
            expected_generation: s.refresh_generation,
            expected_refresh_digest: rd,
            expected_recovery_digest: kd,
            successor_refresh_digest: next_rd,
            successor_recovery_digest: next_kd,
            successor_key_id: active_key_id.into(),
            predecessor: ImmediatePredecessor {
                generation: s.refresh_generation,
                refresh_token_digest: rd.to_vec(),
                recovery_secret_digest: kd.to_vec(),
                derivation_version: s.rotation_derivation_version.clone(),
                key_id: s.rotation_key_id.clone(),
                committed_at: now,
                race_grace_until: DateTime::from_millis(now.timestamp_millis() + 5_000),
                recovery_expires_at: recovery_end,
                recovery_seed_ciphertext: encrypted.ciphertext,
                recovery_seed_nonce: encrypted.nonce.to_vec(),
                recovery_encryption_key_id: encrypted.key_id,
                recovery_encryption_version: encrypted.version,
            },
            successor_generation: next_generation,
        },
        idle_expires_at,
    };
    match store.compare_and_unlock_with_successors(&proposal).await {
        Ok(CasInstallResult::Installed) => {
            store.write_unlock_audit(sid, user_id, true, now).await;
            let Some(reloaded) = (match store.load_unlock_context(sid, user_id).await {
                Ok(v) => v,
                Err(_) => return UnlockOutcome::Store,
            }) else {
                return UnlockOutcome::Invalid;
            };
            // The atomic CAS intentionally made the session active, so the pre-CAS
            // lock-eligibility predicate must not be reused here. Revalidate only
            // authoritative account/session/role state before credentials are signed.
            if let Some(outcome) = authoritative(&reloaded.refresh, now) {
                return map_refresh_to_unlock(outcome);
            }
            if !staff_role(&reloaded.refresh.session.role)
                || reloaded.refresh.session.role != reloaded.refresh.current_role
            {
                return UnlockOutcome::NotStaff;
            }
            UnlockOutcome::Unlocked {
                credentials: RefreshCredentials {
                    refresh: derived.refresh,
                    recovery: derived.recovery,
                },
            }
        }
        Ok(CasInstallResult::Miss) => map_refresh_to_unlock(
            classify_pair(store, sid, refresh, recovery, keys, encryption_keys, now).await,
        ),
        Err(_) => UnlockOutcome::Store,
    }
}

fn map_refresh_to_unlock(outcome: RefreshOutcome) -> UnlockOutcome {
    match outcome {
        RefreshOutcome::Rotated { credentials } => UnlockOutcome::Unlocked { credentials },
        RefreshOutcome::Recovered { credentials } => UnlockOutcome::Recovered { credentials },
        RefreshOutcome::ConcurrentPredecessor => UnlockOutcome::ConcurrentPredecessor,
        RefreshOutcome::RecoveryExpired => UnlockOutcome::RecoveryExpired,
        RefreshOutcome::Reused => UnlockOutcome::Reused,
        RefreshOutcome::Invalid => UnlockOutcome::Invalid,
        RefreshOutcome::Expired => UnlockOutcome::Expired,
        RefreshOutcome::Revoked => UnlockOutcome::Revoked,
        RefreshOutcome::AccountDisabled => UnlockOutcome::AccountDisabled,
        RefreshOutcome::SessionVersionMismatch => UnlockOutcome::SessionVersionMismatch,
        RefreshOutcome::IdleLocked => UnlockOutcome::NotLockEligible,
        RefreshOutcome::HistoryFull => UnlockOutcome::HistoryFull,
        RefreshOutcome::RecoveryUnavailable => UnlockOutcome::RecoveryUnavailable,
        RefreshOutcome::Store => UnlockOutcome::Store,
    }
}

pub async fn orchestrate_logout<S: RefreshStore>(
    store: &S,
    sid: ObjectId,
    now: DateTime,
) -> Result<LogoutResult, ()> {
    store.logout(sid, now).await
}

fn auth_session_indexes() -> Vec<IndexModel> {
    vec![
        IndexModel::builder()
            .keys(doc! { "sessionId": 1 })
            .options(
                IndexOptions::builder()
                    .name(AUTH_SESSION_ID_INDEX.to_string())
                    .unique(true)
                    .build(),
            )
            .build(),
        IndexModel::builder()
            .keys(doc! { "userId": 1, "status": 1, "absoluteExpiresAt": 1 })
            .build(),
        IndexModel::builder()
            .keys(doc! { "userId": 1, "createdAt": 1 })
            .build(),
        IndexModel::builder()
            .keys(doc! { "cleanupAt": 1 })
            .options(
                IndexOptions::builder()
                    .expire_after(std::time::Duration::ZERO)
                    .build(),
            )
            .build(),
        IndexModel::builder()
            .keys(doc! { "userId": 1, "slot": 1 })
            .options(
                IndexOptions::builder()
                    .name(AUTH_SESSION_SLOT_INDEX.to_string())
                    .unique(true)
                    .partial_filter_expression(doc! { "ownsSlot": true })
                    .build(),
            )
            .build(),
    ]
}

fn device_challenge_indexes() -> Vec<IndexModel> {
    vec![
        IndexModel::builder()
            .keys(doc! { "nonce": 1 })
            .options(IndexOptions::builder().unique(true).build())
            .build(),
        IndexModel::builder()
            .keys(doc! { "userId": 1, "status": 1, "expiresAt": 1 })
            .build(),
    ]
}

pub async fn ensure_auth_session_indexes(db: &Database) -> mongodb::error::Result<()> {
    db.collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
        .create_indexes(auth_session_indexes())
        .await?;
    Ok(())
}

pub async fn ensure_device_challenge_indexes(db: &Database) -> mongodb::error::Result<()> {
    db.collection::<ChallengeRecord>(DEVICE_CHALLENGES_COLLECTION)
        .create_indexes(device_challenge_indexes())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_digest_bytes_serialize_as_binary_and_read_legacy_arrays() {
        #[derive(Debug, Serialize, Deserialize, PartialEq)]
        struct Fixture {
            #[serde(with = "digest_bytes_bson")]
            digest: Vec<u8>,
        }
        let expected = Fixture {
            digest: vec![1, 2, 3, 4],
        };
        let encoded = mongodb::bson::to_bson(&expected).expect("serialize digest fixture");
        assert_eq!(
            encoded,
            mongodb::bson::Bson::Document(doc! {
                "digest": mongodb::bson::Binary {
                    subtype: mongodb::bson::spec::BinarySubtype::Generic,
                    bytes: vec![1, 2, 3, 4],
                }
            })
        );
        let legacy = mongodb::bson::Bson::Document(doc! { "digest": [1_i32, 2_i32, 3_i32, 4_i32] });
        assert_eq!(
            mongodb::bson::from_bson::<Fixture>(legacy).expect("read legacy array"),
            expected
        );
        assert_eq!(
            mongodb::bson::from_bson::<Fixture>(encoded).expect("read binary"),
            expected
        );
    }

    #[test]
    fn auth_session_and_nested_rotation_digests_use_binary_bson() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let digest = vec![7_u8; 32];
        let session = AuthSession {
            session_id: ObjectId::new(),
            user_id: ObjectId::new(),
            role: "cs".into(),
            session_version_at_issue: 0,
            slot: 1,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "test".into(),
            user_agent: "test".into(),
            ip_address: "127.0.0.1".into(),
            current_refresh_token_digest: digest.clone(),
            next_recovery_secret_digest: digest.clone(),
            rotation_derivation_version: "v1".into(),
            rotation_key_id: "key".into(),
            immediate_predecessor: Some(ImmediatePredecessor {
                generation: 0,
                refresh_token_digest: digest.clone(),
                recovery_secret_digest: digest.clone(),
                derivation_version: "v1".into(),
                key_id: "key".into(),
                committed_at: now,
                race_grace_until: now,
                recovery_expires_at: now,
                recovery_seed_ciphertext: vec![],
                recovery_seed_nonce: vec![],
                recovery_encryption_key_id: "key".into(),
                recovery_encryption_version: "v1".into(),
            }),
            consumed_refresh_token_digests: vec![ConsumedRefreshDigest {
                generation: 0,
                refresh_token_digest: digest,
                consumed_at: now,
            }],
            refresh_generation: 1,
            status: SessionStatus::Active,
            created_at: now,
            last_seen_at: now,
            idle_expires_at: Some(now),
            absolute_expires_at: now,
            cleanup_at: now,
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        let document = mongodb::bson::to_document(&session).expect("serialize auth session");
        assert!(matches!(
            document.get("currentRefreshTokenDigest"),
            Some(mongodb::bson::Bson::Binary(_))
        ));
        assert!(matches!(
            document.get("nextRecoverySecretDigest"),
            Some(mongodb::bson::Bson::Binary(_))
        ));
        let predecessor = document
            .get_document("immediatePredecessor")
            .expect("predecessor");
        assert!(matches!(
            predecessor.get("refreshTokenDigest"),
            Some(mongodb::bson::Bson::Binary(_))
        ));
        assert!(matches!(
            predecessor.get("recoverySecretDigest"),
            Some(mongodb::bson::Bson::Binary(_))
        ));
        let consumed = document
            .get_array("consumedRefreshTokenDigests")
            .expect("history")[0]
            .as_document()
            .expect("history row");
        assert!(matches!(
            consumed.get("refreshTokenDigest"),
            Some(mongodb::bson::Bson::Binary(_))
        ));
    }

    #[test]
    fn session_indexes_match_lookup_ttl_and_slot_contract() {
        let indexes = auth_session_indexes();
        assert_eq!(indexes.len(), 5);
        assert_eq!(indexes[0].keys, doc! { "sessionId": 1 });
        assert_eq!(indexes[4].keys, doc! { "userId": 1, "slot": 1 });
        assert_eq!(
            indexes[4].options.as_ref().and_then(|o| o.unique),
            Some(true)
        );
    }

    #[test]
    fn device_challenge_indexes_nonce_unique() {
        let indexes = device_challenge_indexes();
        assert_eq!(indexes[0].keys, doc! { "nonce": 1 });
        assert_eq!(
            indexes[0].options.as_ref().and_then(|o| o.unique),
            Some(true)
        );
    }

    #[test]
    fn auth_session_issuance_enforces_role_device_limits() {
        assert_eq!(active_session_limit("member"), 5);
        assert_eq!(active_session_limit("admin"), 2);
        assert_eq!(active_session_limit("owner"), 2);
        assert_eq!(active_session_limit("cs"), 2);
    }

    #[test]
    fn auth_device_limit_challenge_is_user_bound_one_time_and_five_minutes() {
        let user_id = ObjectId::new();
        let claims = new_device_selection_claims(user_id, "nonce", 1_000, LoginAudience::Member);
        assert_eq!(claims.purpose, "device-selection");
        assert_eq!(claims.sub, user_id.to_hex());
        assert_eq!(claims.nonce, "nonce");
        assert_eq!(claims.exp, 1_300);
    }

    #[test]
    fn auth_device_limit_sanitizes_session_fields() {
        let session = AuthSession {
            session_id: ObjectId::new(),
            user_id: ObjectId::new(),
            role: "member".into(),
            session_version_at_issue: 0,
            slot: 1,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "Laptop".into(),
            user_agent: "Browser secret detail".into(),
            ip_address: "192.168.1.42".into(),
            current_refresh_token_digest: vec![9; 32],
            consumed_refresh_token_digests: vec![],
            refresh_generation: 0,
            next_recovery_secret_digest: vec![],
            rotation_derivation_version: "v1".into(),
            rotation_key_id: String::new(),
            immediate_predecessor: None,
            status: SessionStatus::Active,
            created_at: DateTime::from_millis(1_000),
            last_seen_at: DateTime::from_millis(2_000),
            idle_expires_at: None,
            absolute_expires_at: DateTime::from_millis(3_000),
            cleanup_at: DateTime::from_millis(4_000),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        let value = serde_json::to_value(sanitize_session(&session)).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert!(value.get("currentRefreshTokenDigest").is_none());
        assert_eq!(value["ipContext"], "192.168.x.x");
    }

    #[test]
    fn concurrent_boundary_slot_claims_never_exceed_member_five() {
        use std::sync::{Arc, Mutex};
        #[derive(Default)]
        struct Mem {
            sessions: Vec<AuthSession>,
        }
        impl Mem {
            fn active(&self, uid: ObjectId) -> usize {
                self.sessions
                    .iter()
                    .filter(|s| s.user_id == uid && s.status == SessionStatus::Active)
                    .count()
            }
            fn claim(
                &mut self,
                uid: ObjectId,
                role: &str,
                policy: SessionPolicy,
                now: i64,
                hash: &[u8],
            ) -> Result<(), SlotClaimFailure> {
                let max = slot_max_for_role(role);
                for slot in 1..=max {
                    if self.sessions.iter().any(|s| {
                        s.user_id == uid && s.status == SessionStatus::Active && s.slot == slot
                    }) {
                        continue;
                    }
                    let refresh = new_refresh_secret();
                    self.sessions.push(AuthSession {
                        session_id: ObjectId::new(),
                        user_id: uid,
                        role: role.into(),
                        session_version_at_issue: 0,
                        slot,
                        owns_slot: true,
                        replaced_from_session_id: None,
                        device_id: "d".into(),
                        user_agent: "ua".into(),
                        ip_address: "10.0.0.1".into(),
                        current_refresh_token_digest: digest_refresh_secret(&refresh, hash)
                            .to_vec(),
                        consumed_refresh_token_digests: vec![],
                        refresh_generation: 0,
                        next_recovery_secret_digest: vec![],
                        rotation_derivation_version: "v1".into(),
                        rotation_key_id: String::new(),
                        immediate_predecessor: None,
                        status: SessionStatus::Active,
                        created_at: DateTime::from_millis(now * 1000),
                        last_seen_at: DateTime::from_millis(now * 1000),
                        idle_expires_at: None,
                        absolute_expires_at: DateTime::from_millis(
                            policy.absolute_expires_at * 1000,
                        ),
                        cleanup_at: DateTime::from_millis(policy.absolute_expires_at * 1000),
                        migration_operation_marker: None,
                        unlock_password_attempts: 0,
                        unlock_otp_attempts: 0,
                    });
                    return Ok(());
                }
                Err(SlotClaimFailure::DeviceLimit)
            }
        }
        let hash = b"session-token-hash-test-secret-at-least-32-chars";
        let uid = ObjectId::new();
        let store = Arc::new(Mutex::new(Mem::default()));
        let policy = SessionPolicy::for_role("member", false, 10_000);
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    store
                        .lock()
                        .unwrap()
                        .claim(uid, "member", policy, 10_000, hash)
                })
            })
            .collect();
        let mut ok = 0;
        for h in handles {
            if h.join().unwrap().is_ok() {
                ok += 1;
            }
        }
        assert!(ok <= 5);
        assert_eq!(store.lock().unwrap().active(uid), ok);
    }

    #[test]
    fn derive_refresh_secret_is_deterministic_per_nonce_and_session() {
        let key = b"session-token-hash-test-secret-at-least-32-chars";
        let a = derive_refresh_secret_for_operation(key, "n1", "0123456789abcdef01234567");
        let b = derive_refresh_secret_for_operation(key, "n1", "0123456789abcdef01234567");
        assert_eq!(a, b);
    }

    #[test]
    fn pending_issuance_rolls_logical_identity_and_is_stable() {
        let old = ObjectId::new();
        let pending = PendingIssuance::new_for_test(old, 3, 7, 10_000);
        assert_ne!(pending.replacement_session_id, old);
        assert_eq!(pending.target_session_id, old);
        assert_eq!(pending.slot, 3);
        assert_eq!(pending.session_version_at_issue, 7);
        assert_eq!(pending, pending.clone());
    }

    #[test]
    fn slot_duplicate_structured_metadata() {
        use mongodb::error::{ErrorKind, WriteError, WriteFailure};

        let fixture = |code, details: Option<mongodb::bson::Document>| {
            let mut row = doc! { "code": code, "errmsg": "fixture" };
            if let Some(details) = details {
                row.insert("errInfo", details);
            }
            ErrorKind::Write(WriteFailure::WriteError(
                mongodb::bson::from_document::<WriteError>(row).unwrap(),
            ))
        };
        assert!(slot_duplicate_error_kind(&fixture(
            11000,
            Some(doc! { "indexName": AUTH_SESSION_SLOT_INDEX }),
        )));
        assert!(slot_duplicate_error_kind(&fixture(
            11000,
            Some(doc! { "keyPattern": { "userId": 1, "slot": 1 } }),
        )));
        assert!(!slot_duplicate_error_kind(&fixture(
            11000,
            Some(doc! { "indexName": AUTH_SESSION_ID_INDEX }),
        )));
        let fixture_message = |index_name: &str| {
            ErrorKind::Write(WriteFailure::WriteError(
                mongodb::bson::from_document::<WriteError>(doc! {
                    "code": 11000,
                    "errmsg": format!("duplicate key error index: {index_name} dup key"),
                })
                .unwrap(),
            ))
        };
        assert!(slot_duplicate_error_kind(&fixture_message(
            AUTH_SESSION_SLOT_INDEX
        )));
        assert!(!slot_duplicate_error_kind(&fixture_message(
            AUTH_SESSION_ID_INDEX
        )));
        assert!(!slot_duplicate_error_kind(&fixture(11000, None)));
        assert!(!slot_duplicate_error_kind(&fixture(
            121,
            Some(doc! { "indexName": AUTH_SESSION_SLOT_INDEX }),
        )));
    }

    #[test]
    fn slot_index_is_named_and_ownership_based() {
        let index = &auth_session_indexes()[4];
        let options = index.options.as_ref().unwrap();
        assert_eq!(options.name.as_deref(), Some(AUTH_SESSION_SLOT_INDEX));
        assert_eq!(
            options.partial_filter_expression,
            Some(doc! { "ownsSlot": true })
        );
    }

    #[test]
    fn deterministic_refresh_is_nonzero_and_replacement_bound() {
        let key = b"session-token-hash-test-secret-at-least-32-chars";
        let sid1 = ObjectId::new();
        let sid2 = ObjectId::new();
        let one = derive_refresh_secret_for_operation(key, "nonce", &sid1.to_hex());
        let two = derive_refresh_secret_for_operation(key, "nonce", &sid2.to_hex());
        assert_ne!(one, [0; 32]);
        assert_ne!(one, two);
    }

    #[test]
    fn challenge_classify_conflict_on_different_target() {
        let user = ObjectId::new();
        let t1 = ObjectId::new();
        let t2 = ObjectId::new();
        let record = ChallengeRecord {
            nonce: "n".into(),
            user_id: user,
            status: "claimed".into(),
            expires_at: DateTime::from_millis(9_999_999_999_000),
            remember_me: false,
            login_audience: Some(LoginAudience::Member),
            device_name: String::new(),
            session_version: 0,
            role: "member".into(),
            two_factor_enabled: false,
            two_factor_verified: false,
            revoke_session_id: Some(t1),
            pending_issuance: Some(PendingIssuance::new_for_test(t1, 1, 0, 1_000)),
        };
        let now = DateTime::now();
        assert!(matches!(
            classify_challenge_for_target(&record, user, t2, now),
            ChallengeConsumeOutcome::Conflict
        ));
        assert!(matches!(
            classify_challenge_for_target(&record, user, t1, now),
            ChallengeConsumeOutcome::Resume(_)
        ));
    }

    #[derive(Clone)]
    struct RefreshMem {
        context: std::sync::Arc<std::sync::Mutex<RefreshContext>>,
        cas_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        load_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        revoke_result: ConditionalRevokeResult,
        audits: std::sync::Arc<std::sync::Mutex<Vec<bool>>>,
        mutate_on_load: Option<(usize, fn(&mut RefreshContext))>,
    }

    impl RefreshStore for RefreshMem {
        async fn load_authoritative(&self, _sid: ObjectId) -> Result<Option<RefreshContext>, ()> {
            let call = self
                .load_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            let mut context = self.context.lock().unwrap();
            if let Some((at, mutation)) = self.mutate_on_load {
                if call == at {
                    mutation(&mut context);
                }
            }
            Ok(Some(context.clone()))
        }

        async fn compare_and_install_successors(
            &self,
            p: &RotationProposal,
        ) -> Result<CasInstallResult, ()> {
            self.cas_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut context = self.context.lock().unwrap();
            let session = &mut context.session;
            if session.refresh_generation != p.expected_generation
                || !digest_vec_equal(
                    &session.current_refresh_token_digest,
                    &p.expected_refresh_digest,
                )
                || !digest_vec_equal(
                    &session.next_recovery_secret_digest,
                    &p.expected_recovery_digest,
                )
            {
                return Ok(CasInstallResult::Miss);
            }
            session
                .consumed_refresh_token_digests
                .push(ConsumedRefreshDigest {
                    generation: p.expected_generation,
                    refresh_token_digest: p.expected_refresh_digest.to_vec(),
                    consumed_at: p.predecessor.committed_at,
                });
            session.current_refresh_token_digest = p.successor_refresh_digest.to_vec();
            session.next_recovery_secret_digest = p.successor_recovery_digest.to_vec();
            session.refresh_generation = p.successor_generation;
            session.rotation_key_id = p.successor_key_id.clone();
            session.immediate_predecessor = Some(p.predecessor.clone());
            Ok(CasInstallResult::Installed)
        }

        async fn conditional_revoke_for_reuse(
            &self,
            _sid: ObjectId,
            _generation: i64,
            _now: DateTime,
        ) -> Result<ConditionalRevokeResult, ()> {
            if self.revoke_result == ConditionalRevokeResult::RevokedOne {
                self.context.lock().unwrap().session.status = SessionStatus::Revoked;
            }
            Ok(self.revoke_result)
        }

        async fn write_reuse_audit(
            &self,
            _sid: ObjectId,
            _user_id: ObjectId,
            revoked: bool,
            _now: DateTime,
        ) {
            self.audits.lock().unwrap().push(revoked);
        }

        async fn logout(&self, _sid: ObjectId, _now: DateTime) -> Result<LogoutResult, ()> {
            Ok(LogoutResult::RevokedNow)
        }
    }

    fn refresh_fixture(
        now: DateTime,
    ) -> (
        RefreshMem,
        ObjectId,
        [u8; 32],
        [u8; 32],
        crate::state::RotationKeyRing,
        crate::state::RecoveryEncryptionKeyRing,
    ) {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let sid = ObjectId::parse_str("0123456789abcdef01234567").unwrap();
        let rotation_key = [0x31; 32];
        let encryption_key = [0x42; 32];
        let ring = crate::state::RotationKeyRing::parse(
            "rot",
            &format!("rot:{}", URL_SAFE_NO_PAD.encode(rotation_key)),
        )
        .unwrap();
        let encryption_ring = crate::state::RecoveryEncryptionKeyRing::parse(
            "enc",
            &format!("enc:{}", URL_SAFE_NO_PAD.encode(encryption_key)),
        )
        .unwrap();
        let refresh = [0x53; 32];
        let recovery = [0x64; 32];
        let session = AuthSession {
            session_id: sid,
            user_id: ObjectId::new(),
            role: "member".into(),
            session_version_at_issue: 7,
            slot: 1,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "d".into(),
            user_agent: "ua".into(),
            ip_address: "127.0.0.1".into(),
            current_refresh_token_digest: super::super::session_tokens::digest_rotation_secret(
                super::super::session_tokens::RotationDigestDomain::Refresh,
                &refresh,
                &rotation_key,
            )
            .to_vec(),
            next_recovery_secret_digest: super::super::session_tokens::digest_rotation_secret(
                super::super::session_tokens::RotationDigestDomain::Recovery,
                &recovery,
                &rotation_key,
            )
            .to_vec(),
            rotation_derivation_version: "v1".into(),
            rotation_key_id: "rot".into(),
            immediate_predecessor: None,
            consumed_refresh_token_digests: vec![],
            refresh_generation: 0,
            status: SessionStatus::Active,
            created_at: now,
            last_seen_at: now,
            idle_expires_at: Some(DateTime::from_millis(now.timestamp_millis() + 120_000)),
            absolute_expires_at: DateTime::from_millis(now.timestamp_millis() + 300_000),
            cleanup_at: DateTime::from_millis(now.timestamp_millis() + 300_000),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        let context = RefreshContext {
            session,
            user_active: true,
            current_user_session_version_at_issue: 7,
            current_role: "member".into(),
        };
        let store = RefreshMem {
            context: std::sync::Arc::new(std::sync::Mutex::new(context)),
            cas_count: Default::default(),
            load_count: Default::default(),
            revoke_result: ConditionalRevokeResult::RevokedOne,
            audits: Default::default(),
            mutate_on_load: None,
        };
        (store, sid, refresh, recovery, ring, encryption_ring)
    }

    #[derive(Clone)]
    struct UnlockMem {
        refresh: RefreshMem,
        password_hash: String,
        two_factor_enabled: bool,
        password_failures: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        otp_failures: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        unlock_cas_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        unlock_load_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        mutate_on_unlock_load: Option<(usize, fn(&mut RefreshContext))>,
        force_miss: bool,
    }

    impl RefreshStore for UnlockMem {
        async fn load_authoritative(&self, sid: ObjectId) -> Result<Option<RefreshContext>, ()> {
            self.refresh.load_authoritative(sid).await
        }
        async fn compare_and_install_successors(
            &self,
            p: &RotationProposal,
        ) -> Result<CasInstallResult, ()> {
            self.refresh.compare_and_install_successors(p).await
        }
        async fn conditional_revoke_for_reuse(
            &self,
            sid: ObjectId,
            generation: i64,
            now: DateTime,
        ) -> Result<ConditionalRevokeResult, ()> {
            self.refresh
                .conditional_revoke_for_reuse(sid, generation, now)
                .await
        }
        async fn write_reuse_audit(
            &self,
            sid: ObjectId,
            uid: ObjectId,
            revoked: bool,
            now: DateTime,
        ) {
            self.refresh.write_reuse_audit(sid, uid, revoked, now).await
        }
        async fn logout(&self, sid: ObjectId, now: DateTime) -> Result<LogoutResult, ()> {
            self.refresh.logout(sid, now).await
        }
    }

    impl UnlockStore for UnlockMem {
        async fn load_unlock_context(
            &self,
            _sid: ObjectId,
            user_id: ObjectId,
        ) -> Result<Option<UnlockContext>, ()> {
            let call = self
                .unlock_load_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            let mut context = self.refresh.context.lock().unwrap();
            if let Some((at, mutation)) = self.mutate_on_unlock_load {
                if call == at {
                    mutation(&mut context);
                }
            }
            let refresh = context.clone();
            drop(context);
            if refresh.session.user_id != user_id {
                return Ok(None);
            }
            Ok(Some(UnlockContext {
                refresh,
                password_hash: self.password_hash.clone(),
                two_factor_enabled: self.two_factor_enabled,
                two_factor_secret: "invalid-test-secret".into(),
            }))
        }
        async fn compare_and_unlock_with_successors(
            &self,
            p: &UnlockProposal,
        ) -> Result<CasInstallResult, ()> {
            self.unlock_cas_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.force_miss {
                return Ok(CasInstallResult::Miss);
            }
            let mut c = self.refresh.context.lock().unwrap();
            let s = &mut c.session;
            if s.status != SessionStatus::Locked
                || s.session_version_at_issue != p.rotation.expected_session_version_at_issue
                || s.refresh_generation != p.rotation.expected_generation
                || !digest_vec_equal(
                    &s.current_refresh_token_digest,
                    &p.rotation.expected_refresh_digest,
                )
                || !digest_vec_equal(
                    &s.next_recovery_secret_digest,
                    &p.rotation.expected_recovery_digest,
                )
            {
                return Ok(CasInstallResult::Miss);
            }
            s.consumed_refresh_token_digests
                .push(ConsumedRefreshDigest {
                    generation: p.rotation.expected_generation,
                    refresh_token_digest: p.rotation.expected_refresh_digest.to_vec(),
                    consumed_at: p.rotation.predecessor.committed_at,
                });
            s.current_refresh_token_digest = p.rotation.successor_refresh_digest.to_vec();
            s.next_recovery_secret_digest = p.rotation.successor_recovery_digest.to_vec();
            s.refresh_generation = p.rotation.successor_generation;
            s.rotation_key_id = p.rotation.successor_key_id.clone();
            s.immediate_predecessor = Some(p.rotation.predecessor.clone());
            s.status = SessionStatus::Active;
            s.last_seen_at = p.rotation.predecessor.committed_at;
            s.idle_expires_at = Some(p.idle_expires_at);
            s.unlock_password_attempts = 0;
            s.unlock_otp_attempts = 0;
            Ok(CasInstallResult::Installed)
        }
        async fn record_unlock_password_failure(
            &self,
            _sid: ObjectId,
            _now: DateTime,
        ) -> Result<UnlockAttemptResult, ()> {
            let result = self.password_failures.fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |count| (count < MAX_UNLOCK_REAUTH_ATTEMPTS as usize).then_some(count + 1),
            );
            Ok(match result {
                Ok(previous) if previous + 1 >= MAX_UNLOCK_REAUTH_ATTEMPTS as usize => {
                    UnlockAttemptResult::Consumed((previous + 1) as i32)
                }
                Ok(previous) => UnlockAttemptResult::Consumed((previous + 1) as i32),
                Err(_) => UnlockAttemptResult::Exhausted,
            })
        }
        async fn record_unlock_otp_failure(
            &self,
            _sid: ObjectId,
            _now: DateTime,
        ) -> Result<UnlockAttemptResult, ()> {
            let result = self.otp_failures.fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |count| (count < MAX_UNLOCK_REAUTH_ATTEMPTS as usize).then_some(count + 1),
            );
            Ok(match result {
                Ok(previous) => UnlockAttemptResult::Consumed((previous + 1) as i32),
                Err(_) => UnlockAttemptResult::Exhausted,
            })
        }
        async fn write_unlock_audit(
            &self,
            _sid: ObjectId,
            _uid: ObjectId,
            _success: bool,
            _now: DateTime,
        ) {
        }
    }

    fn unlock_fixture(
        now: DateTime,
    ) -> (
        UnlockMem,
        ObjectId,
        ObjectId,
        [u8; 32],
        [u8; 32],
        crate::state::RotationKeyRing,
        crate::state::RecoveryEncryptionKeyRing,
    ) {
        let (refresh, sid, r, k, keys, enc) = refresh_fixture(now);
        let uid = refresh.context.lock().unwrap().session.user_id;
        {
            let mut c = refresh.context.lock().unwrap();
            c.session.role = "admin".into();
            c.current_role = "admin".into();
            c.session.status = SessionStatus::Locked;
            c.session.idle_expires_at = Some(now);
        }
        let store = UnlockMem {
            refresh,
            password_hash: bcrypt::hash("correct-password", 4).unwrap(),
            two_factor_enabled: false,
            password_failures: Default::default(),
            otp_failures: Default::default(),
            unlock_cas_count: Default::default(),
            unlock_load_count: Default::default(),
            mutate_on_unlock_load: None,
            force_miss: false,
        };
        (store, sid, uid, r, k, keys, enc)
    }

    #[tokio::test]
    async fn auth_unlock_atomically_activates_and_rotates_once() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        let outcome = orchestrate_unlock(
            &store,
            sid,
            uid,
            refresh,
            recovery,
            "correct-password",
            None,
            &keys,
            &enc,
            now,
        )
        .await;
        assert!(matches!(outcome, UnlockOutcome::Unlocked { .. }));
        assert_eq!(
            store
                .unlock_cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let c = store.refresh.context.lock().unwrap();
        assert_eq!(c.session.status, SessionStatus::Active);
        assert_eq!(c.session.refresh_generation, 1);
        assert_eq!(c.session.consumed_refresh_token_digests.len(), 1);
        assert!(c.session.immediate_predecessor.is_some());
        assert_eq!(c.session.unlock_password_attempts, 0);
        assert_eq!(c.session.unlock_otp_attempts, 0);
        assert_eq!(
            c.session.idle_expires_at,
            Some(DateTime::from_millis(
                now.timestamp_millis() + STAFF_IDLE_SECONDS * 1000
            ))
        );
    }

    #[tokio::test]
    async fn auth_unlock_rejects_invalid_cookie_proofs_before_password_or_otp_counters() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (mut store, sid, uid, _refresh, recovery, keys, enc) = unlock_fixture(now);
        store.two_factor_enabled = true;
        let fabricated_refresh = [91_u8; 32];
        let outcome = orchestrate_unlock(
            &store,
            sid,
            uid,
            fabricated_refresh,
            recovery,
            "wrong-password",
            Some("000000"),
            &keys,
            &enc,
            now,
        )
        .await;
        assert_eq!(outcome, UnlockOutcome::Invalid);
        assert_eq!(
            store
                .password_failures
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an unauthenticated cookie pair must not consume a victim's password attempts"
        );
        assert_eq!(
            store.otp_failures.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an unauthenticated cookie pair must not consume a victim's OTP attempts"
        );
        assert_eq!(
            store
                .unlock_cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn auth_unlock_bounds_password_and_otp_failures_without_rotation() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (mut store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        let wrong = orchestrate_unlock(
            &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now,
        )
        .await;
        assert_eq!(wrong, UnlockOutcome::ReauthPasswordInvalid);
        assert_eq!(
            store
                .password_failures
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        store.two_factor_enabled = true;
        let otp = orchestrate_unlock(
            &store,
            sid,
            uid,
            refresh,
            recovery,
            "correct-password",
            Some("000000"),
            &keys,
            &enc,
            now,
        )
        .await;
        assert_eq!(otp, UnlockOutcome::ReauthOtpInvalid);
        assert_eq!(
            store.otp_failures.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            store
                .unlock_cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        store
            .refresh
            .context
            .lock()
            .unwrap()
            .session
            .unlock_password_attempts = MAX_UNLOCK_REAUTH_ATTEMPTS;
        let exhausted = orchestrate_unlock(
            &store,
            sid,
            uid,
            refresh,
            recovery,
            "correct-password",
            None,
            &keys,
            &enc,
            now,
        )
        .await;
        assert_eq!(exhausted, UnlockOutcome::ReauthAttemptsExhausted);
        assert_eq!(
            store.refresh.context.lock().unwrap().session.status,
            SessionStatus::Locked
        );
    }

    #[tokio::test]
    async fn auth_unlock_concurrent_failures_are_atomically_bounded() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        let attempts = tokio::join!(
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            ),
        );
        let attempts = [
            attempts.0, attempts.1, attempts.2, attempts.3, attempts.4, attempts.5,
        ];
        assert_eq!(
            store
                .password_failures
                .load(std::sync::atomic::Ordering::SeqCst),
            MAX_UNLOCK_REAUTH_ATTEMPTS as usize
        );
        assert_eq!(
            attempts
                .iter()
                .filter(|outcome| matches!(outcome, UnlockOutcome::ReauthPasswordInvalid))
                .count(),
            (MAX_UNLOCK_REAUTH_ATTEMPTS - 1) as usize
        );
        assert!(attempts
            .iter()
            .any(|outcome| matches!(outcome, UnlockOutcome::ReauthAttemptsExhausted)));
    }

    #[tokio::test]
    async fn auth_unlock_absolute_expiry_precedes_compound_epoch_and_account_failures() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        {
            let mut context = store.refresh.context.lock().unwrap();
            context.user_active = false;
            context.current_user_session_version_at_issue += 1;
            context.session.absolute_expires_at = now;
        }
        assert_eq!(
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now,
            )
            .await,
            UnlockOutcome::Expired
        );
        assert_eq!(
            store
                .password_failures
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn auth_unlock_enforces_authoritative_and_history_precedence() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        store
            .refresh
            .context
            .lock()
            .unwrap()
            .session
            .absolute_expires_at = now;
        assert_eq!(
            orchestrate_unlock(
                &store, sid, uid, refresh, recovery, "wrong", None, &keys, &enc, now
            )
            .await,
            UnlockOutcome::Expired
        );
        assert_eq!(
            store
                .password_failures
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        store.refresh.context.lock().unwrap().user_active = false;
        assert_eq!(
            orchestrate_unlock(
                &store,
                sid,
                uid,
                refresh,
                recovery,
                "correct-password",
                None,
                &keys,
                &enc,
                now
            )
            .await,
            UnlockOutcome::AccountDisabled
        );
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        store
            .refresh
            .context
            .lock()
            .unwrap()
            .session
            .consumed_refresh_token_digests = (0..MAX_CONSUMED_REFRESH_DIGESTS)
            .map(|i| ConsumedRefreshDigest {
                generation: i as i64,
                refresh_token_digest: vec![i as u8; 32],
                consumed_at: now,
            })
            .collect();
        assert_eq!(
            orchestrate_unlock(
                &store,
                sid,
                uid,
                refresh,
                recovery,
                "correct-password",
                None,
                &keys,
                &enc,
                now
            )
            .await,
            UnlockOutcome::HistoryFull
        );
    }

    #[tokio::test]
    async fn auth_unlock_rejects_initial_epoch_revocation_role_and_member_states() {
        let now = DateTime::from_millis(1_700_000_000_000);
        for (mutation, expected) in [
            (
                (|c: &mut RefreshContext| c.current_user_session_version_at_issue += 1)
                    as fn(&mut RefreshContext),
                UnlockOutcome::SessionVersionMismatch,
            ),
            (
                (|c: &mut RefreshContext| c.session.status = SessionStatus::Revoked)
                    as fn(&mut RefreshContext),
                UnlockOutcome::Revoked,
            ),
            (
                (|c: &mut RefreshContext| c.current_role = "owner".into())
                    as fn(&mut RefreshContext),
                UnlockOutcome::NotStaff,
            ),
            (
                (|c: &mut RefreshContext| {
                    c.session.role = "member".into();
                    c.current_role = "member".into();
                }) as fn(&mut RefreshContext),
                UnlockOutcome::NotStaff,
            ),
        ] {
            let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
            mutation(&mut store.refresh.context.lock().unwrap());
            assert_eq!(
                orchestrate_unlock(
                    &store,
                    sid,
                    uid,
                    refresh,
                    recovery,
                    "correct-password",
                    None,
                    &keys,
                    &enc,
                    now
                )
                .await,
                expected
            );
            assert_eq!(
                store
                    .unlock_cas_count
                    .load(std::sync::atomic::Ordering::SeqCst),
                0
            );
        }
    }

    #[tokio::test]
    async fn auth_unlock_revalidates_all_authoritative_states_before_signing() {
        let now = DateTime::from_millis(1_700_000_000_000);
        for (mutation, expected) in [
            (
                (|c: &mut RefreshContext| c.user_active = false) as fn(&mut RefreshContext),
                UnlockOutcome::AccountDisabled,
            ),
            (
                (|c: &mut RefreshContext| c.current_user_session_version_at_issue += 1)
                    as fn(&mut RefreshContext),
                UnlockOutcome::SessionVersionMismatch,
            ),
            (
                (|c: &mut RefreshContext| c.session.status = SessionStatus::Revoked)
                    as fn(&mut RefreshContext),
                UnlockOutcome::Revoked,
            ),
            (
                (|c: &mut RefreshContext| {
                    c.session.absolute_expires_at = DateTime::from_millis(1_700_000_000_000)
                }) as fn(&mut RefreshContext),
                UnlockOutcome::Expired,
            ),
            (
                (|c: &mut RefreshContext| c.current_role = "owner".into())
                    as fn(&mut RefreshContext),
                UnlockOutcome::NotStaff,
            ),
        ] {
            let (mut store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
            store.mutate_on_unlock_load = Some((2, mutation));
            assert_eq!(
                orchestrate_unlock(
                    &store,
                    sid,
                    uid,
                    refresh,
                    recovery,
                    "correct-password",
                    None,
                    &keys,
                    &enc,
                    now
                )
                .await,
                expected
            );
            assert_eq!(
                store
                    .unlock_cas_count
                    .load(std::sync::atomic::Ordering::SeqCst),
                1
            );
        }
    }

    #[tokio::test]
    async fn auth_unlock_truncates_recovery_at_absolute_expiry() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        let absolute = DateTime::from_millis(now.timestamp_millis() + 10_000);
        store
            .refresh
            .context
            .lock()
            .unwrap()
            .session
            .absolute_expires_at = absolute;
        assert!(matches!(
            orchestrate_unlock(
                &store,
                sid,
                uid,
                refresh,
                recovery,
                "correct-password",
                None,
                &keys,
                &enc,
                now
            )
            .await,
            UnlockOutcome::Unlocked { .. }
        ));
        assert_eq!(
            store
                .refresh
                .context
                .lock()
                .unwrap()
                .session
                .immediate_predecessor
                .as_ref()
                .unwrap()
                .recovery_expires_at,
            absolute
        );
    }

    #[tokio::test]
    async fn auth_unlock_response_loss_recovers_exact_pair_without_second_cas() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        let first = orchestrate_unlock(
            &store,
            sid,
            uid,
            refresh,
            recovery,
            "correct-password",
            None,
            &keys,
            &enc,
            now,
        )
        .await;
        let credentials = match first {
            UnlockOutcome::Unlocked { credentials } => credentials,
            other => panic!("{other:?}"),
        };
        // Retrying the lost response uses the unchanged Section 17 recovery machinery.
        let recovered = map_refresh_to_unlock(
            orchestrate_refresh(&store, sid, refresh, recovery, &keys, &enc, now).await,
        );
        assert_eq!(
            recovered,
            UnlockOutcome::Recovered {
                credentials: credentials.clone()
            }
        );
        assert_eq!(
            store
                .unlock_cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let at_boundary = map_refresh_to_unlock(
            orchestrate_refresh(
                &store,
                sid,
                refresh,
                recovery,
                &keys,
                &enc,
                DateTime::from_millis(now.timestamp_millis() + 60_000),
            )
            .await,
        );
        assert_eq!(at_boundary, UnlockOutcome::Recovered { credentials });
        let after = map_refresh_to_unlock(
            orchestrate_refresh(
                &store,
                sid,
                refresh,
                recovery,
                &keys,
                &enc,
                DateTime::from_millis(now.timestamp_millis() + 60_001),
            )
            .await,
        );
        assert_eq!(after, UnlockOutcome::RecoveryExpired);
    }

    #[tokio::test]
    async fn auth_unlock_cas_miss_reloads_without_false_second_unlock() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (mut store, sid, uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        store.force_miss = true;
        let outcome = orchestrate_unlock(
            &store,
            sid,
            uid,
            refresh,
            recovery,
            "correct-password",
            None,
            &keys,
            &enc,
            now,
        )
        .await;
        assert_eq!(outcome, UnlockOutcome::NotLockEligible);
        assert_eq!(
            store
                .unlock_cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn auth_unlock_normal_refresh_cannot_bypass_idle_lock() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, _uid, refresh, recovery, keys, enc) = unlock_fixture(now);
        assert_eq!(
            orchestrate_refresh(&store, sid, refresh, recovery, &keys, &enc, now).await,
            RefreshOutcome::IdleLocked
        );
        assert_eq!(
            store
                .refresh
                .cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn auth_refresh_recovery_uses_production_orchestration_seam() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, old_refresh, old_recovery, keys, encryption_keys) = refresh_fixture(now);
        let rotated = orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            old_recovery,
            &keys,
            &encryption_keys,
            now,
        )
        .await;
        let credentials = match rotated {
            RefreshOutcome::Rotated { credentials } => credentials,
            other => panic!("expected rotation, got {other:?}"),
        };
        assert_eq!(store.cas_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        let recovered = orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            old_recovery,
            &keys,
            &encryption_keys,
            now,
        )
        .await;
        assert_eq!(
            recovered,
            RefreshOutcome::Recovered {
                credentials: credentials.clone()
            }
        );
        assert_eq!(store.cas_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        let current_old = orchestrate_refresh(
            &store,
            sid,
            *credentials.refresh,
            old_recovery,
            &keys,
            &encryption_keys,
            now,
        )
        .await;
        assert_eq!(
            current_old,
            RefreshOutcome::Recovered {
                credentials: credentials.clone()
            }
        );
        let old_new = orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            *credentials.recovery,
            &keys,
            &encryption_keys,
            now,
        )
        .await;
        assert_eq!(
            old_new,
            RefreshOutcome::Recovered {
                credentials: credentials.clone()
            }
        );
        let next = orchestrate_refresh(
            &store,
            sid,
            *credentials.refresh,
            *credentials.recovery,
            &keys,
            &encryption_keys,
            now,
        )
        .await;
        assert!(matches!(next, RefreshOutcome::Rotated { .. }));
        assert_eq!(store.cas_count.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn auth_refresh_key_transition() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        let now = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, old_refresh, old_recovery, _, encryption_keys) = refresh_fixture(now);
        let old_key = [0x31; 32];
        let new_key = [0x71; 32];
        let transitioned = crate::state::RotationKeyRing::parse(
            "new",
            &format!(
                "old:{},new:{}",
                URL_SAFE_NO_PAD.encode(old_key),
                URL_SAFE_NO_PAD.encode(new_key)
            ),
        )
        .unwrap();
        store.context.lock().unwrap().session.rotation_key_id = "old".into();

        let first = match orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            old_recovery,
            &transitioned,
            &encryption_keys,
            now,
        )
        .await
        {
            RefreshOutcome::Rotated { credentials } => credentials,
            other => panic!("retained old key must rotate, got {other:?}"),
        };
        assert_eq!(store.context.lock().unwrap().session.rotation_key_id, "new");
        assert_eq!(
            orchestrate_refresh(
                &store,
                sid,
                old_refresh,
                old_recovery,
                &transitioned,
                &encryption_keys,
                now,
            )
            .await,
            RefreshOutcome::Recovered {
                credentials: first.clone()
            }
        );
        assert!(matches!(
            orchestrate_refresh(
                &store,
                sid,
                *first.refresh,
                *first.recovery,
                &transitioned,
                &encryption_keys,
                now,
            )
            .await,
            RefreshOutcome::Rotated { .. }
        ));

        let (unknown_store, unknown_sid, refresh, recovery, _, encryption_keys) =
            refresh_fixture(now);
        unknown_store
            .context
            .lock()
            .unwrap()
            .session
            .rotation_key_id = "missing".into();
        assert_eq!(
            orchestrate_refresh(
                &unknown_store,
                unknown_sid,
                refresh,
                recovery,
                &transitioned,
                &encryption_keys,
                now,
            )
            .await,
            RefreshOutcome::RecoveryUnavailable
        );
        assert_eq!(
            unknown_store
                .cas_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(unknown_store.audits.lock().unwrap().is_empty());
        assert_eq!(
            unknown_store.context.lock().unwrap().session.status,
            SessionStatus::Active
        );
    }

    #[tokio::test]
    async fn auth_refresh_boundaries_are_inclusive_and_truthful() {
        let committed = DateTime::from_millis(1_700_000_000_000);
        let (store, sid, old_refresh, old_recovery, keys, encryption_keys) =
            refresh_fixture(committed);
        let credentials = match orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            old_recovery,
            &keys,
            &encryption_keys,
            committed,
        )
        .await
        {
            RefreshOutcome::Rotated { credentials } => credentials,
            _ => unreachable!(),
        };
        assert!(matches!(
            orchestrate_refresh(
                &store,
                sid,
                old_refresh,
                [9; 32],
                &keys,
                &encryption_keys,
                DateTime::from_millis(committed.timestamp_millis() + 5_000)
            )
            .await,
            RefreshOutcome::ConcurrentPredecessor
        ));
        assert!(matches!(
            orchestrate_refresh(
                &store,
                sid,
                old_refresh,
                [9; 32],
                &keys,
                &encryption_keys,
                DateTime::from_millis(committed.timestamp_millis() + 5_001)
            )
            .await,
            RefreshOutcome::Reused
        ));
        let (store, sid, old_refresh, old_recovery, keys, encryption_keys) =
            refresh_fixture(committed);
        let _ = orchestrate_refresh(
            &store,
            sid,
            old_refresh,
            old_recovery,
            &keys,
            &encryption_keys,
            committed,
        )
        .await;
        assert!(matches!(
            orchestrate_refresh(
                &store,
                sid,
                old_refresh,
                old_recovery,
                &keys,
                &encryption_keys,
                DateTime::from_millis(committed.timestamp_millis() + 60_000)
            )
            .await,
            RefreshOutcome::Recovered { .. }
        ));
        assert_eq!(
            orchestrate_refresh(
                &store,
                sid,
                old_refresh,
                old_recovery,
                &keys,
                &encryption_keys,
                DateTime::from_millis(committed.timestamp_millis() + 60_001)
            )
            .await,
            RefreshOutcome::RecoveryExpired
        );
        assert_ne!(*credentials.refresh, old_refresh);
    }

    #[tokio::test]
    async fn auth_refresh_authoritative_precedence_reloads_before_success() {
        fn disable(c: &mut RefreshContext) {
            c.user_active = false;
        }
        let now = DateTime::from_millis(1_700_000_000_000);
        let (mut store, sid, refresh, recovery, keys, encryption_keys) = refresh_fixture(now);
        store.mutate_on_load = Some((2, disable));
        assert_eq!(
            orchestrate_refresh(&store, sid, refresh, recovery, &keys, &encryption_keys, now).await,
            RefreshOutcome::AccountDisabled
        );
        assert_eq!(store.cas_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    fn session_management_fixture(
        user_id: ObjectId,
        session_id: ObjectId,
        order: i64,
    ) -> AuthSession {
        AuthSession {
            session_id,
            user_id,
            role: "member".into(),
            session_version_at_issue: 7,
            slot: (order as i32).max(1),
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: format!("device-{order}"),
            user_agent: "Browser/1 full detail".into(),
            ip_address: "10.20.30.40".into(),
            current_refresh_token_digest: vec![1; 32],
            next_recovery_secret_digest: vec![2; 32],
            rotation_derivation_version: "v1".into(),
            rotation_key_id: "key".into(),
            immediate_predecessor: None,
            consumed_refresh_token_digests: vec![],
            refresh_generation: 0,
            status: SessionStatus::Active,
            created_at: DateTime::from_millis(order * 1_000),
            last_seen_at: DateTime::from_millis((100 - order) * 1_000),
            idle_expires_at: None,
            absolute_expires_at: DateTime::from_millis(9_999_999_999_000),
            cleanup_at: DateTime::from_millis(9_999_999_999_000),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        }
    }

    struct ActivityMem {
        session: std::sync::Mutex<AuthSession>,
        last_user_activity_at: std::sync::Mutex<DateTime>,
        persist_count: std::sync::atomic::AtomicUsize,
        forced_cas_reload: std::sync::Mutex<Option<AuthSession>>,
    }
    impl ActivityMem {
        fn new(session: AuthSession) -> Self {
            let last_seen_at = session.last_seen_at;
            Self {
                session: session.into(),
                last_user_activity_at: last_seen_at.into(),
                persist_count: 0.into(),
                forced_cas_reload: None.into(),
            }
        }
        fn persisted(&self) -> (DateTime, DateTime, Option<DateTime>, usize) {
            let session = self.session.lock().unwrap();
            (
                session.last_seen_at,
                *self.last_user_activity_at.lock().unwrap(),
                session.idle_expires_at,
                self.persist_count.load(std::sync::atomic::Ordering::SeqCst),
            )
        }
        fn background_poll(&self) {
            // Gateway/background reads deliberately do not call the explicit activity store write.
        }
    }
    impl ActivityStore for ActivityMem {
        async fn load_activity_session(&self, _sid: ObjectId) -> Result<Option<AuthSession>, ()> {
            Ok(Some(self.session.lock().unwrap().clone()))
        }
        async fn compare_and_record_activity(
            &self,
            _sid: ObjectId,
            previous: DateTime,
            now: DateTime,
            idle: DateTime,
        ) -> Result<bool, ()> {
            if let Some(authoritative) = self.forced_cas_reload.lock().unwrap().take() {
                *self.last_user_activity_at.lock().unwrap() = authoritative.last_seen_at;
                *self.session.lock().unwrap() = authoritative;
                return Ok(false);
            }
            let mut session = self.session.lock().unwrap();
            if session.status != SessionStatus::Active || session.last_seen_at != previous {
                return Ok(false);
            }
            session.last_seen_at = now;
            *self.last_user_activity_at.lock().unwrap() = now;
            session.idle_expires_at = Some(idle);
            self.persist_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(true)
        }
        async fn compare_and_lock_idle(&self, _sid: ObjectId, now: DateTime) -> Result<bool, ()> {
            let mut session = self.session.lock().unwrap();
            if session.status == SessionStatus::Active
                && session.idle_expires_at.is_some_and(|v| v <= now)
            {
                session.status = SessionStatus::Locked;
                return Ok(true);
            }
            Ok(false)
        }
    }

    fn activity_fixture(sid: ObjectId, now: DateTime, role: &str) -> AuthSession {
        let mut session = session_management_fixture(ObjectId::new(), sid, 1);
        session.role = role.into();
        session.created_at = now;
        session.last_seen_at = now;
        session.absolute_expires_at = DateTime::from_millis(now.timestamp_millis() + 28_800_000);
        session.idle_expires_at = Some(DateTime::from_millis(now.timestamp_millis() + 1_800_000));
        session
    }

    fn activity_status_session_from_auth(session: &AuthSession) -> ActivityStatusSession {
        ActivityStatusSession {
            session_id: session.session_id,
            user_id: session.user_id,
            role: session.role.clone(),
            session_version_at_issue: session.session_version_at_issue,
            status: session.status.clone(),
            absolute_expires_at: session.absolute_expires_at,
            idle_expires_at: session.idle_expires_at,
        }
    }

    fn activity_status_context(
        session: AuthSession,
        user_active: bool,
        session_version: i64,
        current_role: &str,
    ) -> ActivityStatusContext {
        ActivityStatusContext {
            session: activity_status_session_from_auth(&session),
            user_active,
            current_user_session_version_at_issue: session_version,
            current_role: current_role.into(),
        }
    }

    struct ActivityStatusMem {
        context: std::sync::Mutex<Option<ActivityStatusContext>>,
        load_fail: std::sync::atomic::AtomicBool,
        record_activity_calls: std::sync::atomic::AtomicUsize,
        lock_idle_calls: std::sync::atomic::AtomicUsize,
    }
    impl ActivityStatusMem {
        fn new(ctx: ActivityStatusContext) -> Self {
            Self {
                context: Some(ctx).into(),
                load_fail: false.into(),
                record_activity_calls: 0.into(),
                lock_idle_calls: 0.into(),
            }
        }
        fn empty() -> Self {
            Self {
                context: None.into(),
                load_fail: false.into(),
                record_activity_calls: 0.into(),
                lock_idle_calls: 0.into(),
            }
        }
        fn failing() -> Self {
            Self {
                context: None.into(),
                load_fail: true.into(),
                record_activity_calls: 0.into(),
                lock_idle_calls: 0.into(),
            }
        }
        fn record_activity_calls(&self) -> usize {
            self.record_activity_calls
                .load(std::sync::atomic::Ordering::SeqCst)
        }
        fn lock_idle_calls(&self) -> usize {
            self.lock_idle_calls
                .load(std::sync::atomic::Ordering::SeqCst)
        }
        fn assert_no_writes(&self) {
            assert_eq!(self.record_activity_calls(), 0);
            assert_eq!(self.lock_idle_calls(), 0);
        }
    }
    impl ActivityStatusStore for ActivityStatusMem {
        async fn load_activity_status_context(
            &self,
            _sid: ObjectId,
        ) -> Result<Option<ActivityStatusContext>, ()> {
            if self.load_fail.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(());
            }
            Ok(self.context.lock().unwrap().clone())
        }
    }
    impl ActivityStore for ActivityStatusMem {
        async fn load_activity_session(&self, _sid: ObjectId) -> Result<Option<AuthSession>, ()> {
            Ok(None)
        }
        async fn compare_and_record_activity(
            &self,
            _sid: ObjectId,
            _previous: DateTime,
            _now: DateTime,
            _idle: DateTime,
        ) -> Result<bool, ()> {
            self.record_activity_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(false)
        }
        async fn compare_and_lock_idle(&self, _sid: ObjectId, _now: DateTime) -> Result<bool, ()> {
            self.lock_idle_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(false)
        }
    }

    async fn run_status(
        store: &ActivityStatusMem,
        sid: ObjectId,
        user_id: ObjectId,
        now: DateTime,
    ) -> ActivityOutcome {
        orchestrate_staff_activity_status(store, sid, user_id, now).await
    }

    #[tokio::test]
    async fn auth_activity_status_active_success_returns_authoritative_deadlines() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let idle = session.idle_expires_at.unwrap();
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        let outcome = run_status(&store, sid, user_id, now).await;
        assert_eq!(
            outcome,
            ActivityOutcome::Throttled {
                warning_at: DateTime::from_millis(idle.timestamp_millis() - 300_000),
                idle_expires_at: idle,
            }
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_exact_warning_boundary_is_still_active() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let idle = DateTime::from_millis(now.timestamp_millis() + 300_000);
        session.idle_expires_at = Some(idle);
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        let at_warning = DateTime::from_millis(idle.timestamp_millis() - 300_000);
        let outcome = run_status(&store, sid, user_id, at_warning).await;
        assert_eq!(
            outcome,
            ActivityOutcome::Throttled {
                warning_at: at_warning,
                idle_expires_at: idle,
            }
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_exact_idle_boundary_is_locked_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let idle = DateTime::from_millis(now.timestamp_millis() + 1_800_000);
        session.idle_expires_at = Some(idle);
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, idle).await,
            ActivityOutcome::IdleLocked
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_already_locked_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.status = SessionStatus::Locked;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::IdleLocked
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_absolute_expiry_precedes_idle_lock() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.absolute_expires_at = now;
        session.idle_expires_at = Some(now);
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Expired
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_expired_status_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.status = SessionStatus::Expired;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Expired
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_revoked_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.status = SessionStatus::Revoked;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Revoked
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_missing_session_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let store = ActivityStatusMem::empty();
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Invalid
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_member_role_rejected_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.user_id = user_id;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "member"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::NotStaff
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_member_absolute_expired_returns_expired_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.user_id = user_id;
        session.absolute_expires_at = now;
        session.idle_expires_at = Some(now);
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "member"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Expired
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_member_revoked_returns_revoked_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.user_id = user_id;
        session.status = SessionStatus::Revoked;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "member"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Revoked
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_member_locked_returns_idle_locked_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.user_id = user_id;
        session.status = SessionStatus::Locked;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "member"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::IdleLocked
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_member_missing_idle_deadline_is_not_staff_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.user_id = user_id;
        session.idle_expires_at = None;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "member"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::NotStaff
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_missing_idle_deadline_is_invalid_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.idle_expires_at = None;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Invalid
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_trusted_user_mismatch_is_invalid_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, ObjectId::new(), now).await,
            ActivityOutcome::Invalid
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_account_disabled_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let store = ActivityStatusMem::new(activity_status_context(session, false, 7, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::AccountDisabled
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_session_version_mismatch_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 99, "admin"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::SessionVersionMismatch
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_role_mismatch_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        session.session_version_at_issue = 7;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "staff"));
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::SessionVersionMismatch
        );
        store.assert_no_writes();
    }

    #[test]
    fn auth_activity_status_context_struct_is_bounded() {
        let sample = ActivityStatusSession {
            session_id: ObjectId::new(),
            user_id: ObjectId::new(),
            role: "admin".into(),
            session_version_at_issue: 7,
            status: SessionStatus::Active,
            absolute_expires_at: DateTime::from_millis(1_700_000_000_000),
            idle_expires_at: Some(DateTime::from_millis(1_700_001_800_000)),
        };
        assert_eq!(sample.role, "admin");
        assert_eq!(sample.session_version_at_issue, 7);
        assert!(matches!(sample.status, SessionStatus::Active));
        assert!(sample.idle_expires_at.is_some());
        let fields: &[&str] = &[
            "session_id",
            "user_id",
            "role",
            "session_version_at_issue",
            "status",
            "absolute_expires_at",
            "idle_expires_at",
        ];
        let src = include_str!("session_store.rs");
        let struct_start = src
            .find("pub struct ActivityStatusSession")
            .expect("ActivityStatusSession");
        let struct_end = src[struct_start..]
            .find("pub fn activity_status_session_projection")
            .expect("projection fn");
        let struct_src = &src[struct_start..struct_start + struct_end];
        for field in fields {
            assert!(
                struct_src.contains(field),
                "ActivityStatusSession must declare {field}"
            );
        }
        let forbidden = [
            "current_refresh_token_digest",
            "next_recovery_secret_digest",
            "immediate_predecessor",
            "device_id",
            "user_agent",
            "ip_address",
            "migration_operation_marker",
        ];
        for token in forbidden {
            assert!(
                !struct_src.contains(token),
                "ActivityStatusSession must not contain {token}"
            );
        }
        assert!(!struct_src.contains("AuthSession"));
        let ctx_start = src
            .find("pub struct ActivityStatusContext")
            .expect("ActivityStatusContext");
        let ctx_end = src[ctx_start..]
            .find("pub trait ActivityStatusStore")
            .expect("trait");
        let ctx_src = &src[ctx_start..ctx_start + ctx_end];
        assert!(ctx_src.contains("ActivityStatusSession"));
        assert!(!ctx_src.contains("AuthSession"));
    }

    #[test]
    fn auth_activity_status_session_bson_round_trip_uses_camel_case_fields() {
        use mongodb::bson::{from_bson, to_bson, Bson};

        let session = ActivityStatusSession {
            session_id: ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
            user_id: ObjectId::parse_str("507f191e810c19729de860ea").unwrap(),
            role: "staff".into(),
            session_version_at_issue: 3,
            status: SessionStatus::Active,
            absolute_expires_at: DateTime::from_millis(1_700_000_000_000),
            idle_expires_at: Some(DateTime::from_millis(1_700_001_800_000)),
        };
        let bson = to_bson(&session).expect("serialize ActivityStatusSession");
        let Bson::Document(document) = &bson else {
            panic!("expected BSON document");
        };
        assert_eq!(
            document.len(),
            7,
            "ActivityStatusSession BSON must have exactly seven fields"
        );
        for key in [
            "sessionId",
            "userId",
            "role",
            "sessionVersionAtIssue",
            "status",
            "absoluteExpiresAt",
            "idleExpiresAt",
        ] {
            assert!(document.contains_key(key), "missing persisted field {key}");
        }
        assert!(matches!(document.get("sessionId"), Some(Bson::ObjectId(_))));
        assert!(matches!(document.get("userId"), Some(Bson::ObjectId(_))));
        assert!(matches!(document.get("role"), Some(Bson::String(_))));
        assert!(matches!(
            document.get("sessionVersionAtIssue"),
            Some(Bson::Int64(_))
        ));
        assert!(matches!(document.get("status"), Some(Bson::String(_))));
        assert!(matches!(
            document.get("absoluteExpiresAt"),
            Some(Bson::DateTime(_))
        ));
        assert!(matches!(
            document.get("idleExpiresAt"),
            Some(Bson::DateTime(_))
        ));
        assert_eq!(
            from_bson::<ActivityStatusSession>(bson).expect("deserialize ActivityStatusSession"),
            session
        );
    }

    #[test]
    fn auth_activity_status_user_decode_requires_bool_active() {
        let user_id = ObjectId::new();
        let valid = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": 7_i64,
            "role": "staff",
        };
        let decoded = decode_activity_status_user(&valid).expect("valid user document");
        assert_eq!(
            decoded,
            ActivityStatusUser {
                user_id,
                active: true,
                session_version: 7,
                role: "staff".into(),
            }
        );
        let missing_active = doc! {
            "_id": user_id,
            "sessionVersion": 7_i64,
            "role": "staff",
        };
        assert!(decode_activity_status_user(&missing_active).is_err());
        let wrong_type_active = doc! {
            "_id": user_id,
            "active": "true",
            "sessionVersion": 7_i64,
            "role": "staff",
        };
        assert!(decode_activity_status_user(&wrong_type_active).is_err());
    }

    #[test]
    fn auth_activity_status_user_decode_requires_authoritative_role_and_epoch() {
        let user_id = ObjectId::new();
        let base = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": 7_i64,
            "role": "staff",
        };
        assert!(decode_activity_status_user(&base).is_ok());
        let int32_epoch = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": 7_i32,
            "role": "staff",
        };
        assert_eq!(
            decode_activity_status_user(&int32_epoch)
                .expect("Mongo integer epoch")
                .session_version,
            7,
        );
        let missing_role = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": 7_i64,
        };
        assert!(decode_activity_status_user(&missing_role).is_err());
        let wrong_role_type = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": 7_i64,
            "role": 1_i32,
        };
        assert!(decode_activity_status_user(&wrong_role_type).is_err());
        let missing_epoch = doc! {
            "_id": user_id,
            "active": true,
            "role": "staff",
        };
        assert!(decode_activity_status_user(&missing_epoch).is_err());
        let wrong_epoch_type = doc! {
            "_id": user_id,
            "active": true,
            "sessionVersion": "7",
            "role": "staff",
        };
        assert!(decode_activity_status_user(&wrong_epoch_type).is_err());
        let missing_id = doc! {
            "active": true,
            "sessionVersion": 7_i64,
            "role": "staff",
        };
        assert!(decode_activity_status_user(&missing_id).is_err());
    }

    #[tokio::test]
    async fn auth_activity_status_malformed_user_active_prevents_staff_deadlines_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        // Simulates Mongo loader after strict decode: malformed authoritative user → no context.
        let store = ActivityStatusMem::empty();
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Invalid
        );
        store.assert_no_writes();
        let _ = session;
    }

    #[test]
    fn auth_activity_status_mongo_projection_contract() {
        let session_proj = activity_status_session_projection();
        assert_eq!(session_proj.get_i32("_id"), Ok(0));
        for key in [
            "sessionId",
            "userId",
            "role",
            "sessionVersionAtIssue",
            "status",
            "absoluteExpiresAt",
            "idleExpiresAt",
        ] {
            assert_eq!(session_proj.get_i32(key), Ok(1), "session field {key}");
        }
        assert_eq!(session_proj.len(), 8);
        for forbidden in [
            "currentRefreshTokenDigest",
            "nextRecoverySecretDigest",
            "immediatePredecessor",
            "deviceId",
            "userAgent",
            "ipAddress",
            "migrationOperationMarker",
            "lastSeenAt",
            "lastUserActivityAt",
        ] {
            assert!(
                !session_proj.contains_key(forbidden),
                "session projection must exclude {forbidden}"
            );
        }
        let user_proj = activity_status_user_projection();
        for key in ["_id", "active", "sessionVersion", "role"] {
            assert_eq!(user_proj.get_i32(key), Ok(1), "user field {key}");
        }
        assert_eq!(user_proj.len(), 4);
        for forbidden in ["password", "otp", "twoFactor", "email", "name"] {
            assert!(
                !user_proj.contains_key(forbidden),
                "user projection must exclude {forbidden}"
            );
        }
        let handlers = include_str!("session_handlers.rs");
        assert!(
            handlers.contains("activity_status_session_projection()"),
            "Mongo loader must use activity_status_session_projection"
        );
        assert!(
            handlers.contains("activity_status_user_projection()"),
            "Mongo loader must use activity_status_user_projection"
        );
        assert!(
            handlers.contains("decode_activity_status_user"),
            "Mongo loader must fail closed on malformed authoritative user fields"
        );
        assert!(
            handlers.contains("collection::<ActivityStatusSession>"),
            "Mongo loader must deserialize bounded ActivityStatusSession"
        );
    }

    #[tokio::test]
    async fn auth_activity_status_trusted_sid_mismatch_is_invalid_without_write() {
        let sid = ObjectId::new();
        let other_sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.user_id = user_id;
        let store = ActivityStatusMem::new(activity_status_context(session, true, 7, "admin"));
        assert_eq!(
            run_status(&store, other_sid, user_id, now).await,
            ActivityOutcome::Invalid
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_activity_status_store_read_failure_without_write() {
        let sid = ObjectId::new();
        let user_id = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let store = ActivityStatusMem::failing();
        assert_eq!(
            run_status(&store, sid, user_id, now).await,
            ActivityOutcome::Store
        );
        store.assert_no_writes();
    }

    #[tokio::test]
    async fn auth_idle_repeated_boundaries_persist_monotonically() {
        let sid = ObjectId::new();
        let start = DateTime::from_millis(1_700_000_000_000);
        let store = ActivityMem::new(activity_fixture(sid, start, "admin"));
        store.background_poll();
        assert_eq!(store.persisted().3, 0);
        let at_59 = DateTime::from_millis(start.timestamp_millis() + 59_000);
        assert!(matches!(
            orchestrate_staff_activity(&store, sid, at_59).await,
            ActivityOutcome::Throttled { .. }
        ));
        assert_eq!(store.persisted().3, 0);
        for (seconds, expected_count) in [(60, 1), (120, 2)] {
            let at = DateTime::from_millis(start.timestamp_millis() + seconds * 1_000);
            assert!(
                matches!(orchestrate_staff_activity(&store, sid, at).await, ActivityOutcome::Recorded { idle_expires_at, .. } if idle_expires_at.timestamp_millis() == at.timestamp_millis() + 1_800_000)
            );
            let (last_seen, last_user, idle, count) = store.persisted();
            assert_eq!((last_seen, last_user, count), (at, at, expected_count));
            assert_eq!(
                idle,
                Some(DateTime::from_millis(at.timestamp_millis() + 1_800_000))
            );
        }
    }

    #[tokio::test]
    async fn auth_idle_clock_regression_does_not_regress_persisted_fields() {
        let sid = ObjectId::new();
        let start = DateTime::from_millis(1_700_000_000_000);
        let store = ActivityMem::new(activity_fixture(sid, start, "admin"));
        let at = DateTime::from_millis(start.timestamp_millis() + 60_000);
        assert!(matches!(
            orchestrate_staff_activity(&store, sid, at).await,
            ActivityOutcome::Recorded { .. }
        ));
        let persisted = store.persisted();
        assert!(matches!(
            orchestrate_staff_activity(&store, sid, start).await,
            ActivityOutcome::Throttled { .. }
        ));
        assert_eq!(store.persisted(), persisted);
    }

    #[tokio::test]
    async fn auth_idle_throttled_deadlines_are_exactly_persisted() {
        let sid = ObjectId::new();
        let start = DateTime::from_millis(1_700_000_000_000);
        let session = activity_fixture(sid, start, "admin");
        let persisted_idle = session.idle_expires_at.unwrap();
        let store = ActivityMem::new(session);
        let outcome = orchestrate_staff_activity(
            &store,
            sid,
            DateTime::from_millis(start.timestamp_millis() + 59_000),
        )
        .await;
        assert!(
            matches!(outcome, ActivityOutcome::Throttled { warning_at, idle_expires_at } if idle_expires_at == persisted_idle && warning_at.timestamp_millis() == persisted_idle.timestamp_millis() - 300_000)
        );
        assert_eq!(store.persisted().3, 0);
    }

    #[tokio::test]
    async fn auth_idle_cas_miss_reloads_authoritative_state() {
        let sid = ObjectId::new();
        let start = DateTime::from_millis(1_700_000_000_000);
        let store = ActivityMem::new(activity_fixture(sid, start, "admin"));
        let mut authoritative = activity_fixture(sid, start, "admin");
        authoritative.status = SessionStatus::Locked;
        authoritative.last_seen_at = DateTime::from_millis(start.timestamp_millis() + 30_000);
        authoritative.idle_expires_at =
            Some(DateTime::from_millis(start.timestamp_millis() + 30_000));
        *store.forced_cas_reload.lock().unwrap() = Some(authoritative);
        assert_eq!(
            orchestrate_staff_activity(
                &store,
                sid,
                DateTime::from_millis(start.timestamp_millis() + 60_000)
            )
            .await,
            ActivityOutcome::IdleLocked
        );
        assert_eq!(store.persisted().3, 0);
    }

    #[tokio::test]
    async fn auth_idle_active_member_with_elapsed_idle_is_excluded() {
        let sid = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "member");
        session.idle_expires_at = Some(DateTime::from_millis(now.timestamp_millis() - 1));
        let store = ActivityMem::new(session);
        assert_eq!(
            orchestrate_staff_activity(&store, sid, now).await,
            ActivityOutcome::NotStaff
        );
        assert_eq!(store.session.lock().unwrap().status, SessionStatus::Active);
        assert_eq!(store.persisted().3, 0);
    }

    #[tokio::test]
    async fn auth_idle_absolute_expiry_precedes_atomic_idle_lock() {
        let sid = ObjectId::new();
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut session = activity_fixture(sid, now, "admin");
        session.absolute_expires_at = now;
        session.idle_expires_at = Some(now);
        let store = ActivityMem::new(session);
        assert_eq!(
            orchestrate_staff_activity(&store, sid, now).await,
            ActivityOutcome::Expired
        );
        assert_eq!(store.session.lock().unwrap().status, SessionStatus::Active);
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum GlobalRevokeCrash {
        Never,
        AfterEpoch,
        AfterSessions,
    }

    struct SessionManagementMem {
        sessions: std::sync::Mutex<Vec<AuthSession>>,
        epoch: std::sync::Mutex<i64>,
        pending: std::sync::Mutex<Option<(ObjectId, i64)>>,
        crash: std::sync::Mutex<GlobalRevokeCrash>,
    }
    impl SessionManagementMem {
        fn new(sessions: Vec<AuthSession>, epoch: i64) -> Self {
            Self {
                sessions: sessions.into(),
                epoch: epoch.into(),
                pending: None.into(),
                crash: GlobalRevokeCrash::Never.into(),
            }
        }
        fn with_crash(self, crash: GlobalRevokeCrash) -> Self {
            *self.crash.lock().unwrap() = crash;
            self
        }
        fn disable_crash(&self) {
            *self.crash.lock().unwrap() = GlobalRevokeCrash::Never;
        }
    }
    impl SessionManagementStore for SessionManagementMem {
        async fn revoke_owned(
            &self,
            user_id: ObjectId,
            sid: ObjectId,
            _now: DateTime,
        ) -> Result<RevokeSessionResult, ()> {
            let mut rows = self.sessions.lock().unwrap();
            let Some(row) = rows.iter_mut().find(|row| row.session_id == sid) else {
                return Ok(RevokeSessionResult::NotOwned);
            };
            if row.user_id != user_id {
                return Ok(RevokeSessionResult::NotOwned);
            }
            if row.status == SessionStatus::Revoked {
                return Ok(RevokeSessionResult::AlreadyTerminal);
            }
            row.status = SessionStatus::Revoked;
            row.owns_slot = false;
            Ok(RevokeSessionResult::RevokedNow)
        }
        async fn begin_global(
            &self,
            _user_id: ObjectId,
            operation_id: ObjectId,
            _now: DateTime,
        ) -> Result<GlobalRevokePending, ()> {
            let mut pending = self.pending.lock().unwrap();
            let (operation_id, epoch) = if let Some(value) = *pending {
                value
            } else {
                let mut current = self.epoch.lock().unwrap();
                *current += 1;
                let value = (operation_id, *current);
                *pending = Some(value);
                value
            };
            if *self.crash.lock().unwrap() == GlobalRevokeCrash::AfterEpoch {
                return Err(());
            }
            Ok(GlobalRevokePending {
                operation_id,
                session_version: epoch,
            })
        }
        async fn revoke_all(
            &self,
            user_id: ObjectId,
            _operation_id: ObjectId,
            _now: DateTime,
        ) -> Result<(), ()> {
            for row in self
                .sessions
                .lock()
                .unwrap()
                .iter_mut()
                .filter(|row| row.user_id == user_id)
            {
                row.status = SessionStatus::Revoked;
                row.owns_slot = false;
            }
            if *self.crash.lock().unwrap() == GlobalRevokeCrash::AfterSessions {
                return Err(());
            }
            Ok(())
        }
        async fn finish_global(
            &self,
            _user_id: ObjectId,
            _operation_id: ObjectId,
            operation_epoch: i64,
            _now: DateTime,
        ) -> Result<GlobalRevokeFinish, ()> {
            let epoch = *self.epoch.lock().unwrap();
            assert_eq!(operation_epoch, epoch);
            *self.pending.lock().unwrap() = None;
            Ok(GlobalRevokeFinish::Completed(epoch))
        }
    }

    #[test]
    fn auth_sessions_management_summaries_are_bounded_sanitized_and_mark_current() {
        let user = ObjectId::new();
        let current = ObjectId::new();
        let rows: Vec<_> = (0..(MAX_SESSION_SUMMARIES + 3))
            .map(|index| {
                session_management_fixture(
                    user,
                    if index == 0 { current } else { ObjectId::new() },
                    index as i64,
                )
            })
            .collect();
        let summaries = bounded_session_summaries(rows, current);
        assert_eq!(summaries.len(), MAX_SESSION_SUMMARIES);
        assert!(summaries[0].current);
        let value = serde_json::to_value(&summaries).unwrap();
        let encoded = value.to_string();
        for forbidden in [
            "currentRefreshTokenDigest",
            "nextRecoverySecretDigest",
            "ipAddress",
            "consumedRefreshTokenDigests",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[tokio::test]
    async fn auth_sessions_management_revoke_is_user_bound_idempotent_and_current_only() {
        let user = ObjectId::new();
        let other = ObjectId::new();
        let current = ObjectId::new();
        let sibling = ObjectId::new();
        let store = SessionManagementMem::new(
            vec![
                session_management_fixture(user, current, 1),
                session_management_fixture(user, sibling, 2),
                session_management_fixture(other, ObjectId::new(), 3),
            ],
            7,
        );
        let other_session = store.sessions.lock().unwrap()[2].session_id;
        assert_eq!(
            orchestrate_device_revoke(&store, user, other_session, DateTime::now())
                .await
                .unwrap(),
            RevokeSessionResult::NotOwned
        );
        assert_eq!(
            orchestrate_device_revoke(&store, user, sibling, DateTime::now())
                .await
                .unwrap(),
            RevokeSessionResult::RevokedNow
        );
        assert_eq!(
            orchestrate_device_revoke(&store, user, sibling, DateTime::now())
                .await
                .unwrap(),
            RevokeSessionResult::AlreadyTerminal
        );
        assert_eq!(
            orchestrate_device_revoke(&store, user, current, DateTime::now())
                .await
                .unwrap(),
            RevokeSessionResult::RevokedNow
        );
        let rows = store.sessions.lock().unwrap();
        assert_eq!(
            rows.iter()
                .filter(|row| row.user_id == other && row.status == SessionStatus::Active)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn auth_sessions_management_global_revoke_converges_across_crash_retry_interleavings() {
        let user = ObjectId::new();
        for crash in [
            GlobalRevokeCrash::AfterEpoch,
            GlobalRevokeCrash::AfterSessions,
            GlobalRevokeCrash::Never,
        ] {
            let store = SessionManagementMem::new(
                vec![
                    session_management_fixture(user, ObjectId::new(), 1),
                    session_management_fixture(user, ObjectId::new(), 2),
                ],
                9,
            )
            .with_crash(crash);
            let first = orchestrate_global_revoke(&store, user, DateTime::now()).await;
            let result = if crash == GlobalRevokeCrash::Never {
                first.unwrap()
            } else {
                assert!(first.is_err());
                store.disable_crash();
                orchestrate_global_revoke(&store, user, DateTime::now())
                    .await
                    .unwrap()
            };
            assert_eq!(result.session_version, 10);
            assert!(!store.pending.lock().unwrap().is_some());
            assert!(store
                .sessions
                .lock()
                .unwrap()
                .iter()
                .all(|row| row.status == SessionStatus::Revoked && !row.owns_slot));
            assert_eq!(*store.epoch.lock().unwrap(), 10);
        }
        assert_eq!(active_session_limit("member"), 5);
        assert_eq!(active_session_limit("staff"), 2);
    }

    #[tokio::test]
    async fn auth_sessions_management_stale_finish_follows_newer_pending_operation() {
        struct InterleavedStore {
            user: ObjectId,
            first: ObjectId,
            second: ObjectId,
            revoke_calls: std::sync::Mutex<Vec<ObjectId>>,
            finishes: std::sync::Mutex<usize>,
        }
        impl SessionManagementStore for InterleavedStore {
            async fn revoke_owned(
                &self,
                _: ObjectId,
                _: ObjectId,
                _: DateTime,
            ) -> Result<RevokeSessionResult, ()> {
                unreachable!()
            }
            async fn begin_global(
                &self,
                user: ObjectId,
                _: ObjectId,
                _: DateTime,
            ) -> Result<GlobalRevokePending, ()> {
                assert_eq!(user, self.user);
                Ok(GlobalRevokePending {
                    operation_id: self.first,
                    session_version: 10,
                })
            }
            async fn revoke_all(
                &self,
                _: ObjectId,
                operation: ObjectId,
                _: DateTime,
            ) -> Result<(), ()> {
                self.revoke_calls.lock().unwrap().push(operation);
                Ok(())
            }
            async fn finish_global(
                &self,
                _: ObjectId,
                operation: ObjectId,
                operation_epoch: i64,
                _: DateTime,
            ) -> Result<GlobalRevokeFinish, ()> {
                let mut calls = self.finishes.lock().unwrap();
                assert_eq!(operation_epoch, if *calls == 0 { 10 } else { 11 });
                *calls += 1;
                if *calls == 1 {
                    assert_eq!(operation, self.first);
                    Ok(GlobalRevokeFinish::Follow(GlobalRevokePending {
                        operation_id: self.second,
                        session_version: 11,
                    }))
                } else {
                    assert_eq!(operation, self.second);
                    Ok(GlobalRevokeFinish::Completed(11))
                }
            }
        }
        let store = InterleavedStore {
            user: ObjectId::new(),
            first: ObjectId::new(),
            second: ObjectId::new(),
            revoke_calls: vec![].into(),
            finishes: 0.into(),
        };
        let result = orchestrate_global_revoke(&store, store.user, DateTime::now())
            .await
            .unwrap();
        assert_eq!(result.session_version, 11);
        assert_eq!(
            *store.revoke_calls.lock().unwrap(),
            vec![store.first, store.second]
        );
    }

    #[tokio::test]
    async fn auth_sessions_management_successful_finish_returns_captured_operation_epoch() {
        struct BeginNextBeforeFinishReturns {
            user: ObjectId,
            first: ObjectId,
            top_level_epoch: std::sync::Mutex<i64>,
        }
        impl SessionManagementStore for BeginNextBeforeFinishReturns {
            async fn revoke_owned(
                &self,
                _: ObjectId,
                _: ObjectId,
                _: DateTime,
            ) -> Result<RevokeSessionResult, ()> {
                unreachable!()
            }
            async fn begin_global(
                &self,
                user: ObjectId,
                _: ObjectId,
                _: DateTime,
            ) -> Result<GlobalRevokePending, ()> {
                assert_eq!(user, self.user);
                Ok(GlobalRevokePending {
                    operation_id: self.first,
                    session_version: 10,
                })
            }
            async fn revoke_all(&self, _: ObjectId, _: ObjectId, _: DateTime) -> Result<(), ()> {
                Ok(())
            }
            async fn finish_global(
                &self,
                _: ObjectId,
                operation: ObjectId,
                operation_epoch: i64,
                _: DateTime,
            ) -> Result<GlobalRevokeFinish, ()> {
                assert_eq!(operation, self.first);
                // Operation A's CAS has succeeded. Operation B begins before A returns.
                *self.top_level_epoch.lock().unwrap() = 11;
                Ok(GlobalRevokeFinish::Completed(operation_epoch))
            }
        }
        let store = BeginNextBeforeFinishReturns {
            user: ObjectId::new(),
            first: ObjectId::new(),
            top_level_epoch: 10.into(),
        };
        let result = orchestrate_global_revoke(&store, store.user, DateTime::now())
            .await
            .unwrap();
        assert_eq!(*store.top_level_epoch.lock().unwrap(), 11);
        assert_eq!(result.session_version, 10);
    }

    #[test]
    fn consumed_digest_history_is_bounded() {
        let mut session = AuthSession {
            session_id: ObjectId::new(),
            user_id: ObjectId::new(),
            role: "member".into(),
            session_version_at_issue: 0,
            slot: 1,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "device".into(),
            user_agent: "agent".into(),
            ip_address: "127.0.0.1".into(),
            current_refresh_token_digest: vec![1; 32],
            consumed_refresh_token_digests: (0..MAX_CONSUMED_REFRESH_DIGESTS)
                .map(|generation| ConsumedRefreshDigest {
                    generation: generation as i64,
                    refresh_token_digest: vec![2; 32],
                    consumed_at: DateTime::from_millis(0),
                })
                .collect(),
            refresh_generation: 0,
            next_recovery_secret_digest: vec![],
            rotation_derivation_version: "v1".into(),
            rotation_key_id: String::new(),
            immediate_predecessor: None,
            status: SessionStatus::Active,
            created_at: DateTime::now(),
            last_seen_at: DateTime::now(),
            idle_expires_at: None,
            absolute_expires_at: DateTime::now(),
            cleanup_at: DateTime::now(),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        };
        assert!(!session.can_record_consumed_digest());
        session.consumed_refresh_token_digests.pop();
        assert!(session.can_record_consumed_digest());
    }
}
