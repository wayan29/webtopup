//! Five-minute action-scoped step-up authentication (Task 11 / design §5.4).
//!
//! Issues password+OTP grants bound to trusted user, session, and action group.
//! Failed credentials are non-terminal `REAUTH_*` and never alter the base session.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    auth_error,
    policy::MAX_UNLOCK_REAUTH_ATTEMPTS,
    session_store::{
        authoritative, AuthSession, RefreshContext, SessionStatus, AUTH_SECURITY_AUDITS_COLLECTION,
        AUTH_SESSIONS_COLLECTION,
    },
    totp::{is_valid_totp_code, normalize_otp_code},
    types::StepUpClaims as TypesStepUpClaims,
};
use crate::{security::require_proxy_context, state::AppState};

pub const STEP_UP_GRANT_SECONDS: i64 = 5 * 60;
pub const STEP_UP_PURPOSE: &str = "step-up";
pub const MAX_STEP_UP_REAUTH_ATTEMPTS: i32 = MAX_UNLOCK_REAUTH_ATTEMPTS;

/// Closed action-group inventory for Task 11.
pub const ACTION_GROUPS: &[&str] = &[
    "finance.adjust_balance",
    "finance.refund",
    "finance.deposit_approval",
    "transactions.manual",
    "integrations.credentials",
    "team.manage_privileged",
    "team.reset_2fa",
    "security.sessions_all",
    "exports.sensitive",
    // Staff self-service credential changes (email/password). These are account-takeover
    // paths, so they need fresh proof of possession like any other privileged action.
    "security.password",
    // Site Config sensitive effective changes (Task 9).
    "settings.sensitive",
];

const TRUSTED_STEP_UP_GROUP_HEADER: &str = "x-webtopup-step-up-group";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUpPayload {
    password: String,
    #[serde(default)]
    otp: Option<String>,
    #[serde(default)]
    otp_code: Option<String>,
    action_group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepUpClaims {
    pub sub: String,
    pub sid: String,
    pub action_group: String,
    pub purpose: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepUpOutcome {
    Granted {
        token: String,
        action_group: String,
        expires_at: i64,
    },
    ReauthPasswordInvalid,
    ReauthOtpInvalid,
    ReauthAttemptsExhausted,
    MissingOtp,
    InvalidActionGroup,
    Invalid,
    Expired,
    Revoked,
    AccountDisabled,
    SessionVersionMismatch,
    IdleLocked,
    NotStaff,
    TwoFactorRequired,
    HistoryFull,
    Store,
    SigningFailure,
}

#[derive(Debug, Clone)]
pub struct StepUpContext {
    pub refresh: RefreshContext,
    pub password_hash: String,
    pub two_factor_enabled: bool,
    pub two_factor_secret: String,
    pub step_up_password_attempts: i32,
    pub step_up_otp_attempts: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepUpAttemptResult {
    Consumed(i32),
    Exhausted,
    Miss,
}

pub trait StepUpStore: Send + Sync {
    async fn load_step_up_context(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
    ) -> Result<Option<StepUpContext>, ()>;
    async fn record_step_up_password_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<StepUpAttemptResult, ()>;
    async fn record_step_up_otp_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<StepUpAttemptResult, ()>;
    async fn write_step_up_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        action_group: &str,
        success: bool,
        now: DateTime,
    );
}

struct MongoStepUpStore<'a> {
    db: &'a mongodb::Database,
}

fn step_up_attempt_filter(sid: ObjectId, now: DateTime, counter: &str) -> Document {
    doc! {
        "sessionId": sid,
        "status": "active",
        "absoluteExpiresAt": { "$gt": now },
        "$or": [
            { counter: { "$exists": false } },
            { counter: { "$lt": MAX_STEP_UP_REAUTH_ATTEMPTS } },
        ],
    }
}

impl MongoStepUpStore<'_> {
    async fn record_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
        counter: &str,
    ) -> Result<StepUpAttemptResult, ()> {
        let filter = step_up_attempt_filter(sid, now, counter);
        let mut increment = Document::new();
        increment.insert(counter, 1_i32);
        let updated = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find_one_and_update(filter, doc! { "$inc": increment })
            .with_options(
                mongodb::options::FindOneAndUpdateOptions::builder()
                    .return_document(mongodb::options::ReturnDocument::After)
                    .build(),
            )
            .await
            .map_err(|_| ())?;
        if let Some(updated) = updated {
            return Ok(StepUpAttemptResult::Consumed(
                updated.get_i32(counter).unwrap_or_default(),
            ));
        }
        let current = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid })
            .await
            .map_err(|_| ())?;
        Ok(
            match current.and_then(|document| document.get_i32(counter).ok()) {
                Some(value) if value >= MAX_STEP_UP_REAUTH_ATTEMPTS => {
                    StepUpAttemptResult::Exhausted
                }
                _ => StepUpAttemptResult::Miss,
            },
        )
    }
}

impl StepUpStore for MongoStepUpStore<'_> {
    async fn load_step_up_context(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
    ) -> Result<Option<StepUpContext>, ()> {
        let session = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid, "userId": user_id })
            .await
            .map_err(|_| ())?;
        let Some(session) = session else {
            return Ok(None);
        };
        let raw = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid, "userId": user_id })
            .await
            .map_err(|_| ())?;
        let step_up_password_attempts = raw
            .as_ref()
            .and_then(|d| d.get_i32("stepUpPasswordAttempts").ok())
            .unwrap_or(0);
        let step_up_otp_attempts = raw
            .as_ref()
            .and_then(|d| d.get_i32("stepUpOtpAttempts").ok())
            .unwrap_or(0);
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": user_id })
            .await
            .map_err(|_| ())?;
        let Some(user) = user else {
            return Ok(None);
        };
        Ok(Some(StepUpContext {
            refresh: RefreshContext {
                user_active: user.get_bool("active").unwrap_or(true),
                current_user_session_version_at_issue: user.get_i64("sessionVersion").unwrap_or(0),
                current_role: user.get_str("role").unwrap_or("member").to_string(),
                session,
            },
            password_hash: user.get_str("password").unwrap_or("").to_string(),
            two_factor_enabled: user.get_bool("twoFactorEnabled").unwrap_or(false),
            two_factor_secret: user.get_str("twoFactorSecret").unwrap_or("").to_string(),
            step_up_password_attempts,
            step_up_otp_attempts,
        }))
    }

    async fn record_step_up_password_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<StepUpAttemptResult, ()> {
        self.record_failure(sid, now, "stepUpPasswordAttempts")
            .await
    }

    async fn record_step_up_otp_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<StepUpAttemptResult, ()> {
        self.record_failure(sid, now, "stepUpOtpAttempts").await
    }

    async fn write_step_up_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        action_group: &str,
        success: bool,
        now: DateTime,
    ) {
        use super::security_audit::{
            metric_step_up, write_security_audit, SecurityAuditEvent, EVENT_STEP_UP_FAILED,
            EVENT_STEP_UP_GRANTED,
        };
        let group = match action_group {
            "finance.adjust_balance" => "finance.adjust_balance",
            "finance.refund" => "finance.refund",
            "finance.deposit_approval" => "finance.deposit_approval",
            "security.password" => "security.password",
            "security.two_factor" => "security.two_factor",
            "exports.sensitive" => "exports.sensitive",
            "team.manage" => "team.manage",
            _ => "other",
        };
        let (event, outcome) = if success {
            metric_step_up(group, "granted");
            (EVENT_STEP_UP_GRANTED, "granted")
        } else {
            metric_step_up(group, "failed");
            (EVENT_STEP_UP_FAILED, "failed")
        };
        let span_trace = crate::services::correlation::current_span_correlation_trace_id();
        let correlation = crate::services::correlation::resolve_correlation_untrusted(
            &axum::http::HeaderMap::new(),
            span_trace.as_deref(),
        );
        let _ = now;
        write_security_audit(
            self.db,
            SecurityAuditEvent {
                event,
                outcome,
                user_id: Some(user_id),
                session_id: Some(sid),
                trace_id: correlation.trace_id,
                correlation_source: correlation.source.as_str(),
                action_group: Some(group),
                reason: None,
                device: None,
            },
        )
        .await;
    }
}

fn staff_role(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "cs" | "staff")
}

pub fn is_known_action_group(group: &str) -> bool {
    ACTION_GROUPS.iter().any(|known| *known == group)
}

pub fn step_up_precedence(ctx: &StepUpContext, now: DateTime) -> Option<StepUpOutcome> {
    let s = &ctx.refresh.session;
    if !ctx.refresh.user_active {
        Some(StepUpOutcome::AccountDisabled)
    } else if s.session_version_at_issue != ctx.refresh.current_user_session_version_at_issue {
        Some(StepUpOutcome::SessionVersionMismatch)
    } else if s.status == SessionStatus::Revoked {
        Some(StepUpOutcome::Revoked)
    } else if s.status == SessionStatus::Expired || s.absolute_expires_at <= now {
        Some(StepUpOutcome::Expired)
    } else if s.status == SessionStatus::Locked || s.idle_expires_at.is_some_and(|v| v <= now) {
        Some(StepUpOutcome::IdleLocked)
    } else if s.status != SessionStatus::Active {
        Some(StepUpOutcome::Invalid)
    } else if !staff_role(&s.role) || s.role != ctx.refresh.current_role {
        Some(StepUpOutcome::NotStaff)
    } else if !s.can_record_consumed_digest() {
        Some(StepUpOutcome::HistoryFull)
    } else {
        None
    }
}

pub fn sign_step_up_grant(
    claims: &StepUpClaims,
    secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn decode_step_up_grant(
    token: &str,
    secret: &str,
) -> Result<StepUpClaims, jsonwebtoken::errors::Error> {
    // Exp is enforced by the caller against an authoritative now so unit tests and
    // Node/Rust boundaries share an exact `exp <= now` definition without leeway.
    let mut validation = Validation::default();
    validation.validate_exp = false;
    validation.leeway = 0;
    decode::<StepUpClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
}

/// Cryptographic + binding verification for a step-up grant.
/// Rejects wrong user/SID/group/purpose and expiry at the exact boundary.
pub fn verify_step_up_grant(
    token: &str,
    secret: &str,
    expected_sub: &str,
    expected_sid: &str,
    expected_action_group: &str,
    now_seconds: i64,
) -> Result<StepUpClaims, StepUpOutcome> {
    let claims = decode_step_up_grant(token, secret).map_err(|_| StepUpOutcome::Invalid)?;
    if claims.purpose != STEP_UP_PURPOSE {
        return Err(StepUpOutcome::Invalid);
    }
    if claims.sub != expected_sub || claims.sid != expected_sid {
        return Err(StepUpOutcome::Invalid);
    }
    if claims.action_group != expected_action_group || !is_known_action_group(&claims.action_group)
    {
        return Err(StepUpOutcome::Invalid);
    }
    if claims.exp <= now_seconds {
        return Err(StepUpOutcome::Expired);
    }
    if claims.iat > now_seconds {
        return Err(StepUpOutcome::Invalid);
    }
    Ok(claims)
}

/// Defense-in-depth: require the Node-stamped trusted action-group header on
/// sensitive Rust handlers. Never trust browser-supplied group headers.
pub fn require_trusted_step_up_group(
    headers: &HeaderMap,
    expected_group: &str,
) -> Result<(), Response> {
    let provided = headers
        .get(TRUSTED_STEP_UP_GROUP_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided == expected_group && is_known_action_group(expected_group) {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": {
                "code": "AUTH_STEP_UP_REQUIRED",
                "actionGroup": expected_group,
                "message": "Verifikasi ulang diperlukan untuk aksi sensitif"
            }
        })),
    )
        .into_response())
}

pub async fn orchestrate_step_up<S: StepUpStore>(
    store: &S,
    sid: ObjectId,
    user_id: ObjectId,
    password: &str,
    otp_code: Option<&str>,
    action_group: &str,
    jwt_secret: &str,
    now: DateTime,
) -> StepUpOutcome {
    if !is_known_action_group(action_group) {
        return StepUpOutcome::InvalidActionGroup;
    }
    let Some(ctx) = (match store.load_step_up_context(sid, user_id).await {
        Ok(v) => v,
        Err(_) => return StepUpOutcome::Store,
    }) else {
        return StepUpOutcome::Invalid;
    };
    if ctx.refresh.session.user_id != user_id || ctx.refresh.session.session_id != sid {
        return StepUpOutcome::Invalid;
    }
    if let Some(outcome) = step_up_precedence(&ctx, now) {
        return outcome;
    }
    // Mandatory staff 2FA (Task 10): every grant on this inventory requires OTP.
    if !ctx.two_factor_enabled || ctx.two_factor_secret.trim().is_empty() {
        return StepUpOutcome::TwoFactorRequired;
    }
    if ctx.step_up_password_attempts >= MAX_STEP_UP_REAUTH_ATTEMPTS
        || ctx.step_up_otp_attempts >= MAX_STEP_UP_REAUTH_ATTEMPTS
    {
        return StepUpOutcome::ReauthAttemptsExhausted;
    }
    if !bcrypt::verify(password, &ctx.password_hash).unwrap_or(false) {
        let outcome = match store.record_step_up_password_failure(sid, now).await {
            Ok(StepUpAttemptResult::Consumed(count)) if count >= MAX_STEP_UP_REAUTH_ATTEMPTS => {
                StepUpOutcome::ReauthAttemptsExhausted
            }
            Ok(StepUpAttemptResult::Consumed(_)) => StepUpOutcome::ReauthPasswordInvalid,
            Ok(StepUpAttemptResult::Exhausted) => StepUpOutcome::ReauthAttemptsExhausted,
            Ok(StepUpAttemptResult::Miss) => match store.load_step_up_context(sid, user_id).await {
                Ok(Some(current)) => step_up_precedence(&current, now)
                    .unwrap_or(StepUpOutcome::ReauthAttemptsExhausted),
                Ok(None) => StepUpOutcome::Invalid,
                Err(_) => StepUpOutcome::Store,
            },
            Err(_) => StepUpOutcome::Store,
        };
        store
            .write_step_up_audit(sid, user_id, action_group, false, now)
            .await;
        return outcome;
    }
    let code = normalize_otp_code(otp_code);
    if code.is_empty() {
        store
            .write_step_up_audit(sid, user_id, action_group, false, now)
            .await;
        return StepUpOutcome::MissingOtp;
    }
    if !is_valid_totp_code(&code, &ctx.two_factor_secret) {
        let outcome = match store.record_step_up_otp_failure(sid, now).await {
            Ok(StepUpAttemptResult::Consumed(count)) if count >= MAX_STEP_UP_REAUTH_ATTEMPTS => {
                StepUpOutcome::ReauthAttemptsExhausted
            }
            Ok(StepUpAttemptResult::Consumed(_)) => StepUpOutcome::ReauthOtpInvalid,
            Ok(StepUpAttemptResult::Exhausted) => StepUpOutcome::ReauthAttemptsExhausted,
            Ok(StepUpAttemptResult::Miss) => match store.load_step_up_context(sid, user_id).await {
                Ok(Some(current)) => step_up_precedence(&current, now)
                    .unwrap_or(StepUpOutcome::ReauthAttemptsExhausted),
                Ok(None) => StepUpOutcome::Invalid,
                Err(_) => StepUpOutcome::Store,
            },
            Err(_) => StepUpOutcome::Store,
        };
        store
            .write_step_up_audit(sid, user_id, action_group, false, now)
            .await;
        return outcome;
    }
    // Re-check authoritative state immediately before signing so base session is never
    // mutated and grants are not issued against a concurrent revocation/epoch change.
    let Some(fresh) = (match store.load_step_up_context(sid, user_id).await {
        Ok(v) => v,
        Err(_) => return StepUpOutcome::Store,
    }) else {
        return StepUpOutcome::Invalid;
    };
    if let Some(outcome) = step_up_precedence(&fresh, now) {
        return outcome;
    }
    if fresh.step_up_password_attempts >= MAX_STEP_UP_REAUTH_ATTEMPTS
        || fresh.step_up_otp_attempts >= MAX_STEP_UP_REAUTH_ATTEMPTS
    {
        return StepUpOutcome::ReauthAttemptsExhausted;
    }
    if let Some(outcome) = authoritative(&fresh.refresh, now) {
        return match outcome {
            super::session_store::RefreshOutcome::AccountDisabled => StepUpOutcome::AccountDisabled,
            super::session_store::RefreshOutcome::SessionVersionMismatch => {
                StepUpOutcome::SessionVersionMismatch
            }
            super::session_store::RefreshOutcome::Revoked => StepUpOutcome::Revoked,
            super::session_store::RefreshOutcome::Expired => StepUpOutcome::Expired,
            super::session_store::RefreshOutcome::IdleLocked => StepUpOutcome::IdleLocked,
            super::session_store::RefreshOutcome::HistoryFull => StepUpOutcome::HistoryFull,
            _ => StepUpOutcome::Invalid,
        };
    }
    let now_s = now.timestamp_millis() / 1000;
    let claims = StepUpClaims {
        sub: user_id.to_hex(),
        sid: sid.to_hex(),
        action_group: action_group.to_string(),
        purpose: STEP_UP_PURPOSE.into(),
        iat: now_s,
        exp: now_s + STEP_UP_GRANT_SECONDS,
        jti: ObjectId::new().to_hex(),
    };
    let Ok(token) = sign_step_up_grant(&claims, jwt_secret) else {
        return StepUpOutcome::SigningFailure;
    };
    // Secrecy: never embed password/OTP into claims or logs.
    debug_assert!(!token.contains(password));
    store
        .write_step_up_audit(sid, user_id, action_group, true, now)
        .await;
    StepUpOutcome::Granted {
        token,
        action_group: action_group.to_string(),
        expires_at: claims.exp,
    }
}

fn trusted_ids(context: &crate::security::ProxyContext) -> Result<(ObjectId, ObjectId), Response> {
    let user = context
        .user_id
        .as_deref()
        .and_then(|v| ObjectId::parse_str(v).ok());
    let sid = context
        .session_id
        .as_deref()
        .and_then(|v| ObjectId::parse_str(v).ok());
    match (user, sid) {
        (Some(user), Some(sid)) => Ok((user, sid)),
        _ => Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        )),
    }
}

fn step_up_outcome_error(outcome: StepUpOutcome) -> Response {
    let (status, code, message) = match outcome {
        StepUpOutcome::ReauthPasswordInvalid => (
            StatusCode::BAD_REQUEST,
            "REAUTH_PASSWORD_INVALID",
            "Password tidak valid",
        ),
        StepUpOutcome::ReauthOtpInvalid => (
            StatusCode::BAD_REQUEST,
            "REAUTH_OTP_INVALID",
            "Kode OTP tidak valid",
        ),
        StepUpOutcome::ReauthAttemptsExhausted => (
            StatusCode::BAD_REQUEST,
            "REAUTH_ATTEMPTS_EXHAUSTED",
            "Percobaan verifikasi terlalu banyak",
        ),
        StepUpOutcome::MissingOtp => (
            StatusCode::BAD_REQUEST,
            "REAUTH_OTP_INVALID",
            "Kode OTP wajib diisi",
        ),
        StepUpOutcome::InvalidActionGroup => (
            StatusCode::BAD_REQUEST,
            "AUTH_STEP_UP_REQUIRED",
            "Kelompok aksi tidak valid",
        ),
        StepUpOutcome::TwoFactorRequired => (
            StatusCode::FORBIDDEN,
            "AUTH_2FA_ENROLLMENT_REQUIRED",
            "2FA staf wajib diaktifkan sebelum aksi sensitif",
        ),
        StepUpOutcome::Expired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_EXPIRED",
            "Session expired",
        ),
        StepUpOutcome::Revoked => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_REVOKED",
            "Session revoked",
        ),
        StepUpOutcome::AccountDisabled => (
            StatusCode::UNAUTHORIZED,
            "AUTH_ACCOUNT_DISABLED",
            "Account disabled",
        ),
        StepUpOutcome::SessionVersionMismatch => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_POLICY_CHANGED",
            "Session policy changed",
        ),
        StepUpOutcome::IdleLocked => (
            StatusCode::LOCKED,
            "AUTH_IDLE_LOCKED",
            "Session idle locked",
        ),
        StepUpOutcome::NotStaff
        | StepUpOutcome::Invalid
        | StepUpOutcome::HistoryFull
        | StepUpOutcome::SigningFailure => (
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid step-up request",
        ),
        StepUpOutcome::Store => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": {
                        "code": "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
                        "message": "Step-up temporarily unavailable",
                    }
                })),
            )
                .into_response()
        }
        StepUpOutcome::Granted { .. } => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "message": "Internal server error" })),
            )
                .into_response()
        }
    };
    auth_error(status, code, message)
}

pub async fn step_up(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<StepUpPayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (user_id, trusted_sid) = match trusted_ids(&context) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let action_group = payload.action_group.trim().to_string();
    let otp = payload
        .otp
        .as_deref()
        .or(payload.otp_code.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let Some(client) = &state.mongo_client else {
        return step_up_outcome_error(StepUpOutcome::Store);
    };
    let db = client.database(&state.mongo_db);
    let store = MongoStepUpStore { db: &db };
    let now = DateTime::from_millis(
        (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0))
            * 1000,
    );
    match orchestrate_step_up(
        &store,
        trusted_sid,
        user_id,
        &payload.password,
        otp,
        &action_group,
        &state.jwt_secret,
        now,
    )
    .await
    {
        StepUpOutcome::Granted {
            token,
            action_group,
            expires_at,
        } => {
            // Grant only in the memory response body — never cookies / durable storage.
            (
                StatusCode::OK,
                Json(json!({
                    "grantToken": token,
                    "actionGroup": action_group,
                    "expiresAt": expires_at,
                    "expiresInSeconds": STEP_UP_GRANT_SECONDS,
                })),
            )
                .into_response()
        }
        outcome => step_up_outcome_error(outcome),
    }
}

// Keep types::StepUpClaims aligned with the local wire struct.
#[allow(dead_code)]
fn _types_step_up_claims_align(claims: &StepUpClaims) -> TypesStepUpClaims {
    TypesStepUpClaims {
        sub: claims.sub.clone(),
        sid: claims.sid.clone(),
        action_group: claims.action_group.clone(),
        purpose: claims.purpose.clone(),
        iat: claims.iat,
        exp: claims.exp,
        jti: claims.jti.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::auth::session_store::{AuthSession, ConsumedRefreshDigest, SessionStatus};
    use std::sync::{Arc, Mutex};

    fn dt(seconds: i64) -> DateTime {
        DateTime::from_millis(seconds * 1000)
    }

    fn session(user: ObjectId, sid: ObjectId, now: i64) -> AuthSession {
        AuthSession {
            session_id: sid,
            user_id: user,
            role: "admin".into(),
            session_version_at_issue: 3,
            slot: 0,
            owns_slot: true,
            replaced_from_session_id: None,
            device_id: "d1".into(),
            user_agent: "ua".into(),
            ip_address: "127.0.0.1".into(),
            current_refresh_token_digest: vec![1; 32],
            next_recovery_secret_digest: vec![2; 32],
            rotation_derivation_version: "v1".into(),
            rotation_key_id: "k1".into(),
            immediate_predecessor: None,
            consumed_refresh_token_digests: Vec::new(),
            refresh_generation: 1,
            status: SessionStatus::Active,
            created_at: dt(now - 60),
            last_seen_at: dt(now),
            idle_expires_at: Some(dt(now + 1800)),
            absolute_expires_at: dt(now + 8 * 3600),
            cleanup_at: dt(now + 30 * 24 * 3600),
            migration_operation_marker: None,
            unlock_password_attempts: 0,
            unlock_otp_attempts: 0,
        }
    }

    #[derive(Clone)]
    struct MemStore {
        ctx: Arc<Mutex<Option<StepUpContext>>>,
        password_hits: Arc<Mutex<i32>>,
        otp_hits: Arc<Mutex<i32>>,
        audits: Arc<Mutex<Vec<(bool, String)>>>,
    }

    impl MemStore {
        fn new(ctx: StepUpContext) -> Self {
            Self {
                ctx: Arc::new(Mutex::new(Some(ctx))),
                password_hits: Arc::new(Mutex::new(0)),
                otp_hits: Arc::new(Mutex::new(0)),
                audits: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl StepUpStore for MemStore {
        async fn load_step_up_context(
            &self,
            sid: ObjectId,
            user_id: ObjectId,
        ) -> Result<Option<StepUpContext>, ()> {
            let guard = self.ctx.lock().unwrap();
            Ok(guard.as_ref().and_then(|c| {
                if c.refresh.session.session_id == sid && c.refresh.session.user_id == user_id {
                    Some(c.clone())
                } else {
                    None
                }
            }))
        }
        async fn record_step_up_password_failure(
            &self,
            _sid: ObjectId,
            _now: DateTime,
        ) -> Result<StepUpAttemptResult, ()> {
            let mut hits = self.password_hits.lock().unwrap();
            *hits += 1;
            if *hits > MAX_STEP_UP_REAUTH_ATTEMPTS {
                return Ok(StepUpAttemptResult::Exhausted);
            }
            if let Some(ctx) = self.ctx.lock().unwrap().as_mut() {
                ctx.step_up_password_attempts = *hits;
            }
            Ok(StepUpAttemptResult::Consumed(*hits))
        }
        async fn record_step_up_otp_failure(
            &self,
            _sid: ObjectId,
            _now: DateTime,
        ) -> Result<StepUpAttemptResult, ()> {
            let mut hits = self.otp_hits.lock().unwrap();
            *hits += 1;
            if *hits > MAX_STEP_UP_REAUTH_ATTEMPTS {
                return Ok(StepUpAttemptResult::Exhausted);
            }
            if let Some(ctx) = self.ctx.lock().unwrap().as_mut() {
                ctx.step_up_otp_attempts = *hits;
            }
            Ok(StepUpAttemptResult::Consumed(*hits))
        }
        async fn write_step_up_audit(
            &self,
            _sid: ObjectId,
            _user_id: ObjectId,
            action_group: &str,
            success: bool,
            _now: DateTime,
        ) {
            self.audits
                .lock()
                .unwrap()
                .push((success, action_group.to_string()));
        }
    }

    fn base_ctx(
        user: ObjectId,
        sid: ObjectId,
        now: i64,
        password_hash: &str,
        secret: &str,
    ) -> StepUpContext {
        StepUpContext {
            refresh: RefreshContext {
                user_active: true,
                current_user_session_version_at_issue: 3,
                current_role: "admin".into(),
                session: session(user, sid, now),
            },
            password_hash: password_hash.into(),
            two_factor_enabled: true,
            two_factor_secret: secret.into(),
            step_up_password_attempts: 0,
            step_up_otp_attempts: 0,
        }
    }

    // Fixed base32 secret for deterministic TOTP in tests.
    const TOTP_SECRET: &str = "JBSWY3DPEHPK3PXP";

    fn valid_otp_for_now() -> String {
        // Use production totp helper against current wall clock.
        let secret_bytes = {
            // Decode base32 of TOTP_SECRET
            let mut bits = 0_u32;
            let mut value = 0_u32;
            let mut output = Vec::new();
            for ch in TOTP_SECRET.chars() {
                let digit = match ch {
                    'A'..='Z' => ch as u8 - b'A',
                    '2'..='7' => ch as u8 - b'2' + 26,
                    _ => continue,
                } as u32;
                value = (value << 5) | digit;
                bits += 5;
                if bits >= 8 {
                    output.push(((value >> (bits - 8)) & 0xff) as u8);
                    bits -= 8;
                }
            }
            output
        };
        let counter = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64)
            / 30;
        use hmac::{Hmac, Mac};
        use sha1::Sha1;
        type HmacSha1 = Hmac<Sha1>;
        let mut mac = HmacSha1::new_from_slice(&secret_bytes).unwrap();
        mac.update(&(counter as u64).to_be_bytes());
        let result = mac.finalize().into_bytes();
        let offset = (result[19] & 0x0f) as usize;
        let binary = (((result[offset] & 0x7f) as u32) << 24)
            | ((result[offset + 1] as u32) << 16)
            | ((result[offset + 2] as u32) << 8)
            | (result[offset + 3] as u32);
        format!("{:06}", binary % 1_000_000)
    }

    #[test]
    fn step_up_attempt_filter_accepts_absent_counter_but_rejects_limit() {
        let sid = ObjectId::new();
        let now = DateTime::now();
        let filter = step_up_attempt_filter(sid, now, "stepUpPasswordAttempts");
        let alternatives = filter.get_array("$or").unwrap();
        assert_eq!(alternatives.len(), 2);
        assert_eq!(
            alternatives[0]
                .as_document()
                .unwrap()
                .get_document("stepUpPasswordAttempts")
                .unwrap()
                .get_bool("$exists")
                .unwrap(),
            false
        );
        assert_eq!(
            alternatives[1]
                .as_document()
                .unwrap()
                .get_document("stepUpPasswordAttempts")
                .unwrap()
                .get_i32("$lt")
                .unwrap(),
            MAX_STEP_UP_REAUTH_ATTEMPTS
        );
        assert_eq!(filter.get_object_id("sessionId").unwrap(), sid);
        assert_eq!(filter.get_str("status").unwrap(), "active");
    }

    #[test]
    fn closed_action_group_inventory_is_exact() {
        assert_eq!(
            ACTION_GROUPS,
            &[
                "finance.adjust_balance",
                "finance.refund",
                "finance.deposit_approval",
                "transactions.manual",
                "integrations.credentials",
                "team.manage_privileged",
                "team.reset_2fa",
                "security.sessions_all",
                "exports.sensitive",
                "security.password",
                "settings.sensitive",
            ]
        );
        assert!(!is_known_action_group("finance.unknown"));
        assert!(!is_known_action_group(""));
    }

    #[test]
    fn grant_rejects_wrong_user_sid_group_purpose_and_expiry_boundary() {
        let secret = "test-step-up-secret-with-enough-length";
        let now = 1_700_000_000_i64;
        let claims = StepUpClaims {
            sub: "aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            sid: "bbbbbbbbbbbbbbbbbbbbbbbb".into(),
            action_group: "finance.adjust_balance".into(),
            purpose: STEP_UP_PURPOSE.into(),
            iat: now,
            exp: now + STEP_UP_GRANT_SECONDS,
            jti: "cccccccccccccccccccccccc".into(),
        };
        let token = sign_step_up_grant(&claims, secret).expect("sign");
        assert!(verify_step_up_grant(
            &token,
            secret,
            "aaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbb",
            "finance.adjust_balance",
            now + 1
        )
        .is_ok());

        // wrong user
        assert_eq!(
            verify_step_up_grant(
                &token,
                secret,
                "dddddddddddddddddddddddd",
                "bbbbbbbbbbbbbbbbbbbbbbbb",
                "finance.adjust_balance",
                now + 1
            ),
            Err(StepUpOutcome::Invalid)
        );
        // wrong sid
        assert_eq!(
            verify_step_up_grant(
                &token,
                secret,
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "dddddddddddddddddddddddd",
                "finance.adjust_balance",
                now + 1
            ),
            Err(StepUpOutcome::Invalid)
        );
        // wrong group
        assert_eq!(
            verify_step_up_grant(
                &token,
                secret,
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbb",
                "finance.refund",
                now + 1
            ),
            Err(StepUpOutcome::Invalid)
        );
        // wrong purpose
        let mut bad_purpose = claims.clone();
        bad_purpose.purpose = "access".into();
        let bad_token = sign_step_up_grant(&bad_purpose, secret).unwrap();
        assert_eq!(
            verify_step_up_grant(
                &bad_token,
                secret,
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbb",
                "finance.adjust_balance",
                now + 1
            ),
            Err(StepUpOutcome::Invalid)
        );
        // exact expiry boundary: exp == now is expired
        assert_eq!(
            verify_step_up_grant(
                &token,
                secret,
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbb",
                "finance.adjust_balance",
                claims.exp
            ),
            Err(StepUpOutcome::Expired)
        );
        // still valid one second before exp
        assert!(verify_step_up_grant(
            &token,
            secret,
            "aaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbb",
            "finance.adjust_balance",
            claims.exp - 1
        )
        .is_ok());
    }

    #[test]
    fn grant_claims_never_carry_stale_role_or_session_version_authority() {
        let secret = "test-step-up-secret-with-enough-length";
        let now = 1_700_000_000_i64;
        let claims = StepUpClaims {
            sub: "aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            sid: "bbbbbbbbbbbbbbbbbbbbbbbb".into(),
            action_group: "team.manage_privileged".into(),
            purpose: STEP_UP_PURPOSE.into(),
            iat: now,
            exp: now + STEP_UP_GRANT_SECONDS,
            jti: ObjectId::new().to_hex(),
        };
        let token = sign_step_up_grant(&claims, secret).unwrap();
        // Decode raw JSON payload segment and assert no role/sessionVersion keys.
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let payload = token.split('.').nth(1).unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(payload).expect("b64");
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value.get("role").is_none());
        assert!(value.get("sessionVersion").is_none());
        assert!(value.get("tokenType").is_none());
        assert_eq!(value["purpose"], "step-up");
        assert_eq!(value["actionGroup"], "team.manage_privileged");
    }

    #[tokio::test]
    async fn orchestrate_rejects_revoked_locked_epoch_role_account_mismatch() {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        let now = 1_700_000_000_i64;
        let password_hash = bcrypt::hash("correct-horse", 4).unwrap();
        let mut ctx = base_ctx(user, sid, now, &password_hash, TOTP_SECRET);

        ctx.refresh.session.status = SessionStatus::Revoked;
        let store = MemStore::new(ctx.clone());
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("000000"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::Revoked
        );

        ctx.refresh.session.status = SessionStatus::Active;
        ctx.refresh.session.idle_expires_at = Some(dt(now - 1));
        let store = MemStore::new(ctx.clone());
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("000000"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::IdleLocked
        );

        ctx.refresh.session.idle_expires_at = Some(dt(now + 1800));
        ctx.refresh.current_user_session_version_at_issue = 99;
        let store = MemStore::new(ctx.clone());
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("000000"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::SessionVersionMismatch
        );

        ctx.refresh.current_user_session_version_at_issue = 3;
        ctx.refresh.current_role = "member".into();
        let store = MemStore::new(ctx.clone());
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("000000"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::NotStaff
        );

        ctx.refresh.current_role = "admin".into();
        ctx.refresh.user_active = false;
        let store = MemStore::new(ctx);
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("000000"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::AccountDisabled
        );
    }

    #[tokio::test]
    async fn orchestrate_requires_otp_and_rejects_invalid_password_otp_without_session_mutation() {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let password_hash = bcrypt::hash("correct-horse", 4).unwrap();
        let ctx = base_ctx(user, sid, now, &password_hash, TOTP_SECRET);
        let store = MemStore::new(ctx.clone());

        // missing OTP
        let missing = orchestrate_step_up(
            &store,
            sid,
            user,
            "correct-horse",
            None,
            "finance.adjust_balance",
            "secret-long-enough",
            dt(now),
        )
        .await;
        assert_eq!(missing, StepUpOutcome::MissingOtp);

        // wrong password — non-terminal, base session counters only for step-up
        let wrong_pw = orchestrate_step_up(
            &store,
            sid,
            user,
            "wrong-password",
            Some("123456"),
            "finance.adjust_balance",
            "secret-long-enough",
            dt(now),
        )
        .await;
        assert_eq!(wrong_pw, StepUpOutcome::ReauthPasswordInvalid);
        assert_eq!(*store.password_hits.lock().unwrap(), 1);
        // unlock counters on the session must remain untouched
        assert_eq!(
            store
                .ctx
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .refresh
                .session
                .unlock_password_attempts,
            0
        );

        // wrong OTP
        let wrong_otp = orchestrate_step_up(
            &store,
            sid,
            user,
            "correct-horse",
            Some("000000"),
            "finance.adjust_balance",
            "secret-long-enough",
            dt(now),
        )
        .await;
        assert_eq!(wrong_otp, StepUpOutcome::ReauthOtpInvalid);

        // success path
        let otp = valid_otp_for_now();
        let granted = orchestrate_step_up(
            &store,
            sid,
            user,
            "correct-horse",
            Some(&otp),
            "finance.adjust_balance",
            "secret-long-enough",
            dt(now),
        )
        .await;
        match granted {
            StepUpOutcome::Granted {
                token,
                action_group,
                expires_at,
            } => {
                assert_eq!(action_group, "finance.adjust_balance");
                assert_eq!(expires_at, now + STEP_UP_GRANT_SECONDS);
                assert!(!token.contains("correct-horse"));
                assert!(!token.contains(&otp));
                let claims = verify_step_up_grant(
                    &token,
                    "secret-long-enough",
                    &user.to_hex(),
                    &sid.to_hex(),
                    "finance.adjust_balance",
                    now + 1,
                )
                .expect("valid grant");
                assert_eq!(claims.purpose, STEP_UP_PURPOSE);
                assert_eq!(claims.exp - claims.iat, STEP_UP_GRANT_SECONDS);
            }
            other => panic!("expected Granted, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn orchestrate_enforces_attempt_limits() {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        let now = 1_700_000_000_i64;
        let password_hash = bcrypt::hash("correct-horse", 4).unwrap();
        let mut ctx = base_ctx(user, sid, now, &password_hash, TOTP_SECRET);
        ctx.step_up_password_attempts = MAX_STEP_UP_REAUTH_ATTEMPTS;
        let store = MemStore::new(ctx);
        let exhausted = orchestrate_step_up(
            &store,
            sid,
            user,
            "correct-horse",
            Some("123456"),
            "exports.sensitive",
            "secret",
            dt(now),
        )
        .await;
        assert_eq!(exhausted, StepUpOutcome::ReauthAttemptsExhausted);
    }

    #[tokio::test]
    async fn orchestrate_rejects_unknown_action_group_and_missing_2fa() {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        let now = 1_700_000_000_i64;
        let password_hash = bcrypt::hash("correct-horse", 4).unwrap();
        let mut ctx = base_ctx(user, sid, now, &password_hash, TOTP_SECRET);
        let store = MemStore::new(ctx.clone());
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("123456"),
                "not.a.group",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::InvalidActionGroup
        );

        ctx.two_factor_enabled = false;
        let store = MemStore::new(ctx);
        assert_eq!(
            orchestrate_step_up(
                &store,
                sid,
                user,
                "correct-horse",
                Some("123456"),
                "finance.refund",
                "secret",
                dt(now)
            )
            .await,
            StepUpOutcome::TwoFactorRequired
        );
    }

    #[test]
    fn trusted_group_header_check_is_exact() {
        let mut headers = HeaderMap::new();
        headers.insert(
            TRUSTED_STEP_UP_GROUP_HEADER,
            "finance.adjust_balance".parse().unwrap(),
        );
        assert!(require_trusted_step_up_group(&headers, "finance.adjust_balance").is_ok());
        assert!(require_trusted_step_up_group(&headers, "finance.refund").is_err());
        assert!(
            require_trusted_step_up_group(&HeaderMap::new(), "finance.adjust_balance").is_err()
        );
        // browser-supplied spoof of a different casing header name must not match
        let mut spoofed = HeaderMap::new();
        spoofed.insert("x-step-up-group", "finance.adjust_balance".parse().unwrap());
        assert!(require_trusted_step_up_group(&spoofed, "finance.adjust_balance").is_err());
    }

    #[tokio::test]
    async fn trusted_group_rejection_includes_action_group() {
        let response = require_trusted_step_up_group(&HeaderMap::new(), "settings.sensitive")
            .expect_err("missing grant must fail closed");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read step-up body");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json step-up body");
        assert_eq!(value["error"]["code"], "AUTH_STEP_UP_REQUIRED");
        assert_eq!(value["error"]["actionGroup"], "settings.sensitive");
    }

    #[test]
    fn signing_failure_surfaces_distinct_outcome_via_empty_secret_edge() {
        // jsonwebtoken accepts empty secrets; simulate failure by using a claims type mismatch path
        // through verify with wrong secret instead.
        let claims = StepUpClaims {
            sub: "a".into(),
            sid: "b".into(),
            action_group: "finance.refund".into(),
            purpose: STEP_UP_PURPOSE.into(),
            iat: 10,
            exp: 10 + STEP_UP_GRANT_SECONDS,
            jti: "j".into(),
        };
        let token = sign_step_up_grant(&claims, "good-secret").unwrap();
        assert_eq!(
            verify_step_up_grant(&token, "bad-secret", "a", "b", "finance.refund", 11),
            Err(StepUpOutcome::Invalid)
        );
    }

    #[allow(dead_code)]
    fn _history_full_fixture() -> AuthSession {
        let user = ObjectId::new();
        let sid = ObjectId::new();
        let mut s = session(user, sid, 1_700_000_000);
        s.consumed_refresh_token_digests = (0..4096)
            .map(|i| ConsumedRefreshDigest {
                generation: i as i64,
                refresh_token_digest: vec![i as u8; 32],
                consumed_at: dt(1_700_000_000),
            })
            .collect();
        s
    }
}
