use std::{env, sync::Arc};

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
use serde_json::json;

use super::security_change::{
    build_prepared_record, load_existing_security_change, orchestrate_security_change,
    prove_security_change_recovery_secret, security_change_outcome_error,
    DeterministicAccessClaims, InitiatingSessionRecoveryAuthority, MongoSecurityChangeStore,
    ProductionSecurityChangeCrypto, SecurityChangeKind, SecurityChangeOutcome,
    SecurityChangeProposalContext, SecurityChangeResult,
};
use super::{
    bounded_device_name, can_use_two_factor, current_user, errors::auth_error, internal_error,
    issue_session, now_seconds, read_i64, serialize_auth_user, status_message, unavailable,
};
use super::{jwt::*, logging::*, session_store::access_ttl_seconds, totp::*, types::*};
use crate::{
    security::{require_proxy_context, trusted_session_proof_matches},
    state::AppState,
    utils::bson::read_string,
};

fn login_audience_matches_user(audience: Option<LoginAudience>, role: &str) -> bool {
    audience.is_some_and(|value| value.accepts_role(role))
}

pub async fn two_factor_status(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(user_id) = context.user_id else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Unauthorized",
        );
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(object_id) = ObjectId::parse_str(user_id) else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    match client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": object_id })
        .await
    {
        Ok(Some(user)) => {
            let role = read_string(&user, "role");
            if !can_use_two_factor(&role) {
                return status_message(
                    axum::http::StatusCode::FORBIDDEN,
                    "2FA hanya tersedia untuk owner, admin, dan CS",
                );
            }
            // Report whether an enrollment is still resumable so a page reopened after the tab
            // was discarded can restore the code form instead of restarting setup. The secret
            // itself is never exposed here; the client re-requests it from /2fa/setup.
            let setup_pending = reusable_pending_secret(
                &read_string(&user, "twoFactorPendingSecret"),
                user.get_datetime("twoFactorPendingAt").ok().copied(),
                DateTime::now(),
            )
            .is_some();
            Json(json!({
                "enabled": user.get_bool("twoFactorEnabled").unwrap_or(false),
                "setupPending": setup_pending,
            }))
            .into_response()
        }
        Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "User not found"),
        Err(_) => internal_error(),
    }
}

pub async fn verify_two_factor_login(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<TwoFactorLoginPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let challenge_token = payload.challenge_token.unwrap_or_default();
    let code = normalize_otp_code(payload.code.as_deref());
    let (ip, user_agent) = client_info(&headers);
    if challenge_token.is_empty() || code.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Token verifikasi dan kode OTP wajib diisi",
        );
    }
    let claims = match decode_token(&challenge_token, &state.jwt_secret) {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::UNAUTHORIZED,
                "Sesi verifikasi 2FA tidak valid atau sudah kedaluwarsa",
            )
        }
    };
    let purpose = claims.purpose.as_deref().unwrap_or_default();
    if !purpose.starts_with("2fa-login:") || claims.id.is_empty() {
        return status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Sesi verifikasi 2FA tidak valid",
        );
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let Ok(user_id) = ObjectId::parse_str(&claims.id) else {
        return status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Verifikasi 2FA tidak tersedia",
        );
    };
    let user = match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .await
    {
        Ok(Some(user)) => user,
        _ => {
            return status_message(
                axum::http::StatusCode::UNAUTHORIZED,
                "Verifikasi 2FA tidak tersedia",
            )
        }
    };
    let current_role = read_string(&user, "role");
    if !login_audience_matches_user(claims.login_audience, &current_role) {
        return status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Sesi verifikasi 2FA tidak valid atau sudah kedaluwarsa",
        );
    }
    let audience = claims.login_audience.expect("audience preflight");
    let secret = read_string(&user, "twoFactorSecret");
    if user.get_bool("active") == Ok(false)
        || user.get_bool("twoFactorEnabled") != Ok(true)
        || secret.is_empty()
    {
        return status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Verifikasi 2FA tidak tersedia",
        );
    }
    if claims.session_version != super::read_i64(&user, "sessionVersion") {
        return status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Sesi verifikasi 2FA tidak valid atau sudah kedaluwarsa",
        );
    }
    if !is_valid_totp_code(&code, &secret) {
        write_login_log(
            &db,
            Some(&claims.id),
            &read_string(&user, "email"),
            Some(&read_string(&user, "role")),
            &ip,
            &user_agent,
            "failed",
            Some("Invalid 2FA code"),
        )
        .await;
        return auth_error(
            axum::http::StatusCode::BAD_REQUEST,
            "REAUTH_OTP_INVALID",
            "Kode OTP tidak valid",
        );
    }
    write_login_log(
        &db,
        Some(&claims.id),
        &read_string(&user, "email"),
        Some(&read_string(&user, "role")),
        &ip,
        &user_agent,
        "success",
        None,
    )
    .await;
    let mut parts = purpose.splitn(3, ':');
    let _ = parts.next();
    let remember_me = parts.next() == Some("true");
    let device_name = bounded_device_name(parts.next());
    if !super::refresh_issuance_enabled(&state, &user) {
        return super::issue_legacy_session_response(&state, &user, 200);
    }
    issue_session(
        &state,
        &db,
        &user,
        audience,
        remember_me,
        Some(&device_name),
        true,
        &headers,
        200,
    )
    .await
}

/// Lifetime of an unconfirmed enrollment secret. Mirrors the legacy Node gateway value so both
/// paths expire a pending setup at the same point.
pub(super) const TWO_FACTOR_PENDING_TTL_MS: i64 = 10 * 60 * 1000;

/// Returns the stored pending secret when it is still usable, otherwise `None`.
///
/// Setup used to mint a new secret on every call, which silently invalidated the secret the user
/// had just copied into their authenticator. On Android that is the normal path: copying the
/// secret backgrounds the tab, Chrome discards it, and reopening the page starts setup again.
///
/// Reusing a live pending secret keeps the authenticator entry valid. Anything unusable (absent
/// timestamp, elapsed TTL, malformed secret, or a clock that moved backwards) fails closed so a
/// fresh secret is issued instead.
pub(super) fn reusable_pending_secret(
    secret: &str,
    pending_at: Option<DateTime>,
    now: DateTime,
) -> Option<String> {
    let secret = secret.trim();
    // Must look like the base32 secret this service generates; never echo back junk.
    if secret.len() != 32
        || !secret
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    {
        return None;
    }
    let age_ms = now.timestamp_millis() - pending_at?.timestamp_millis();
    if age_ms < 0 || age_ms > TWO_FACTOR_PENDING_TTL_MS {
        return None;
    }
    Some(secret.to_string())
}

pub async fn two_factor_setup(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let (db, user_id, user) = match current_user(&headers, &state).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let role = read_string(&user, "role");
    if !can_use_two_factor(&role) {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "2FA hanya tersedia untuk owner, admin, dan CS",
        );
    }
    if user.get_bool("twoFactorEnabled").unwrap_or(false) {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "2FA sudah aktif");
    }
    let now = DateTime::now();
    // Keep a still-valid pending secret so an interrupted enrollment can be resumed with the
    // code already registered in the user's authenticator.
    let reused = reusable_pending_secret(
        &read_string(&user, "twoFactorPendingSecret"),
        user.get_datetime("twoFactorPendingAt").ok().copied(),
        now,
    );
    let resumed = reused.is_some();
    let secret = reused.unwrap_or_else(generate_totp_secret);
    if !resumed
        && db
            .collection::<Document>("users")
            .update_one(
                doc! { "_id": user_id },
                doc! { "$set": {
                    "twoFactorPendingSecret": &secret,
                    "twoFactorPendingAt": now,
                    "updatedAt": now,
                } },
            )
            .await
            .is_err()
    {
        return internal_error();
    }
    let issuer = env::var("APP_NAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "PPOB Admin".to_string());
    let email = read_string(&user, "email");
    let otpauth_url = format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}",
        url_encode(&issuer),
        url_encode(&email),
        secret,
        url_encode(&issuer)
    );
    super::security_audit::metric_two_factor_enrollment("required");
    let span_trace = crate::services::correlation::current_span_correlation_trace_id();
    let correlation = crate::services::correlation::resolve_correlation_untrusted(
        &headers,
        span_trace.as_deref(),
    );
    super::security_audit::write_security_audit(
        &db,
        super::security_audit::SecurityAuditEvent {
            event: super::security_audit::EVENT_TWO_FACTOR_ENROLLMENT,
            outcome: "required",
            user_id: Some(user_id),
            session_id: None,
            trace_id: correlation.trace_id,
            correlation_source: correlation.source.as_str(),
            action_group: None,
            reason: None,
            device: None,
        },
    )
    .await;
    Json(json!({
        "secret": secret,
        "otpauthUrl": otpauth_url,
        "qrCodeDataUrl": serde_json::Value::Null,
    }))
    .into_response()
}

fn recovery_proof_error(token: Option<&str>) -> Response {
    auth_error(
        axum::http::StatusCode::UNAUTHORIZED,
        "AUTH_TOKEN_INVALID",
        if token.unwrap_or("").is_empty() {
            "Recovery proof required"
        } else {
            "Invalid recovery proof"
        },
    )
}

async fn load_initiating_session(
    db: &mongodb::Database,
    user_id: ObjectId,
    sid: ObjectId,
) -> Result<Document, Response> {
    db.collection::<Document>(super::session_store::AUTH_SESSIONS_COLLECTION)
        .find_one(doc! { "sessionId": sid, "userId": user_id })
        .await
        .map_err(|_| internal_error())?
        .ok_or_else(|| {
            auth_error(
                axum::http::StatusCode::UNAUTHORIZED,
                "AUTH_TOKEN_INVALID",
                "Invalid session",
            )
        })
}

fn security_change_response(
    state: &AppState,
    user: &Document,
    outcome: SecurityChangeOutcome,
) -> Response {
    match outcome {
        SecurityChangeOutcome::Completed {
            result,
            credentials: Some(credentials),
        } => {
            emit_two_factor_security_metric(&result);
            (
                axum::http::StatusCode::OK,
                Json(json!({
                    "message": result.message,
                    "enabled": result.enabled,
                    "accessToken": credentials.access_token,
                    "refreshToken": credentials.refresh_token,
                    "recoveryToken": credentials.recovery_token,
                    "user": serialize_auth_user(user),
                })),
            )
                .into_response()
        }
        SecurityChangeOutcome::Completed {
            result,
            credentials: None,
        } => {
            emit_two_factor_security_metric(&result);
            (
                axum::http::StatusCode::OK,
                Json(json!({
                    "message": result.message,
                    "enabled": result.enabled,
                    "user": serialize_auth_user(user),
                })),
            )
                .into_response()
        }
        other => {
            let (status, code, message) = security_change_outcome_error(other);
            let _ = state;
            auth_error(status, code, message)
        }
    }
}

fn emit_two_factor_security_metric(result: &SecurityChangeResult) {
    if result.enabled {
        super::security_audit::metric_two_factor_enrollment("completed");
    } else {
        // Disable path: still a completed security change; enrollment metric uses completed/failed only.
        super::security_audit::metric_two_factor_enrollment("completed");
    }
    let _ = result;
}

async fn run_self_security_change(
    state: &AppState,
    db: &mongodb::Database,
    headers: &axum::http::HeaderMap,
    user_id: ObjectId,
    user: &Document,
    kind: SecurityChangeKind,
    method: &str,
    path: &str,
    recovery_token: Option<&str>,
    require_fresh_credentials: bool,
    validate_fresh: impl FnOnce() -> Result<(), Response>,
    result: SecurityChangeResult,
) -> Response {
    let context = match require_proxy_context(headers, state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(sid_hex) = context.session_id.as_deref() else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        );
    };
    let Ok(sid) = ObjectId::parse_str(sid_hex) else {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        );
    };
    if !trusted_session_proof_matches(&context, user_id, sid) {
        return auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        );
    }
    let existing = match load_existing_security_change(db, user_id).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let mut skip_fresh = false;
    if let Some(existing) = &existing {
        // After prepare, the account epoch advances; retries bind to the immutable stored
        // previous_epoch and initiator/kind/path/method rather than the live sessionVersion.
        let same_binding = existing.binding.initiating_sid == sid
            && existing.binding.kind == kind
            && existing.binding.target_user_id == user_id
            && existing.binding.method == method
            && existing.binding.path == path;
        if same_binding {
            // Exact recovery may skip password/OTP after proof-bound continuation.
            skip_fresh = true;
        } else {
            let (status, code, message) =
                security_change_outcome_error(SecurityChangeOutcome::Conflict);
            return auth_error(status, code, message);
        }
    }
    if require_fresh_credentials && !skip_fresh {
        if let Err(response) = validate_fresh() {
            return response;
        }
    }
    // Load the authoritative initiating session before any prepare mutation and prove the
    // recovery secret against its nextRecoverySecretDigest (fresh) or persisted continuationDigest
    // (exact retry). Never derive proof authority solely from the claimant secret.
    let session = match load_initiating_session(db, user_id, sid).await {
        Ok(session) => session,
        Err(response) => return response,
    };
    let role = read_string(user, "role");
    let now = DateTime::now();
    let live_epoch = read_i64(user, "sessionVersion");
    let generation = match session.get_i64("refreshGeneration") {
        Ok(value) if value >= 0 => value as u64,
        _ => return recovery_proof_error(recovery_token),
    };
    // Fresh prepare authority uses the live account security epoch. Exact retries re-check the
    // persisted continuation digest and keep the stored source generation/epoch bindings.
    let expected_security_epoch = existing
        .as_ref()
        .map(|record| record.binding.previous_epoch)
        .unwrap_or(live_epoch);
    let expected_generation = existing
        .as_ref()
        .map(|record| record.binding.source_recovery_generation)
        .unwrap_or(generation);
    // Fresh prepare requires an exact active initiating session (locked cannot bypass unlock).
    // Exact retries use persisted continuationDigest and do not re-require live active status.
    let authority = InitiatingSessionRecoveryAuthority {
        session_id: sid,
        user_id,
        expected_role: role.clone(),
        expected_security_epoch,
        expected_refresh_generation: expected_generation,
        now,
        require_active_status: existing.is_none(),
    };
    let recovery_secret = match prove_security_change_recovery_secret(
        recovery_token,
        sid,
        &session,
        &authority,
        &state.rotation_keys,
        existing.as_ref(),
    ) {
        Ok(secret) => secret,
        Err(()) => return recovery_proof_error(recovery_token),
    };
    let slot = match session.get_i32("slot") {
        Ok(slot) => slot,
        Err(_) => return internal_error(),
    };
    let absolute = match session.get_datetime("absoluteExpiresAt") {
        Ok(value) => *value,
        Err(_) => return internal_error(),
    };
    let now_s = now_seconds() as i64;
    let operation_id = existing
        .as_ref()
        .map(|record| record.binding.operation_id)
        .unwrap_or_else(ObjectId::new);
    let started_at = existing
        .as_ref()
        .map(|record| record.started_at)
        .unwrap_or(now);
    let previous_epoch = existing
        .as_ref()
        .map(|record| record.binding.previous_epoch)
        .unwrap_or(live_epoch);
    let source_recovery_generation = existing
        .as_ref()
        .map(|record| record.binding.source_recovery_generation)
        .unwrap_or(generation);
    let role_updated_at = user
        .get_datetime("roleUpdatedAt")
        .or_else(|_| user.get_datetime("updatedAt"))
        .map(|v| *v)
        .unwrap_or(now);
    let policy_updated_at = user
        .get_datetime("policyUpdatedAt")
        .or_else(|_| user.get_datetime("updatedAt"))
        .map(|v| *v)
        .unwrap_or(now);
    let claims = Some(DeterministicAccessClaims {
        jti: existing
            .as_ref()
            .and_then(|record| record.claims.as_ref().map(|c| c.jti.clone()))
            .unwrap_or_else(|| ObjectId::new().to_hex()),
        issued_at: existing
            .as_ref()
            .and_then(|record| record.claims.as_ref().map(|c| c.issued_at))
            .unwrap_or(now_s),
        expires_at: existing
            .as_ref()
            .and_then(|record| record.claims.as_ref().map(|c| c.expires_at))
            .unwrap_or(now_s + access_ttl_seconds(&role)),
    });
    let proposal = SecurityChangeProposalContext {
        user_id,
        target_user_id: user_id,
        authenticated_role: role,
        initiating_sid: sid,
        kind,
        method: method.into(),
        path: path.into(),
        previous_epoch,
        source_recovery_generation,
        result_sid: Some(sid),
        result_slot: Some(slot),
        started_at,
        source_absolute_expires_at: absolute,
        continuation_secret: recovery_secret,
        authoritative_role_updated_at: role_updated_at,
        authoritative_policy_updated_at: policy_updated_at,
        issue_result_session: true,
        result,
    };
    let proposed = if let Some(record) = existing {
        record
    } else {
        match build_prepared_record(
            &proposal,
            &state.rotation_keys,
            &state.recovery_encryption_keys,
            operation_id,
            claims,
        ) {
            Ok(record) => record,
            Err(_) => return internal_error(),
        }
    };
    let store = MongoSecurityChangeStore {
        database: db.clone(),
    };
    let crypto = ProductionSecurityChangeCrypto {
        rotation_keys: &state.rotation_keys,
        recovery_encryption_keys: &state.recovery_encryption_keys,
        jwt_secret: &state.jwt_secret,
    };
    let outcome =
        orchestrate_security_change(&store, &crypto, proposed, &recovery_secret, now).await;
    // Reload user for response envelope after transition.
    let updated = db
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| user.clone());
    security_change_response(state, &updated, outcome)
}

pub async fn two_factor_confirm(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TwoFactorCodePayload>,
) -> Response {
    let code = normalize_otp_code(payload.code.as_deref());
    if code.is_empty() {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Kode OTP wajib diisi");
    }
    let (db, user_id, user) = match current_user(&headers, &state).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !can_use_two_factor(&read_string(&user, "role")) {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "2FA hanya tersedia untuk owner, admin, dan CS",
        );
    }
    // An elapsed pending secret must not confirm, otherwise the 10 minute TTL is advisory only.
    // Treated as "not started": the caller restarts setup and gets a fresh secret.
    let pending_secret = reusable_pending_secret(
        &read_string(&user, "twoFactorPendingSecret"),
        user.get_datetime("twoFactorPendingAt").ok().copied(),
        DateTime::now(),
    )
    .unwrap_or_default();
    let existing = load_existing_security_change(&db, user_id)
        .await
        .ok()
        .flatten();
    if pending_secret.is_empty() && existing.is_none() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Setup 2FA belum dimulai",
        );
    }
    let recovery = payload.recovery_token.clone();
    run_self_security_change(
        &state,
        &db,
        &headers,
        user_id,
        &user,
        SecurityChangeKind::TwoFactorConfirm,
        "POST",
        "/api/v2/auth/2fa/confirm",
        recovery.as_deref(),
        true,
        || {
            if pending_secret.is_empty() {
                return Err(status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Setup 2FA belum dimulai",
                ));
            }
            if !is_valid_totp_code(&code, &pending_secret) {
                return Err(auth_error(
                    axum::http::StatusCode::BAD_REQUEST,
                    "REAUTH_OTP_INVALID",
                    "Kode OTP tidak valid",
                ));
            }
            Ok(())
        },
        SecurityChangeResult {
            enabled: true,
            message: "2FA berhasil diaktifkan".into(),
        },
    )
    .await
}

pub async fn two_factor_disable(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TwoFactorCodePayload>,
) -> Response {
    let code = normalize_otp_code(payload.code.as_deref());
    let password = payload.password.clone().unwrap_or_default();
    let (db, user_id, user) = match current_user(&headers, &state).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !can_use_two_factor(&read_string(&user, "role")) {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "2FA hanya tersedia untuk owner, admin, dan CS",
        );
    }
    let secret = read_string(&user, "twoFactorSecret");
    let recovery = payload.recovery_token.clone();
    run_self_security_change(
        &state,
        &db,
        &headers,
        user_id,
        &user,
        SecurityChangeKind::TwoFactorDisable,
        "POST",
        "/api/v2/auth/2fa/disable",
        recovery.as_deref(),
        true,
        || {
            if password.is_empty()
                || !bcrypt::verify(&password, &read_string(&user, "password")).unwrap_or(false)
            {
                return Err(auth_error(
                    axum::http::StatusCode::UNAUTHORIZED,
                    "REAUTH_PASSWORD_INVALID",
                    "Password tidak valid",
                ));
            }
            if user.get_bool("twoFactorEnabled").unwrap_or(false) && !secret.is_empty() {
                if code.is_empty() {
                    return Err(status_message(
                        axum::http::StatusCode::BAD_REQUEST,
                        "Kode OTP wajib diisi untuk menonaktifkan 2FA",
                    ));
                }
                if !is_valid_totp_code(&code, &secret) {
                    return Err(auth_error(
                        axum::http::StatusCode::BAD_REQUEST,
                        "REAUTH_OTP_INVALID",
                        "Kode OTP tidak valid",
                    ));
                }
            }
            Ok(())
        },
        SecurityChangeResult {
            enabled: false,
            message: "2FA berhasil dinonaktifkan".into(),
        },
    )
    .await
}

#[cfg(test)]
mod pending_setup_tests {
    use super::*;

    #[test]
    fn two_factor_login_audience_fails_closed_before_otp_flow() {
        assert!(!login_audience_matches_user(None, "member"));
        assert!(!login_audience_matches_user(
            Some(LoginAudience::Member),
            "admin"
        ));
        assert!(!login_audience_matches_user(
            Some(LoginAudience::Staff),
            "member"
        ));
        assert!(!login_audience_matches_user(
            Some(LoginAudience::Staff),
            "staff"
        ));
        assert!(login_audience_matches_user(
            Some(LoginAudience::Member),
            "member"
        ));
        for role in ["owner", "admin", "cs"] {
            assert!(login_audience_matches_user(
                Some(LoginAudience::Staff),
                role
            ));
        }
    }

    const MINUTE_MS: i64 = 60 * 1000;
    fn at(offset_ms: i64) -> DateTime {
        DateTime::from_millis(1_785_000_000_000 + offset_ms)
    }
    const SECRET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    #[test]
    fn fresh_pending_secret_is_reused_so_a_reopened_page_keeps_working() {
        // Copying the secret on Android backgrounds the tab and drops the page state. Reopening
        // setup must not mint a new secret, or the one already in the authenticator dies.
        assert_eq!(
            reusable_pending_secret(SECRET, Some(at(0)), at(9 * MINUTE_MS)),
            Some(SECRET.to_string())
        );
    }

    #[test]
    fn pending_secret_past_its_ttl_is_discarded() {
        assert_eq!(
            reusable_pending_secret(SECRET, Some(at(0)), at(11 * MINUTE_MS)),
            None
        );
    }

    #[test]
    fn the_ttl_boundary_is_inclusive() {
        assert_eq!(
            reusable_pending_secret(SECRET, Some(at(0)), at(TWO_FACTOR_PENDING_TTL_MS)),
            Some(SECRET.to_string())
        );
        assert_eq!(
            reusable_pending_secret(SECRET, Some(at(0)), at(TWO_FACTOR_PENDING_TTL_MS + 1)),
            None
        );
    }

    #[test]
    fn a_pending_secret_without_a_timestamp_is_never_reused() {
        // Legacy rows predate the timestamp; fail closed and issue a fresh secret.
        assert_eq!(reusable_pending_secret(SECRET, None, at(0)), None);
    }

    #[test]
    fn blank_or_malformed_secrets_are_never_reused() {
        assert_eq!(reusable_pending_secret("", Some(at(0)), at(0)), None);
        assert_eq!(reusable_pending_secret("   ", Some(at(0)), at(0)), None);
        assert_eq!(reusable_pending_secret("short", Some(at(0)), at(0)), None);
        assert_eq!(
            reusable_pending_secret("ABCDEFGH!JKLMNOPQRSTUVWXYZ234567", Some(at(0)), at(0)),
            None
        );
    }

    #[test]
    fn a_clock_that_moved_backwards_does_not_extend_the_window() {
        // Negative age is not "fresh": treat unusable timestamps as expired.
        assert_eq!(
            reusable_pending_secret(SECRET, Some(at(0)), at(-MINUTE_MS)),
            None
        );
    }
}
