use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group,
    routes::auth::security_change::{
        build_prepared_record, load_existing_security_change, orchestrate_security_change,
        prove_security_change_recovery_secret, security_change_outcome_error,
        InitiatingSessionRecoveryAuthority, MongoSecurityChangeStore,
        ProductionSecurityChangeCrypto, SecurityChangeKind, SecurityChangeOutcome,
        SecurityChangeProposalContext, SecurityChangeResult,
    },
    security::{require_permission, require_proxy_context, trusted_session_proof_matches},
    state::AppState,
    utils::bson::read_i64,
};
use serde::Deserialize;

/// Actor recovery proof payload for owner-only target 2FA reset (Commit 2 Rust path).
/// Node may still omit forwarding in Commit 3; missing proof fails closed before mutation.
#[derive(Deserialize, Default)]
pub struct OwnerResetTwoFactorPayload {
    #[serde(rename = "recoveryToken")]
    pub recovery_token: Option<String>,
}

use super::{
    audit::write_team_audit_log,
    mappers::team_member_from_doc,
    queries::team_member_lookup,
    responses::{internal_error, status_message, unavailable},
    session::actor_scope,
    validation::parse_team_member_id,
};
use crate::routes::auth::auth_error;

pub async fn reset_member_two_factor(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    payload: Option<Json<OwnerResetTwoFactorPayload>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "team.reset_2fa") {
        return response;
    }
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let actor_scope = match actor_scope(&db, &context).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    if !actor_scope.is_owner {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya owner yang dapat reset 2FA anggota tim",
        );
    }
    let member_id = match parse_team_member_id(&id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let users = db.collection::<Document>("users");
    let user = match users
        .find_one(doc! { "_id": member_id, "role": { "$in": ["admin", "cs"] } })
        .await
    {
        Ok(Some(user)) => user,
        Ok(None) => {
            return status_message(
                axum::http::StatusCode::NOT_FOUND,
                "Anggota tim tidak ditemukan",
            )
        }
        Err(_) => return internal_error(),
    };
    let Some(actor_user_id_hex) = context.user_id.as_deref() else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(actor_sid_hex) = context.session_id.as_deref() else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Ok(actor_user_id) = ObjectId::parse_str(actor_user_id_hex) else {
        return internal_error();
    };
    let Ok(actor_sid) = ObjectId::parse_str(actor_sid_hex) else {
        return internal_error();
    };
    if !trusted_session_proof_matches(&context, actor_user_id, actor_sid) {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    // Owner reset never issues target credentials. Continuation must prove possession of the
    // authenticated owner actor's recovery secret against the actor session's authoritative
    // nextRecoverySecretDigest (fresh) or persisted continuationDigest (exact retry). Missing/
    // wrong/arbitrary same-SID tokens fail closed before any mutation. Node recovery-cookie
    // forwarding remains Commit 3.
    let recovery_token = payload
        .as_ref()
        .and_then(|body| body.recovery_token.as_deref());
    let actor_session = match db
        .collection::<Document>(crate::routes::auth::session_store::AUTH_SESSIONS_COLLECTION)
        .find_one(doc! { "sessionId": actor_sid, "userId": actor_user_id, "status": "active" })
        .await
    {
        Ok(Some(session)) => session,
        _ => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let existing = match load_existing_security_change(&db, member_id).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    if let Some(existing) = &existing {
        if existing.binding.kind != SecurityChangeKind::TwoFactorOwnerReset
            || existing.binding.target_user_id != member_id
            || existing.binding.initiating_sid != actor_sid
            || existing.binding.authenticated_role != actor_scope.role
        {
            let (status, code, message) =
                security_change_outcome_error(SecurityChangeOutcome::Conflict);
            return auth_error(status, code, message);
        }
    }
    let now = DateTime::now();
    let invalid_recovery = || {
        auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_TOKEN_INVALID",
            if recovery_token.unwrap_or("").is_empty() {
                "Recovery proof required"
            } else {
                "Invalid recovery proof"
            },
        )
    };
    let generation = match actor_session.get_i64("refreshGeneration") {
        Ok(value) if value >= 0 => value as u64,
        _ => return invalid_recovery(),
    };
    // For owner reset, previous_epoch is the *target* member epoch; possession proof uses the
    // actor session's own sessionVersionAtIssue and generation, not the target's epoch.
    let actor_session_epoch = match actor_session.get_i64("sessionVersionAtIssue") {
        Ok(value) => value,
        Err(_) => return invalid_recovery(),
    };
    let expected_generation = existing
        .as_ref()
        .map(|record| record.binding.source_recovery_generation)
        .unwrap_or(generation);
    let authority = InitiatingSessionRecoveryAuthority {
        session_id: actor_sid,
        user_id: actor_user_id,
        expected_role: actor_scope.role.clone(),
        expected_security_epoch: actor_session_epoch,
        expected_refresh_generation: expected_generation,
        now,
        require_active_status: true,
    };
    let continuation_secret = match prove_security_change_recovery_secret(
        recovery_token,
        actor_sid,
        &actor_session,
        &authority,
        &state.rotation_keys,
        existing.as_ref(),
    ) {
        Ok(secret) => secret,
        Err(()) => return invalid_recovery(),
    };
    let absolute = match actor_session.get_datetime("absoluteExpiresAt") {
        Ok(value) => *value,
        Err(_) => return internal_error(),
    };
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
        .unwrap_or_else(|| read_i64(&user, "sessionVersion"));
    let source_recovery_generation = existing
        .as_ref()
        .map(|record| record.binding.source_recovery_generation)
        .unwrap_or(generation);
    // Role/policy authority timestamps are taken from the actor (authenticated owner), not the
    // target member whose 2FA is being reset without credential issuance.
    let actor_user = users
        .find_one(doc! { "_id": actor_user_id })
        .await
        .ok()
        .flatten();
    let role_updated_at = actor_user
        .as_ref()
        .and_then(|actor| {
            actor
                .get_datetime("roleUpdatedAt")
                .or_else(|_| actor.get_datetime("updatedAt"))
                .ok()
                .copied()
        })
        .unwrap_or(now);
    let policy_updated_at = actor_user
        .as_ref()
        .and_then(|actor| {
            actor
                .get_datetime("policyUpdatedAt")
                .or_else(|_| actor.get_datetime("updatedAt"))
                .ok()
                .copied()
        })
        .unwrap_or(now);
    let proposal = SecurityChangeProposalContext {
        // Persist on the target user document (2FA mutation target), but bind the authenticated
        // owner actor role + actor SID + actor recovery proof for continuation.
        user_id: member_id,
        target_user_id: member_id,
        authenticated_role: actor_scope.role.clone(),
        initiating_sid: actor_sid,
        kind: SecurityChangeKind::TwoFactorOwnerReset,
        method: "PUT".into(),
        path: format!("/api/v2/teams/{id}/reset-2fa"),
        previous_epoch,
        source_recovery_generation,
        result_sid: None,
        result_slot: None,
        started_at,
        source_absolute_expires_at: absolute,
        continuation_secret,
        authoritative_role_updated_at: role_updated_at,
        authoritative_policy_updated_at: policy_updated_at,
        issue_result_session: false,
        result: SecurityChangeResult {
            enabled: false,
            message: "2FA anggota tim berhasil direset".into(),
        },
    };
    let proposed = match existing {
        Some(record) => record,
        None => match build_prepared_record(
            &proposal,
            &state.rotation_keys,
            &state.recovery_encryption_keys,
            operation_id,
            None,
        ) {
            Ok(record) => record,
            Err(_) => return internal_error(),
        },
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
        orchestrate_security_change(&store, &crypto, proposed, &continuation_secret, now).await;
    match outcome {
        SecurityChangeOutcome::Completed { .. } => {
            let Some(member) = team_member_lookup(&db, member_id).await else {
                return internal_error();
            };
            write_team_audit_log(
                &db,
                &actor_scope,
                &member,
                "update",
                "Reset 2FA akun tim karena recovery authenticator".to_string(),
                None,
            )
            .await;
            Json(serde_json::json!({
                "message": "2FA anggota tim berhasil direset",
                "user": team_member_from_doc(member),
            }))
            .into_response()
        }
        other => {
            let (status, code, message) = security_change_outcome_error(other);
            auth_error(status, code, message)
        }
    }
}
