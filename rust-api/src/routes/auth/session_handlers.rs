use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, spec::BinarySubtype, Binary, DateTime, Document};
use mongodb::options::{FindOneAndUpdateOptions, ReturnDocument};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;

use crate::{
    security::{require_proxy_context, trusted_session_proof_matches},
    state::AppState,
};

use super::{
    auth_error, internal_error, now_seconds, serialize_auth_user,
    session_store::{
        access_ttl_seconds, activity_status_session_projection, activity_status_user_projection,
        authoritative, bounded_session_summaries, decode_activity_status_user,
        orchestrate_global_revoke, orchestrate_logout, orchestrate_refresh,
        orchestrate_staff_activity, orchestrate_staff_activity_status, orchestrate_unlock,
        ActivityOutcome, ActivityStatusContext, ActivityStatusSession, ActivityStatusStore,
        ActivityStore, AuthSession, GlobalRevokeFinish, GlobalRevokePending, LogoutResult,
        RefreshContext, RefreshOutcome, RefreshStore, RevokeSessionResult, SessionManagementStore,
        UnlockAttemptResult, UnlockOutcome, UnlockProposal, UnlockStore, AUTH_SESSIONS_COLLECTION,
    },
    session_tokens::{encode_refresh_token, parse_refresh_token},
    sign_access_token,
    step_up::require_trusted_step_up_group,
    totp::normalize_otp_code,
    types::AccessClaims,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPayload {
    refresh_token: String,
    recovery_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutPayload {
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPayload {
    refresh_token: String,
    recovery_token: String,
    password: String,
    #[serde(default)]
    otp_code: Option<String>,
}

struct MongoRefreshStore<'a> {
    db: &'a mongodb::Database,
}

fn lock_eligible_filter(now: DateTime) -> mongodb::bson::Document {
    doc! {
        "$or": [
            { "status": "locked" },
            { "status": "active", "idleExpiresAt": { "$lte": now } }
        ]
    }
}

impl MongoRefreshStore<'_> {
    async fn record_unlock_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
        counter: &str,
    ) -> Result<UnlockAttemptResult, ()> {
        let mut filter = doc! {
            "sessionId": sid,
            counter: { "$lt": super::policy::MAX_UNLOCK_REAUTH_ATTEMPTS },
        };
        for (key, value) in lock_eligible_filter(now) {
            filter.insert(key, value);
        }
        let mut increment = Document::new();
        increment.insert(counter, 1_i32);
        let updated = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .find_one_and_update(filter, doc! { "$inc": increment })
            .with_options(
                FindOneAndUpdateOptions::builder()
                    .return_document(ReturnDocument::After)
                    .build(),
            )
            .await
            .map_err(|_| ())?;
        if let Some(updated) = updated {
            return Ok(UnlockAttemptResult::Consumed(
                updated.get_i32(counter).unwrap_or_default(),
            ));
        }
        let current = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid })
            .await
            .map_err(|_| ())?;
        Ok(match current {
            Some(session)
                if (counter == "unlockPasswordAttempts"
                    && session.unlock_password_attempts
                        >= super::policy::MAX_UNLOCK_REAUTH_ATTEMPTS)
                    || (counter == "unlockOtpAttempts"
                        && session.unlock_otp_attempts
                            >= super::policy::MAX_UNLOCK_REAUTH_ATTEMPTS) =>
            {
                UnlockAttemptResult::Exhausted
            }
            _ => UnlockAttemptResult::Miss,
        })
    }
}

impl UnlockStore for MongoRefreshStore<'_> {
    async fn load_unlock_context(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
    ) -> Result<Option<super::session_store::UnlockContext>, ()> {
        let session = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid, "userId": user_id })
            .await
            .map_err(|_| ())?;
        let Some(session) = session else {
            return Ok(None);
        };
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": user_id })
            .await
            .map_err(|_| ())?;
        let Some(user) = user else {
            return Ok(None);
        };
        Ok(Some(super::session_store::UnlockContext {
            refresh: RefreshContext {
                user_active: user.get_bool("active").unwrap_or(true),
                current_user_session_version_at_issue: user.get_i64("sessionVersion").unwrap_or(0),
                current_role: user.get_str("role").unwrap_or("member").to_string(),
                session,
            },
            password_hash: user.get_str("password").unwrap_or("").to_string(),
            two_factor_enabled: user.get_bool("twoFactorEnabled").unwrap_or(false),
            two_factor_secret: user.get_str("twoFactorSecret").unwrap_or("").to_string(),
        }))
    }

    async fn compare_and_unlock_with_successors(
        &self,
        p: &UnlockProposal,
    ) -> Result<super::session_store::CasInstallResult, ()> {
        let binary = |v: &[u8]| Binary {
            subtype: BinarySubtype::Generic,
            bytes: v.to_vec(),
        };
        let now = p.rotation.predecessor.committed_at;
        let mut filter = doc! {
            "sessionId": p.rotation.sid,
            "sessionVersionAtIssue": p.rotation.expected_session_version_at_issue,
            "refreshGeneration": p.rotation.expected_generation,
            "currentRefreshTokenDigest": binary(&p.rotation.expected_refresh_digest),
            "nextRecoverySecretDigest": binary(&p.rotation.expected_recovery_digest),
            "absoluteExpiresAt": { "$gt": now },
            "$expr": { "$lt": [{ "$size": "$consumedRefreshTokenDigests" }, 4096] }
        };
        for (key, value) in lock_eligible_filter(now) {
            filter.insert(key, value);
        }
        let result = self
            .db
            .collection::<Document>(AUTH_SESSIONS_COLLECTION)
            .update_one(
                filter,
                doc! {
                    "$set": {
                        "status": "active",
                        "lastSeenAt": now,
                        "lastUserActivityAt": now,
                        "idleExpiresAt": p.idle_expires_at,
                        "currentRefreshTokenDigest": binary(&p.rotation.successor_refresh_digest),
                        "nextRecoverySecretDigest": binary(&p.rotation.successor_recovery_digest),
                        "refreshGeneration": p.rotation.successor_generation,
                        "rotationDerivationVersion": "v1",
                        "rotationKeyId": &p.rotation.successor_key_id,
                        "immediatePredecessor": mongodb::bson::to_bson(&p.rotation.predecessor).map_err(|_| ())?,
                        "unlockPasswordAttempts": 0_i32,
                        "unlockOtpAttempts": 0_i32,
                    },
                    "$push": {
                        "consumedRefreshTokenDigests": mongodb::bson::to_bson(&super::session_store::ConsumedRefreshDigest {
                            generation: p.rotation.expected_generation,
                            refresh_token_digest: p.rotation.expected_refresh_digest.to_vec(),
                            consumed_at: now,
                        }).map_err(|_| ())?
                    }
                },
            )
            .await
            .map_err(|_| ())?;
        Ok(if result.modified_count == 1 {
            super::session_store::CasInstallResult::Installed
        } else {
            super::session_store::CasInstallResult::Miss
        })
    }

    async fn record_unlock_password_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<UnlockAttemptResult, ()> {
        self.record_unlock_failure(sid, now, "unlockPasswordAttempts")
            .await
    }

    async fn record_unlock_otp_failure(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<UnlockAttemptResult, ()> {
        self.record_unlock_failure(sid, now, "unlockOtpAttempts")
            .await
    }

    async fn write_unlock_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        success: bool,
        now: DateTime,
    ) {
        use super::security_audit::{
            metric_idle_outcome, write_security_audit, SecurityAuditEvent, EVENT_UNLOCK_FAILURE,
            EVENT_UNLOCK_SUCCESS,
        };
        let (event, outcome) = if success {
            metric_idle_outcome("unlocked");
            (EVENT_UNLOCK_SUCCESS, "success")
        } else {
            metric_idle_outcome("unlock_failed");
            (EVENT_UNLOCK_FAILURE, "failure")
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
                action_group: None,
                reason: None,
                device: None,
            },
        )
        .await;
    }
}

impl RefreshStore for MongoRefreshStore<'_> {
    async fn load_authoritative(&self, sid: ObjectId) -> Result<Option<RefreshContext>, ()> {
        let session = self
            .db
            .collection::<AuthSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid })
            .await
            .map_err(|_| ())?;
        let Some(session) = session else {
            return Ok(None);
        };
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": session.user_id })
            .await
            .map_err(|_| ())?;
        let Some(user) = user else { return Ok(None) };
        Ok(Some(RefreshContext {
            user_active: user.get_bool("active").unwrap_or(true),
            current_user_session_version_at_issue: user.get_i64("sessionVersion").unwrap_or(0),
            current_role: user.get_str("role").unwrap_or("member").to_string(),
            session,
        }))
    }

    async fn compare_and_install_successors(
        &self,
        p: &super::session_store::RotationProposal,
    ) -> Result<super::session_store::CasInstallResult, ()> {
        let binary = |v: &[u8]| Binary {
            subtype: BinarySubtype::Generic,
            bytes: v.to_vec(),
        };
        let result=self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(
            doc!{"sessionId":p.sid,"status":"active","sessionVersionAtIssue":p.expected_session_version_at_issue,"refreshGeneration":p.expected_generation,"currentRefreshTokenDigest":binary(&p.expected_refresh_digest),"nextRecoverySecretDigest":binary(&p.expected_recovery_digest),"absoluteExpiresAt":{"$gt":p.predecessor.committed_at},"$expr":{"$lt":[{"$size":"$consumedRefreshTokenDigests"},4096]}},
            doc!{"$set":{"currentRefreshTokenDigest":binary(&p.successor_refresh_digest),"nextRecoverySecretDigest":binary(&p.successor_recovery_digest),"refreshGeneration":p.successor_generation,"rotationDerivationVersion":"v1","rotationKeyId":&p.successor_key_id,"immediatePredecessor":mongodb::bson::to_bson(&p.predecessor).map_err(|_|())?,"lastSeenAt":p.predecessor.committed_at},"$push":{"consumedRefreshTokenDigests":mongodb::bson::to_bson(&super::session_store::ConsumedRefreshDigest{generation:p.expected_generation,refresh_token_digest:p.expected_refresh_digest.to_vec(),consumed_at:p.predecessor.committed_at}).map_err(|_|())?}}
        ).await.map_err(|_|())?;
        Ok(if result.modified_count == 1 {
            super::session_store::CasInstallResult::Installed
        } else {
            super::session_store::CasInstallResult::Miss
        })
    }
    async fn conditional_revoke_for_reuse(
        &self,
        sid: ObjectId,
        generation: i64,
        now: DateTime,
    ) -> Result<super::session_store::ConditionalRevokeResult, ()> {
        let r=self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(doc!{"sessionId":sid,"status":"active","refreshGeneration":generation},doc!{"$set":{"status":"revoked","ownsSlot":false,"revokedAt":now,"revokeReason":"refresh_reuse"}}).await.map_err(|_|())?;
        Ok(if r.modified_count == 1 {
            super::session_store::ConditionalRevokeResult::RevokedOne
        } else {
            super::session_store::ConditionalRevokeResult::ModifiedZero
        })
    }
    async fn write_reuse_audit(
        &self,
        sid: ObjectId,
        user_id: ObjectId,
        revoked: bool,
        now: DateTime,
    ) {
        use super::security_audit::{
            write_security_audit, SecurityAuditEvent, EVENT_REFRESH_REUSE_OBSERVED,
            EVENT_REFRESH_REUSE_REVOKED,
        };
        let (event, outcome) = if revoked {
            (EVENT_REFRESH_REUSE_REVOKED, "revoked")
        } else {
            (EVENT_REFRESH_REUSE_OBSERVED, "observed")
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
                action_group: None,
                reason: Some("refresh_reuse"),
                device: None,
            },
        )
        .await;
    }
    async fn logout(
        &self,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<super::session_store::LogoutResult, ()> {
        let r=self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(doc!{"sessionId":sid,"status":{"$ne":"revoked"}},doc!{"$set":{"status":"revoked","ownsSlot":false,"revokedAt":now,"revokeReason":"logout"}}).await.map_err(|_|())?;
        Ok(if r.modified_count == 1 {
            super::session_store::LogoutResult::RevokedNow
        } else {
            super::session_store::LogoutResult::AlreadyTerminal
        })
    }
}

struct MongoActivityStatusStore<'a> {
    db: &'a mongodb::Database,
}

impl ActivityStatusStore for MongoActivityStatusStore<'_> {
    async fn load_activity_status_context(
        &self,
        sid: ObjectId,
    ) -> Result<Option<ActivityStatusContext>, ()> {
        let session = self
            .db
            .collection::<ActivityStatusSession>(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid })
            .projection(activity_status_session_projection())
            .await
            .map_err(|_| ())?;
        let Some(session) = session else {
            return Ok(None);
        };
        let user = self
            .db
            .collection::<Document>("users")
            .find_one(doc! { "_id": session.user_id })
            .projection(activity_status_user_projection())
            .await
            .map_err(|_| ())?;
        let Some(user) = user else {
            return Ok(None);
        };
        let user_row = match decode_activity_status_user(&user) {
            Ok(row) => row,
            Err(()) => return Ok(None),
        };
        Ok(Some(ActivityStatusContext {
            user_active: user_row.active,
            current_user_session_version_at_issue: user_row.session_version,
            current_role: user_row.role,
            session,
        }))
    }
}

struct MongoActivityStore<'a> {
    db: &'a mongodb::Database,
}

impl ActivityStore for MongoActivityStore<'_> {
    async fn load_activity_session(&self, sid: ObjectId) -> Result<Option<AuthSession>, ()> {
        self.db
            .collection(AUTH_SESSIONS_COLLECTION)
            .find_one(doc! { "sessionId": sid })
            .await
            .map_err(|_| ())
    }
    async fn compare_and_record_activity(
        &self,
        sid: ObjectId,
        previous: DateTime,
        now: DateTime,
        idle: DateTime,
    ) -> Result<bool, ()> {
        let result = self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(
            doc! { "sessionId":sid, "status":"active", "lastSeenAt":previous, "absoluteExpiresAt":{"$gt":now}, "idleExpiresAt":{"$gt":now} },
            doc! { "$set": { "lastSeenAt":now, "lastUserActivityAt":now, "idleExpiresAt":idle } }
        ).await.map_err(|_| ())?;
        Ok(result.modified_count == 1)
    }
    async fn compare_and_lock_idle(&self, sid: ObjectId, now: DateTime) -> Result<bool, ()> {
        let result = self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_one(
            doc! { "sessionId":sid, "status":"active", "absoluteExpiresAt":{"$gt":now}, "idleExpiresAt":{"$lte":now} },
            doc! { "$set": { "status":"locked", "lockedAt":now } }
        ).await.map_err(|_| ())?;
        Ok(result.modified_count == 1)
    }
}

pub async fn activity(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (_, sid) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    match orchestrate_staff_activity(&MongoActivityStore { db: &db }, sid, DateTime::now()).await {
        ActivityOutcome::Recorded {
            warning_at,
            idle_expires_at,
        }
        | ActivityOutcome::Throttled {
            warning_at,
            idle_expires_at,
        } => (
            StatusCode::OK,
            Json(activity_deadlines_json(warning_at, idle_expires_at)),
        )
            .into_response(),
        ActivityOutcome::IdleLocked => auth_error(
            StatusCode::LOCKED,
            "AUTH_IDLE_LOCKED",
            "Session idle locked",
        ),
        ActivityOutcome::Expired => auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_EXPIRED",
            "Session expired",
        ),
        ActivityOutcome::Invalid | ActivityOutcome::NotStaff => auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        ),
        ActivityOutcome::Revoked
        | ActivityOutcome::AccountDisabled
        | ActivityOutcome::SessionVersionMismatch => auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        ),
        ActivityOutcome::Store => internal_error(),
    }
}

fn activity_deadlines_json(warning_at: DateTime, idle_expires_at: DateTime) -> serde_json::Value {
    json!({
        "ok": true,
        "warningAt": warning_at.timestamp_millis(),
        "idleExpiresAt": idle_expires_at.timestamp_millis(),
    })
}

fn activity_status_error(outcome: ActivityOutcome) -> Response {
    let (status, code, message) = match outcome {
        ActivityOutcome::IdleLocked => (
            StatusCode::LOCKED,
            "AUTH_IDLE_LOCKED",
            "Session idle locked",
        ),
        ActivityOutcome::Expired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_EXPIRED",
            "Session expired",
        ),
        ActivityOutcome::Revoked => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_REVOKED",
            "Session revoked",
        ),
        ActivityOutcome::AccountDisabled => (
            StatusCode::UNAUTHORIZED,
            "AUTH_ACCOUNT_DISABLED",
            "Account disabled",
        ),
        ActivityOutcome::SessionVersionMismatch => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_POLICY_CHANGED",
            "Session policy changed",
        ),
        ActivityOutcome::Invalid | ActivityOutcome::NotStaff => (
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid session",
        ),
        _ => return internal_error(),
    };
    auth_error(status, code, message)
}

pub async fn activity_status(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (user_id, sid) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let outcome = orchestrate_staff_activity_status(
        &MongoActivityStatusStore { db: &db },
        sid,
        user_id,
        DateTime::now(),
    )
    .await;
    match outcome {
        ActivityOutcome::Recorded {
            warning_at,
            idle_expires_at,
        }
        | ActivityOutcome::Throttled {
            warning_at,
            idle_expires_at,
        } => (
            StatusCode::OK,
            Json(activity_deadlines_json(warning_at, idle_expires_at)),
        )
            .into_response(),
        ActivityOutcome::IdleLocked
        | ActivityOutcome::Expired
        | ActivityOutcome::Revoked
        | ActivityOutcome::AccountDisabled
        | ActivityOutcome::SessionVersionMismatch
        | ActivityOutcome::Invalid
        | ActivityOutcome::NotStaff => activity_status_error(outcome),
        ActivityOutcome::Store => internal_error(),
    }
}

#[cfg(test)]
mod activity_deadline_wire_tests {
    use super::*;

    #[test]
    fn activity_deadlines_are_epoch_millisecond_numbers() {
        let payload = activity_deadlines_json(
            DateTime::from_millis(1_700_000_000_000),
            DateTime::from_millis(1_700_000_300_000),
        );
        assert_eq!(payload["warningAt"].as_i64(), Some(1_700_000_000_000));
        assert_eq!(payload["idleExpiresAt"].as_i64(), Some(1_700_000_300_000));
    }
}

struct MongoSessionManagementStore<'a> {
    db: &'a mongodb::Database,
}

impl SessionManagementStore for MongoSessionManagementStore<'_> {
    async fn revoke_owned(
        &self,
        user_id: ObjectId,
        sid: ObjectId,
        now: DateTime,
    ) -> Result<RevokeSessionResult, ()> {
        let sessions = self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION);
        let exists = sessions
            .find_one(doc! { "sessionId": sid })
            .await
            .map_err(|_| ())?;
        let Some(row) = exists else {
            return Ok(RevokeSessionResult::NotOwned);
        };
        if row.get_object_id("userId").ok() != Some(user_id) {
            return Ok(RevokeSessionResult::NotOwned);
        }
        let result = sessions.update_one(doc! { "sessionId":sid, "userId":user_id, "status":{"$ne":"revoked"} }, doc! { "$set": { "status":"revoked", "ownsSlot":false, "revokedAt":now, "revokeReason":"device_revoked" } }).await.map_err(|_| ())?;
        Ok(if result.modified_count == 1 {
            RevokeSessionResult::RevokedNow
        } else {
            RevokeSessionResult::AlreadyTerminal
        })
    }
    async fn begin_global(
        &self,
        user_id: ObjectId,
        proposed: ObjectId,
        now: DateTime,
    ) -> Result<GlobalRevokePending, ()> {
        let users = self.db.collection::<Document>("users");
        let existing = users
            .find_one(doc! { "_id":user_id, "globalRevocationPending":{"$exists":true} })
            .await
            .map_err(|_| ())?;
        if let Some(user) = existing {
            let pending = user
                .get_document("globalRevocationPending")
                .map_err(|_| ())?;
            return Ok(GlobalRevokePending {
                operation_id: pending.get_object_id("operationId").map_err(|_| ())?,
                session_version: pending.get_i64("sessionVersion").map_err(|_| ())?,
            });
        }
        let updated = users.find_one_and_update(doc! { "_id":user_id, "globalRevocationPending":{"$exists":false} }, vec![doc! { "$set": { "sessionVersion": { "$add": [{ "$ifNull":["$sessionVersion", 0_i64] }, 1_i64] }, "globalRevocationPending": { "operationId":proposed, "sessionVersion": { "$add": [{ "$ifNull":["$sessionVersion", 0_i64] }, 1_i64] }, "startedAt":now } } }]).with_options(FindOneAndUpdateOptions::builder().return_document(ReturnDocument::After).build()).await.map_err(|_| ())?;
        let user = match updated {
            Some(user) => user,
            None => users
                .find_one(doc! { "_id":user_id })
                .await
                .map_err(|_| ())?
                .ok_or(())?,
        };
        let pending = user
            .get_document("globalRevocationPending")
            .map_err(|_| ())?;
        Ok(GlobalRevokePending {
            operation_id: pending.get_object_id("operationId").map_err(|_| ())?,
            session_version: pending.get_i64("sessionVersion").map_err(|_| ())?,
        })
    }
    async fn revoke_all(
        &self,
        user_id: ObjectId,
        operation_id: ObjectId,
        now: DateTime,
    ) -> Result<(), ()> {
        self.db.collection::<Document>(AUTH_SESSIONS_COLLECTION).update_many(doc! { "userId":user_id, "status":{"$in":["active","locked"]} }, doc! { "$set": { "status":"revoked", "ownsSlot":false, "revokedAt":now, "revokeReason":"global_logout", "globalRevocationOperationId":operation_id } }).await.map_err(|_| ())?;
        Ok(())
    }
    async fn finish_global(
        &self,
        user_id: ObjectId,
        operation_id: ObjectId,
        operation_epoch: i64,
        _now: DateTime,
    ) -> Result<GlobalRevokeFinish, ()> {
        let users = self.db.collection::<Document>("users");
        let result = users
            .update_one(
                doc! { "_id":user_id, "globalRevocationPending.operationId":operation_id },
                vec![doc! { "$set": {
                    "completedGlobalRevocation": {
                        "operationId": operation_id,
                        "sessionVersion": "$globalRevocationPending.sessionVersion",
                        "completedAt": _now,
                    },
                    "globalRevocationPending": "$$REMOVE",
                } }],
            )
            .await
            .map_err(|_| ())?;
        if result.modified_count == 1 {
            return Ok(GlobalRevokeFinish::Completed(operation_epoch));
        }
        let user = users
            .find_one(doc! { "_id":user_id })
            .await
            .map_err(|_| ())?
            .ok_or(())?;
        if let Ok(completed) = user.get_document("completedGlobalRevocation") {
            if completed.get_object_id("operationId").ok() == Some(operation_id) {
                return Ok(GlobalRevokeFinish::AlreadyCompleted(
                    completed.get_i64("sessionVersion").map_err(|_| ())?,
                ));
            }
        }
        if let Ok(pending) = user.get_document("globalRevocationPending") {
            return Ok(GlobalRevokeFinish::Follow(GlobalRevokePending {
                operation_id: pending.get_object_id("operationId").map_err(|_| ())?,
                session_version: pending.get_i64("sessionVersion").map_err(|_| ())?,
            }));
        }
        Err(())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeDevicePayload {
    session_id: String,
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (user_id, sid) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    match super::session_store::active_sessions_for_display(
        &client.database(&state.mongo_db),
        user_id,
    )
    .await
    {
        Ok(rows) => (
            StatusCode::OK,
            Json(json!({ "sessions": bounded_session_summaries(rows, sid) })),
        )
            .into_response(),
        Err(_) => internal_error(),
    }
}

pub async fn revoke_device(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<RevokeDevicePayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (user_id, _) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Ok(target) = ObjectId::parse_str(payload.session_id) else {
        return auth_error(
            StatusCode::BAD_REQUEST,
            "AUTH_SESSION_INVALID",
            "Invalid session",
        );
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    match (MongoSessionManagementStore { db: &db })
        .revoke_owned(user_id, target, DateTime::now())
        .await
    {
        Ok(RevokeSessionResult::NotOwned) => auth_error(
            StatusCode::NOT_FOUND,
            "AUTH_SESSION_NOT_FOUND",
            "Session not found",
        ),
        Ok(result) => {
            if matches!(result, RevokeSessionResult::RevokedNow) {
                let span_trace = crate::services::correlation::current_span_correlation_trace_id();
                let correlation = crate::services::correlation::resolve_correlation_untrusted(
                    &headers,
                    span_trace.as_deref(),
                );
                super::security_audit::write_security_audit(
                    &db,
                    super::security_audit::SecurityAuditEvent {
                        event: super::security_audit::EVENT_DEVICE_REVOKED,
                        outcome: "success",
                        user_id: Some(user_id),
                        session_id: Some(target),
                        trace_id: correlation.trace_id,
                        correlation_source: correlation.source.as_str(),
                        action_group: None,
                        reason: Some("user_revoke"),
                        device: None,
                    },
                )
                .await;
            }
            (StatusCode::OK, Json(json!({"ok":true}))).into_response()
        }
        Err(_) => internal_error(),
    }
}

pub async fn revoke_current(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (user_id, sid) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    match (MongoSessionManagementStore { db: &db })
        .revoke_owned(user_id, sid, DateTime::now())
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({"ok":true}))).into_response(),
        Err(_) => internal_error(),
    }
}

pub async fn revoke_all(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (user_id, _) = match trusted_ids(&context) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "security.sessions_all") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    match orchestrate_global_revoke(
        &MongoSessionManagementStore { db: &db },
        user_id,
        DateTime::now(),
    )
    .await
    {
        Ok(_) => {
            let span_trace = crate::services::correlation::current_span_correlation_trace_id();
            let correlation = crate::services::correlation::resolve_correlation_untrusted(
                &headers,
                span_trace.as_deref(),
            );
            super::security_audit::write_security_audit(
                &db,
                super::security_audit::SecurityAuditEvent {
                    event: super::security_audit::EVENT_LOGOUT_ALL,
                    outcome: "success",
                    user_id: Some(user_id),
                    session_id: None,
                    trace_id: correlation.trace_id,
                    correlation_source: correlation.source.as_str(),
                    action_group: None,
                    reason: Some("global_logout"),
                    device: None,
                },
            )
            .await;
            (StatusCode::OK, Json(json!({"ok":true}))).into_response()
        }
        Err(_) => auth_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_GLOBAL_REVOCATION_PENDING",
            "Logout all is being finalized",
        ),
    }
}

async fn unlock_success_response(
    state: &AppState,
    store: &MongoRefreshStore<'_>,
    db: &mongodb::Database,
    sid: ObjectId,
    credentials: &super::session_store::RefreshCredentials,
    now: DateTime,
) -> Response {
    let Ok(Some(context)) = store.load_authoritative(sid).await else {
        return internal_error();
    };
    if let Some(outcome) = authoritative(&context, now) {
        return unlock_outcome_error(map_refresh_to_unlock_handler(outcome));
    }
    let Ok(Some(user)) = db
        .collection::<Document>("users")
        .find_one(doc! { "_id": context.session.user_id })
        .await
    else {
        return internal_error();
    };
    let now_s = now.timestamp_millis() / 1000;
    let claims = AccessClaims {
        sub: context.session.user_id.to_hex(),
        sid: sid.to_hex(),
        session_version: context.session.session_version_at_issue,
        role: context.current_role.clone(),
        iat: now_s,
        exp: now_s + access_ttl_seconds(&context.current_role),
        jti: ObjectId::new().to_hex(),
        token_type: "access".into(),
    };
    let Ok(access) = sign_access_token(&claims, &state.jwt_secret) else {
        return internal_error();
    };
    let Ok(refresh_token) = encode_refresh_token(&sid.to_hex(), &credentials.refresh) else {
        return internal_error();
    };
    let Ok(recovery_token) = encode_refresh_token(&sid.to_hex(), &credentials.recovery) else {
        return internal_error();
    };
    (StatusCode::OK, Json(json!({
        "accessToken": access,
        "refreshToken": refresh_token,
        "recoveryToken": recovery_token,
        "refreshCookieMaxAgeSeconds": (context.session.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
        "recoveryCookieMaxAgeSeconds": (context.session.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
        "session": {
            "sid": sid.to_hex(),
            "roleClass": "staff",
            "accessExpiresAt": DateTime::from_millis(claims.exp * 1000).try_to_rfc3339_string().unwrap_or_default(),
        },
        "user": serialize_auth_user(&user)
    }))).into_response()
}

fn map_refresh_to_unlock_handler(outcome: RefreshOutcome) -> UnlockOutcome {
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

pub async fn unlock(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<UnlockPayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (user_id, trusted_sid) = match trusted_ids(&context) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Ok((refresh_sid, refresh)) = parse_refresh_token(&payload.refresh_token) else {
        return unlock_outcome_error(UnlockOutcome::Invalid);
    };
    let Ok((recovery_sid, recovery)) = parse_refresh_token(&payload.recovery_token) else {
        return unlock_outcome_error(UnlockOutcome::Invalid);
    };
    let canonical_sid = trusted_sid.to_hex();
    if refresh_sid != canonical_sid || recovery_sid != canonical_sid {
        return unlock_outcome_error(UnlockOutcome::Invalid);
    }
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let store = MongoRefreshStore { db: &db };
    let now = DateTime::now();
    match orchestrate_unlock(
        &store,
        trusted_sid,
        user_id,
        refresh,
        recovery,
        &payload.password,
        payload.otp_code.as_deref(),
        &state.rotation_keys,
        &state.recovery_encryption_keys,
        now,
    )
    .await
    {
        UnlockOutcome::Unlocked { credentials } | UnlockOutcome::Recovered { credentials } => {
            unlock_success_response(&state, &store, &db, trusted_sid, &credentials, now).await
        }
        outcome => unlock_outcome_error(outcome),
    }
}

fn unlock_outcome_error(outcome: UnlockOutcome) -> Response {
    let (status, code, message) = match outcome {
        UnlockOutcome::ReauthPasswordInvalid => (
            StatusCode::BAD_REQUEST,
            "REAUTH_PASSWORD_INVALID",
            "Password tidak valid",
        ),
        UnlockOutcome::ReauthOtpInvalid => (
            StatusCode::BAD_REQUEST,
            "REAUTH_OTP_INVALID",
            "Kode OTP tidak valid",
        ),
        UnlockOutcome::ReauthAttemptsExhausted => (
            StatusCode::BAD_REQUEST,
            "REAUTH_ATTEMPTS_EXHAUSTED",
            "Percobaan unlock terlalu banyak",
        ),
        UnlockOutcome::ConcurrentPredecessor => (
            StatusCode::CONFLICT,
            "AUTH_REFRESH_RACE",
            "Unlock already rotated",
        ),
        UnlockOutcome::RecoveryExpired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_REFRESH_RECOVERY_EXPIRED",
            "Refresh recovery expired",
        ),
        UnlockOutcome::RecoveryUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
            "Refresh recovery temporarily unavailable",
        ),
        UnlockOutcome::Expired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_EXPIRED",
            "Session expired",
        ),
        UnlockOutcome::Revoked => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_REVOKED",
            "Session revoked",
        ),
        UnlockOutcome::AccountDisabled => (
            StatusCode::UNAUTHORIZED,
            "AUTH_ACCOUNT_DISABLED",
            "Account disabled",
        ),
        UnlockOutcome::SessionVersionMismatch => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_POLICY_CHANGED",
            "Session policy changed",
        ),
        UnlockOutcome::Reused => (
            StatusCode::UNAUTHORIZED,
            "AUTH_REFRESH_REUSED",
            "Refresh token reused",
        ),
        UnlockOutcome::Invalid | UnlockOutcome::NotLockEligible | UnlockOutcome::NotStaff => (
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid unlock request",
        ),
        UnlockOutcome::HistoryFull => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_SESSION_HISTORY_FULL",
            "Session unlock unavailable",
        ),
        UnlockOutcome::Store | UnlockOutcome::Unlocked { .. } | UnlockOutcome::Recovered { .. } => {
            return internal_error()
        }
    };
    auth_error(status, code, message)
}

fn outcome_error(outcome: RefreshOutcome) -> Response {
    let (status, code, message) = match outcome {
        RefreshOutcome::ConcurrentPredecessor => (
            StatusCode::CONFLICT,
            "AUTH_REFRESH_RACE",
            "Refresh already rotated",
        ),
        RefreshOutcome::Reused => (
            StatusCode::UNAUTHORIZED,
            "AUTH_REFRESH_REUSED",
            "Refresh token reused",
        ),
        RefreshOutcome::Expired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_EXPIRED",
            "Session expired",
        ),
        RefreshOutcome::Revoked => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_REVOKED",
            "Session revoked",
        ),
        RefreshOutcome::AccountDisabled => (
            StatusCode::UNAUTHORIZED,
            "AUTH_ACCOUNT_DISABLED",
            "Account disabled",
        ),
        RefreshOutcome::SessionVersionMismatch => (
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_POLICY_CHANGED",
            "Session policy changed",
        ),
        RefreshOutcome::IdleLocked => (
            StatusCode::LOCKED,
            "AUTH_IDLE_LOCKED",
            "Session idle locked",
        ),
        RefreshOutcome::Invalid => (
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid refresh token",
        ),
        RefreshOutcome::HistoryFull => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_SESSION_HISTORY_FULL",
            "Session refresh unavailable",
        ),
        RefreshOutcome::RecoveryExpired => (
            StatusCode::UNAUTHORIZED,
            "AUTH_REFRESH_RECOVERY_EXPIRED",
            "Refresh recovery expired",
        ),
        RefreshOutcome::RecoveryUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
            "Refresh recovery temporarily unavailable",
        ),
        RefreshOutcome::Store
        | RefreshOutcome::Rotated { .. }
        | RefreshOutcome::Recovered { .. } => return internal_error(),
    };
    auth_error(status, code, message)
}

pub async fn refresh(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<RefreshPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Ok((sid_hex, secret)) = parse_refresh_token(&payload.refresh_token) else {
        return outcome_error(RefreshOutcome::Invalid);
    };
    let Ok(sid) = ObjectId::parse_str(&sid_hex) else {
        return outcome_error(RefreshOutcome::Invalid);
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let store = MongoRefreshStore { db: &db };
    let now = DateTime::from_millis((now_seconds() as i64) * 1000);
    let Ok((recovery_sid, recovery)) = parse_refresh_token(&payload.recovery_token) else {
        return outcome_error(RefreshOutcome::Invalid);
    };
    if recovery_sid != sid_hex {
        return outcome_error(RefreshOutcome::Invalid);
    }
    match orchestrate_refresh(
        &store,
        sid,
        secret,
        recovery,
        &state.rotation_keys,
        &state.recovery_encryption_keys,
        now,
    )
    .await
    {
        RefreshOutcome::Rotated { credentials } | RefreshOutcome::Recovered { credentials } => {
            let Ok(Some(context)) = store.load_authoritative(sid).await else {
                return internal_error();
            };
            if let Some(outcome) = authoritative(&context, now) {
                return outcome_error(outcome);
            }
            let Ok(Some(user)) = db
                .collection::<Document>("users")
                .find_one(doc! { "_id": context.session.user_id })
                .await
            else {
                return internal_error();
            };
            let now_s = now.timestamp_millis() / 1000;
            let claims = AccessClaims {
                sub: context.session.user_id.to_hex(),
                sid: sid.to_hex(),
                session_version: context.session.session_version_at_issue,
                role: context.current_role.clone(),
                iat: now_s,
                exp: now_s + access_ttl_seconds(&context.current_role),
                jti: ObjectId::new().to_hex(),
                token_type: "access".into(),
            };
            let Ok(access) = sign_access_token(&claims, &state.jwt_secret) else {
                return internal_error();
            };
            let Ok(refresh_token) = encode_refresh_token(&sid.to_hex(), &credentials.refresh)
            else {
                return internal_error();
            };
            let Ok(recovery_token) = encode_refresh_token(&sid.to_hex(), &credentials.recovery)
            else {
                return internal_error();
            };
            (StatusCode::OK, Json(json!({ "accessToken": access, "refreshToken": refresh_token, "recoveryToken": recovery_token,
                "refreshCookieMaxAgeSeconds": (context.session.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
                "recoveryCookieMaxAgeSeconds": (context.session.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
                "user": serialize_auth_user(&user) }))).into_response()
        }
        other => outcome_error(other),
    }
}

pub async fn logout(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LogoutPayload>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Ok((sid_hex, _)) = parse_refresh_token(&payload.refresh_token) else {
        return outcome_error(RefreshOutcome::Invalid);
    };
    let Ok(sid) = ObjectId::parse_str(sid_hex) else {
        return outcome_error(RefreshOutcome::Invalid);
    };
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    // Resolve the actor from the trusted session record before revocation so the
    // audit event retains the authenticated subject without trusting client input.
    let actor_id = db
        .collection::<Document>(AUTH_SESSIONS_COLLECTION)
        .find_one(doc! { "sessionId": sid })
        .await
        .ok()
        .flatten()
        .and_then(|session| session.get_object_id("userId").ok());
    match orchestrate_logout(&MongoRefreshStore { db: &db }, sid, DateTime::now()).await {
        Ok(result) => {
            let span_trace = crate::services::correlation::current_span_correlation_trace_id();
            let correlation = crate::services::correlation::resolve_correlation_untrusted(
                &headers,
                span_trace.as_deref(),
            );
            super::security_audit::write_security_audit(
                &db,
                super::security_audit::SecurityAuditEvent {
                    event: super::security_audit::EVENT_LOGOUT_CURRENT,
                    outcome: match result {
                        LogoutResult::RevokedNow => "success",
                        LogoutResult::AlreadyTerminal => "already_terminal",
                    },
                    user_id: actor_id,
                    session_id: Some(sid),
                    trace_id: correlation.trace_id,
                    correlation_source: correlation.source.as_str(),
                    action_group: None,
                    reason: Some("logout"),
                    device: None,
                },
            )
            .await;
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Err(()) => internal_error(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAcknowledgePayload {
    pub user_id: String,
    pub session_id: String,
}

pub async fn acknowledge_legacy_migration(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LegacyAcknowledgePayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (Ok(user_id), Ok(session_id)) = (
        ObjectId::parse_str(&payload.user_id),
        ObjectId::parse_str(&payload.session_id),
    ) else {
        return auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid acknowledgment",
        );
    };
    if !trusted_session_proof_matches(&context, user_id, session_id) {
        return auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid acknowledgment",
        );
    }
    let Some(client) = &state.mongo_client else {
        return internal_error();
    };
    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let authority = super::legacy_migration::MongoMigrationAuthority { db: &db, now };
    let store = super::legacy_migration_store::MongoLegacyMigrationStore { db: &db };
    match super::legacy_migration::acknowledge_legacy_migration(
        &store, &authority, user_id, session_id, now,
    )
    .await
    {
        Ok(()) => (StatusCode::NO_CONTENT, "").into_response(),
        Err(super::legacy_migration::LegacyMigrationError::RecoveryUnavailable) => internal_error(),
        Err(_) => auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid acknowledgment",
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigratePayload {
    pub migration_operation_marker: String,
    pub user_id: String,
    pub legacy_expires_at: i64,
    pub migration_cutoff_at: i64,
}

fn fingerprint_from_hex(hex: &str) -> Result<[u8; 32], ()> {
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| ())?;
    }
    Ok(out)
}

struct ProductionMigrationRuntime;
impl super::legacy_migration_aead::MigrationNonceSource for ProductionMigrationRuntime {
    fn fill_migration_nonce(&self, nonce: &mut [u8; 24]) {
        OsRng.fill_bytes(nonce);
    }
}
impl super::legacy_migration::MigrationRandom for ProductionMigrationRuntime {
    fn target_session_id(&self) -> ObjectId {
        ObjectId::new()
    }
    fn issuance_secret(&self) -> [u8; 32] {
        let mut value = [0; 32];
        OsRng.fill_bytes(&mut value);
        value
    }
    fn csrf_value(&self) -> String {
        use base64::Engine;
        let mut value = [0; 32];
        OsRng.fill_bytes(&mut value);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
    }
}
struct ProductionMigrationClock(DateTime);
impl super::legacy_migration::MigrationClock for ProductionMigrationClock {
    fn now(&self) -> DateTime {
        self.0
    }
}

pub async fn migrate_legacy_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LegacyMigratePayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Ok(trusted_user_id) = ObjectId::parse_str(&payload.user_id) else {
        return auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid user",
        );
    };
    let Ok(fingerprint) = fingerprint_from_hex(&payload.migration_operation_marker) else {
        return auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid fingerprint",
        );
    };
    if context.user_id.as_deref() != Some(trusted_user_id.to_hex().as_str())
        || context.session_id.is_some()
    {
        return auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Invalid user",
        );
    }
    let Some(client) = &state.mongo_client else {
        return auth_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
            "Migration temporarily unavailable",
        );
    };
    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let authority = super::legacy_migration::MongoMigrationAuthority { db: &db, now };
    let store = super::legacy_migration_store::MongoLegacyMigrationStore { db: &db };
    let request = super::legacy_migration::LegacyMigrationRequest {
        fingerprint,
        user_id: trusted_user_id,
        legacy_expires_at: DateTime::from_millis(payload.legacy_expires_at.saturating_mul(1000)),
        migration_cutoff_at: DateTime::from_millis(
            payload.migration_cutoff_at.saturating_mul(1000),
        ),
    };
    let runtime = ProductionMigrationRuntime;
    let clock = ProductionMigrationClock(now);
    let (rotation_key_id, digest_key) = state.rotation_keys.active();
    match super::legacy_migration::migrate_legacy_session(
        &store,
        &authority,
        &request,
        &clock,
        &runtime,
        &state.recovery_encryption_keys,
        digest_key,
        rotation_key_id,
    )
    .await
    {
        Ok(issuance) => {
            let Ok(final_state) = super::legacy_migration::MigrationAuthority::reload(
                &authority,
                trusted_user_id,
                Some(issuance.target_session_id),
            )
            .await
            else {
                return auth_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
                    "Migration temporarily unavailable",
                );
            };
            let Ok(Some(user)) = db
                .collection::<Document>("users")
                .find_one(doc! { "_id": trusted_user_id })
                .await
            else {
                return auth_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
                    "Migration temporarily unavailable",
                );
            };
            let now_s = now.timestamp_millis() / 1000;
            let claims = AccessClaims {
                sub: trusted_user_id.to_hex(),
                sid: issuance.target_session_id.to_hex(),
                session_version: final_state.security_epoch,
                role: final_state.role.clone(),
                iat: now_s,
                exp: now_s + access_ttl_seconds(&final_state.role),
                jti: ObjectId::new().to_hex(),
                token_type: "access".into(),
            };
            let Ok(access) = sign_access_token(&claims, &state.jwt_secret) else {
                return internal_error();
            };
            let Ok(refresh_token) = encode_refresh_token(
                &issuance.target_session_id.to_hex(),
                &issuance.refresh_secret,
            ) else {
                return internal_error();
            };
            let Ok(recovery_token) = encode_refresh_token(
                &issuance.target_session_id.to_hex(),
                &issuance.recovery_secret,
            ) else {
                return internal_error();
            };
            (
                StatusCode::OK,
                Json(json!({
                    "accessToken": access,
                    "refreshToken": refresh_token,
                    "recoveryToken": recovery_token,
                    "refreshCookieMaxAgeSeconds": (final_state.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
                    "recoveryCookieMaxAgeSeconds": (final_state.absolute_expires_at.timestamp_millis() / 1000 - now_s).max(0),
                    "csrfToken": &*issuance.csrf_value,
                    "user": serialize_auth_user(&user),
                    "session": { "sessionId": issuance.target_session_id.to_hex() },
                })),
            )
                .into_response()
        }
        Err(super::legacy_migration::LegacyMigrationError::Race) => auth_error(
            StatusCode::CONFLICT,
            "AUTH_REFRESH_RACE",
            "Legacy migration already in progress",
        ),
        Err(super::legacy_migration::LegacyMigrationError::Invalid) => auth_error(
            StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            "Legacy token already migrated",
        ),
        Err(super::legacy_migration::LegacyMigrationError::DeviceLimit) => auth_error(
            StatusCode::CONFLICT,
            "AUTH_DEVICE_LIMIT_REACHED",
            "Device limit reached",
        ),
        Err(super::legacy_migration::LegacyMigrationError::RecoveryUnavailable) => auth_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTH_REFRESH_RECOVERY_UNAVAILABLE",
            "Migration temporarily unavailable",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_refresh_recovery_error_is_terminal_code() {
        let response = outcome_error(RefreshOutcome::RecoveryExpired);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn legacy_migration_handler_contract() {
        assert!(fingerprint_from_hex(&"ab".repeat(32)).is_ok());
        assert!(fingerprint_from_hex(&"AB".repeat(32)).is_err());
        assert!(fingerprint_from_hex(&format!(" {}", "ab".repeat(32))).is_err());

        let source = include_str!("session_handlers.rs");
        assert!(!source.contains(&["orchestrate_legacy", "_migration"].concat()));
        assert!(!source.contains(&["try_insert_legacy", "_migration_session"].concat()));
        assert!(!source.contains(&["find_one(doc! { \"legacy", "MigrationFingerprint\""].concat()));
    }
}
