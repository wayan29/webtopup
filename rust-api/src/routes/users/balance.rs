use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{ReturnDocument, UpdateModifications},
    ClientSession,
};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::require_permission,
    services::idempotency::{
        self, balance_effect_filter, balance_effect_pipeline,
        commit_mongo_transaction_with_unknown_retry, effect_marker_matches_identity,
        effect_slot_capacity_response, find_balance_effect_by_identity,
        is_effect_slot_capacity_rejection, mark_effect_resolved_update,
        prune_resolved_effect_slots_pipeline, release_decision_after_transaction_abort,
        CompletedSnapshot, DomainMarkerRecovery, DomainRecovery, EffectIdentity, IdempotencyBegin,
        IdempotencyStore, MongoIdempotencyStore, OrchestrationReleaseDecision,
        TransactionCommitOutcome, ROUTE_BALANCE_ADJUST,
    },
    state::AppState,
    utils::bson::read_string,
};

use super::{
    mappers::{
        balance_adjustment_from_doc, balance_adjustment_history_item, balance_deposit_item,
        balance_transaction_item, balance_voucher_item, date_string, read_f64, user_item_from_doc,
    },
    queries::{adjustment_actors, load_docs, member_projection, product_labels},
    responses::{internal_error, not_found, status_message, unavailable},
    session::current_member_id,
    types::{
        AdjustBalancePayload, AdjustBalanceResponse, BalanceAdjustmentsResponse,
        BalanceAuditResponse, BalanceHistoryResponse, UserItem,
    },
    validation::{normalize_adjustment_amount, parse_positive_i64},
};

pub async fn me_balance_history(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let user_id = match current_member_id(headers, &state) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);

    let deposits = load_docs(
        &db,
        "deposits",
        doc! { "user": user_id, "status": "approved" },
        doc! { "_id": 1, "amount": 1, "adminFee": 1, "createdAt": 1 },
    )
    .await;
    let transactions = load_docs(
        &db,
        "transactions",
        doc! { "user": user_id, "status": "success" },
        doc! { "_id": 1, "amount": 1, "createdAt": 1, "product": 1 },
    )
    .await;
    let vouchers = load_docs(
        &db,
        "vouchers",
        doc! { "redeemedBy": user_id, "isRedeemed": true },
        doc! { "_id": 1, "code": 1, "amount": 1, "redeemedAt": 1, "createdAt": 1, "redeemedBalanceBefore": 1, "redeemedBalanceAfter": 1 },
    )
    .await;
    let adjustments = load_docs(
        &db,
        "userbalanceadjustments",
        doc! { "user": user_id },
        doc! { "_id": 1, "type": 1, "amount": 1, "reason": 1, "balanceBefore": 1, "balanceAfter": 1, "createdAt": 1, "adjustedBy": 1 },
    )
    .await;

    let products = product_labels(&db, &transactions).await;
    let actors = adjustment_actors(&db, &adjustments).await;
    let mut items = Vec::new();
    items.extend(deposits.into_iter().filter_map(balance_deposit_item));
    items.extend(
        transactions
            .into_iter()
            .map(|document| balance_transaction_item(document, &products)),
    );
    items.extend(vouchers.into_iter().map(balance_voucher_item));
    items.extend(
        adjustments
            .into_iter()
            .map(|document| balance_adjustment_history_item(document, &actors)),
    );
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));

    Json(BalanceHistoryResponse { items }).into_response()
}

pub async fn balance_adjustments(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = require_permission(&headers, &state, "viewUsers").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(&id) else {
        return not_found("User member tidak ditemukan");
    };
    let db = client.database(&state.mongo_db);
    let user = match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .await
    {
        Ok(Some(user)) if read_string(&user, "role") == "member" => user,
        _ => return not_found("User member tidak ditemukan"),
    };
    let user_id = match user.get_object_id("_id") {
        Ok(id) => id,
        Err(_) => return not_found("User member tidak ditemukan"),
    };
    let limit = parse_positive_i64(query.get("limit"), 10, 50);
    let docs = match db
        .collection::<Document>("userbalanceadjustments")
        .find(doc! { "user": user_id })
        .sort(doc! { "createdAt": -1 })
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let actors = adjustment_actors(&db, &docs).await;

    Json(BalanceAdjustmentsResponse {
        items: docs
            .into_iter()
            .map(|doc| balance_adjustment_from_doc(doc, &actors))
            .collect(),
    })
    .into_response()
}

pub async fn adjust_balance(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<AdjustBalancePayload>,
) -> axum::response::Response {
    let proxy_user = match require_permission(&headers, &state, "manageUsers").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.adjust_balance") {
        return response;
    }
    let operator_id = proxy_user.id;
    let idempotency_key = match idempotency::require_idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.into_response(),
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(user_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "ID user tidak valid");
    };
    let amount = match normalize_adjustment_amount(payload.amount) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let adjustment_type = match payload.adjustment_type.as_deref().map(str::trim) {
        Some("add") => "add".to_string(),
        Some("subtract") => "subtract".to_string(),
        _ => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Tipe penyesuaian saldo tidak valid",
            )
        }
    };
    let reason = payload.reason.unwrap_or_default().trim().to_string();
    if reason.len() < 5 || reason.len() > 300 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Alasan penyesuaian saldo wajib 5-300 karakter",
        );
    }

    let db = client.database(&state.mongo_db);
    let users = db.collection::<Document>("users");
    let adjustments = db.collection::<Document>("userbalanceadjustments");
    let hmac_key = state.session_token_hash_secret.as_bytes();
    let request_digest = idempotency::balance_adjust_digest(
        hmac_key,
        &user_id.to_hex(),
        &adjustment_type,
        amount,
        &reason,
    );

    let active_key = idempotency_key.clone();
    let mut lease_generation: u64 = 0;
    let effect_identity = active_key
        .as_ref()
        .map(|key| EffectIdentity::balance(operator_id, key, &request_digest, user_id));
    if let Some(ref key) = active_key {
        let store = MongoIdempotencyStore::new(&db);
        let recovery = BalanceMarkerRecovery {
            adjustments: &adjustments,
            users: &users,
            operator_id,
            user_id,
            adjustment_type: adjustment_type.clone(),
            amount,
            reason: reason.clone(),
            request_digest: request_digest.clone(),
        };
        let now = DateTime::now();
        match idempotency::begin_with_recovery(
            &store,
            &recovery,
            operator_id,
            ROUTE_BALANCE_ADJUST,
            key,
            &request_digest,
            now,
        )
        .await
        {
            Ok(IdempotencyBegin::Started {
                lease_generation: gen,
            }) => {
                lease_generation = gen;
            }
            Ok(IdempotencyBegin::Completed { status, body }) => {
                crate::routes::auth::security_audit::metric_idempotency_duplicate_prevented(
                    "balance_adjust",
                    "replayed",
                );
                return idempotency::completed_response(status, body);
            }
            Ok(IdempotencyBegin::Conflict) => {
                crate::routes::auth::security_audit::metric_idempotency_duplicate_prevented(
                    "balance_adjust",
                    "conflict",
                );
                return idempotency::conflict_response();
            }
            Ok(IdempotencyBegin::InProgress) => {
                crate::routes::auth::security_audit::metric_idempotency_duplicate_prevented(
                    "balance_adjust",
                    "in_progress",
                );
                return idempotency::in_progress_response();
            }
            Err(error) => return error.into_response(),
        }
    }

    let delta = if adjustment_type == "add" {
        amount
    } else {
        -amount
    };

    // Prefer multi-doc transaction when available; standalone uses atomic money+marker.
    let apply_result = if state.mongo_transactions_enabled {
        let mut session = match client.start_session().await {
            Ok(session) => session,
            Err(error) => {
                eprintln!("Failed to start MongoDB session for balance adjustment: {error}");
                release_balance_started_pre_effect(
                    &db,
                    operator_id,
                    active_key.as_deref(),
                    &request_digest,
                    lease_generation,
                )
                .await;
                return internal_error();
            }
        };
        if let Err(error) = session.start_transaction().await {
            eprintln!("Failed to start MongoDB transaction for balance adjustment: {error}");
            release_balance_started_pre_effect(
                &db,
                operator_id,
                active_key.as_deref(),
                &request_digest,
                lease_generation,
            )
            .await;
            return internal_error();
        }

        let result = apply_balance_adjustment_transaction(
            &mut session,
            &users,
            &adjustments,
            user_id,
            operator_id,
            amount,
            delta,
            &adjustment_type,
            &reason,
            effect_identity.as_ref(),
        )
        .await;

        let result = match result {
            Ok(result) => result,
            Err(response) => {
                // Domain ops did not return Ok. Abort, but only release when abort itself succeeds
                // (positive proof the in-session work is non-durable). Abort failure retains started.
                let abort_ok = session.abort_transaction().await.is_ok();
                match release_decision_after_transaction_abort(false, abort_ok) {
                    OrchestrationReleaseDecision::ReleaseStarted => {
                        release_balance_started_pre_effect(
                            &db,
                            operator_id,
                            active_key.as_deref(),
                            &request_digest,
                            lease_generation,
                        )
                        .await;
                    }
                    OrchestrationReleaseDecision::RetainAndReconcile => {
                        eprintln!(
                            "balance transaction abort failed or ambiguous; retaining started for reconcile"
                        );
                    }
                }
                return response;
            }
        };

        // Commit with bounded UnknownTransactionCommitResult retries. Never infer non-durability
        // from a commit error and never release started solely because commit/abort returned Err.
        match commit_mongo_transaction_with_unknown_retry(&mut session).await {
            TransactionCommitOutcome::Committed => {}
            TransactionCommitOutcome::Ambiguous | TransactionCommitOutcome::FailedDefinitely => {
                // Domain ops already succeeded in-session; retain started and let marker/audit
                // recovery reconcile. Retry must not re-apply money or audit.
                eprintln!(
                    "balance transaction commit not positively acknowledged; retaining started for full-identity reconcile"
                );
                return internal_error();
            }
        }
        result
    } else {
        eprintln!(
            "MONGO_TRANSACTIONS_ENABLED=false; using standalone atomic balance effect markers"
        );
        match apply_balance_adjustment_standalone(
            &users,
            &adjustments,
            user_id,
            operator_id,
            amount,
            delta,
            &adjustment_type,
            &reason,
            effect_identity.as_ref(),
        )
        .await
        {
            Ok(result) => result,
            Err(BalanceStandaloneError::PreEffect(response)) => {
                // No durable money marker — release started only for pure pre-effect failures.
                release_balance_started_pre_effect(
                    &db,
                    operator_id,
                    active_key.as_deref(),
                    &request_digest,
                    lease_generation,
                )
                .await;
                return response;
            }
            Err(BalanceStandaloneError::AfterEffect(response)) => {
                // Money marker durable or compensation unverified: never release started.
                // Leave orchestration for lease takeover / marker recovery. Return 500 (ambiguous).
                return response;
            }
        }
    };

    let body_value = apply_result.response_body;
    let audit_id = apply_result.audit_id;

    if let Some(ref key) = active_key {
        let store = MongoIdempotencyStore::new(&db);
        let snapshot = CompletedSnapshot {
            status: 200,
            body: body_value.clone(),
            resource_id: audit_id.map(|id| id.to_hex()),
        };
        if let Err(error) = store
            .complete(
                operator_id,
                ROUTE_BALANCE_ADJUST,
                key,
                &request_digest,
                lease_generation,
                &snapshot,
                DateTime::now(),
            )
            .await
        {
            // Domain write already applied; leave started for marker recovery.
            eprintln!("Failed to finalize balance idempotency record: {error:?}");
            return error.into_response();
        }
        // Orchestration completed: mark effect resolved and prune old completed proofs only.
        if let Some(identity) = effect_identity.as_ref() {
            let now = DateTime::now();
            let _ = users
                .update_one(
                    doc! { "_id": user_id },
                    mark_effect_resolved_update(identity, now),
                )
                .await;
            let _ = users
                .update_one(
                    doc! { "_id": user_id },
                    mongodb::options::UpdateModifications::Pipeline(
                        prune_resolved_effect_slots_pipeline(now),
                    ),
                )
                .await;
        }
    }

    (axum::http::StatusCode::OK, Json(body_value)).into_response()
}

struct BalanceApplyResult {
    response_body: serde_json::Value,
    audit_id: Option<ObjectId>,
}

enum BalanceStandaloneError {
    PreEffect(axum::response::Response),
    AfterEffect(axum::response::Response),
}

struct BalanceMarkerRecovery<'a> {
    adjustments: &'a mongodb::Collection<Document>,
    users: &'a mongodb::Collection<Document>,
    operator_id: ObjectId,
    user_id: ObjectId,
    adjustment_type: String,
    amount: f64,
    reason: String,
    request_digest: String,
}

impl DomainMarkerRecovery for BalanceMarkerRecovery<'_> {
    async fn recover(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) -> DomainRecovery {
        if route_key != ROUTE_BALANCE_ADJUST || actor_id != self.operator_id {
            return DomainRecovery::None;
        }
        if request_digest != self.request_digest {
            return DomainRecovery::None;
        }
        let identity =
            EffectIdentity::balance(actor_id, idempotency_key, request_digest, self.user_id);

        // Prefer audit row (domain_complete) with full identity + immutable marker payload.
        if let Ok(Some(audit)) = self
            .adjustments
            .find_one(doc! {
                "adjustedBy": self.operator_id,
                "user": self.user_id,
                "type": &self.adjustment_type,
                "amount": self.amount,
                "reason": &self.reason,
                "idempotencyKey": idempotency_key,
                "routeKey": ROUTE_BALANCE_ADJUST,
                "requestDigest": request_digest,
            })
            .await
        {
            if let Some(snapshot) =
                snapshot_from_audit_and_marker(&self.users, self.user_id, &audit, &identity).await
            {
                return DomainRecovery::EffectApplied {
                    snapshot: Some(snapshot),
                };
            }
            return DomainRecovery::EffectApplied { snapshot: None };
        }

        // Money marker without audit: effect_applied; allow forward reconcile (insert audit once).
        if let Ok(Some(user)) = self.users.find_one(doc! { "_id": self.user_id }).await {
            if find_balance_effect_by_identity(&user, &identity).is_some() {
                return DomainRecovery::EffectApplied { snapshot: None };
            }
        }
        DomainRecovery::None
    }
}

async fn snapshot_from_audit_and_marker(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
    audit: &Document,
    identity: &EffectIdentity,
) -> Option<CompletedSnapshot> {
    let user_doc = users.find_one(doc! { "_id": user_id }).await.ok().flatten();
    let marker = user_doc
        .as_ref()
        .and_then(|doc| find_balance_effect_by_identity(doc, identity));
    let response_body = build_immutable_balance_response(audit, marker.as_ref())?;
    Some(CompletedSnapshot {
        status: 200,
        body: response_body,
        resource_id: audit.get_object_id("_id").ok().map(|id| id.to_hex()),
    })
}

fn build_immutable_balance_response(
    audit: &Document,
    marker: Option<&Document>,
) -> Option<serde_json::Value> {
    let adjustment_type = read_string(audit, "type");
    let amount = read_f64(audit, "amount");
    let reason = read_string(audit, "reason");
    let balance_before = read_f64(audit, "balanceBefore");
    let balance_after = read_f64(audit, "balanceAfter");
    let user_item = immutable_user_item_from_marker_or_audit(audit, marker, balance_after);
    let response_body = AdjustBalanceResponse {
        message: if adjustment_type == "add" {
            "Saldo user berhasil ditambahkan"
        } else {
            "Saldo user berhasil dikurangi"
        },
        user: user_item,
        audit: BalanceAuditResponse {
            amount,
            adjustment_type,
            reason,
            balance_before,
            balance_after,
        },
    };
    serde_json::to_value(&response_body).ok()
}

fn immutable_user_item_from_marker_or_audit(
    audit: &Document,
    marker: Option<&Document>,
    balance_after: f64,
) -> UserItem {
    if let Some(marker) = marker {
        return UserItem {
            id: audit
                .get_object_id("user")
                .map(|id| id.to_hex())
                .unwrap_or_default(),
            name: marker
                .get_str("name")
                .ok()
                .map(str::to_string)
                .unwrap_or_default(),
            email: marker
                .get_str("email")
                .ok()
                .map(str::to_string)
                .unwrap_or_default(),
            level: marker
                .get_str("level")
                .ok()
                .map(str::to_string)
                .unwrap_or_default(),
            balance: balance_after,
            points: match marker.get("points") {
                Some(Bson::Int32(v)) => i64::from(*v),
                Some(Bson::Int64(v)) => *v,
                Some(Bson::Double(v)) => *v as i64,
                _ => 0,
            },
            active: marker.get_bool("active").unwrap_or(true),
            member_code: None,
            has_open_api_key: false,
            created_at: marker
                .get_datetime("createdAt")
                .ok()
                .map(|value| {
                    value
                        .try_to_rfc3339_string()
                        .unwrap_or_else(|_| value.to_string())
                })
                .unwrap_or_default(),
            updated_at: marker
                .get_datetime("updatedAt")
                .or_else(|_| marker.get_datetime("appliedAt"))
                .ok()
                .map(|value| {
                    value
                        .try_to_rfc3339_string()
                        .unwrap_or_else(|_| value.to_string())
                })
                .unwrap_or_default(),
        };
    }
    // Fallback: minimal immutable projection from audit only (no live user re-read).
    UserItem {
        id: audit
            .get_object_id("user")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: String::new(),
        email: String::new(),
        level: String::new(),
        balance: balance_after,
        points: 0,
        active: true,
        member_code: None,
        has_open_api_key: false,
        created_at: date_string(audit, "createdAt"),
        updated_at: date_string(audit, "updatedAt"),
    }
}

fn build_response_from_user_and_audit(
    user: Document,
    amount: f64,
    adjustment_type: &str,
    reason: &str,
    balance_before: f64,
    balance_after: f64,
) -> Result<serde_json::Value, axum::response::Response> {
    let response_body = AdjustBalanceResponse {
        message: if adjustment_type == "add" {
            "Saldo user berhasil ditambahkan"
        } else {
            "Saldo user berhasil dikurangi"
        },
        user: user_item_from_doc(user),
        audit: BalanceAuditResponse {
            amount,
            adjustment_type: adjustment_type.to_string(),
            reason: reason.to_string(),
            balance_before,
            balance_after,
        },
    };
    serde_json::to_value(&response_body).map_err(|_| internal_error())
}

async fn apply_balance_adjustment_transaction(
    session: &mut ClientSession,
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    user_id: ObjectId,
    operator_id: ObjectId,
    amount: f64,
    delta: f64,
    adjustment_type: &str,
    reason: &str,
    effect_identity: Option<&EffectIdentity>,
) -> Result<BalanceApplyResult, axum::response::Response> {
    let now = DateTime::now();
    let updated_user = if let Some(identity) = effect_identity {
        let filter = balance_effect_filter(user_id, identity, adjustment_type, amount);
        let pipeline =
            balance_effect_pipeline(identity, adjustment_type, amount, delta, reason, now);
        users
            .find_one_and_update(filter, UpdateModifications::Pipeline(pipeline))
            .projection(member_projection())
            .return_document(ReturnDocument::After)
            .session(&mut *session)
            .await
    } else {
        let mut filter = doc! { "_id": user_id, "role": "member" };
        if adjustment_type == "subtract" {
            filter.insert("balance", doc! { "$gte": amount });
        }
        users
            .find_one_and_update(
                filter,
                doc! { "$inc": { "balance": delta }, "$set": { "updatedAt": now } },
            )
            .projection(member_projection())
            .return_document(ReturnDocument::After)
            .session(&mut *session)
            .await
    };

    let user = match updated_user {
        Ok(Some(user)) => user,
        Ok(None) => {
            // May already have applied marker under this full identity (retry inside txn path).
            if let Some(identity) = effect_identity {
                if let Ok(Some(existing)) = users
                    .find_one(doc! { "_id": user_id })
                    .session(&mut *session)
                    .await
                {
                    if let Some(marker) = find_balance_effect_by_identity(&existing, identity) {
                        let balance_before = read_f64(&marker, "balanceBefore");
                        let balance_after = read_f64(&marker, "balanceAfter");
                        let audit_id = ensure_balance_audit(
                            adjustments,
                            Some(session),
                            user_id,
                            operator_id,
                            amount,
                            adjustment_type,
                            reason,
                            balance_before,
                            balance_after,
                            Some(identity),
                            false,
                        )
                        .await?;
                        let body = build_response_from_user_and_audit(
                            existing,
                            amount,
                            adjustment_type,
                            reason,
                            balance_before,
                            balance_after,
                        )?;
                        return Ok(BalanceApplyResult {
                            response_body: body,
                            audit_id,
                        });
                    }
                    // Existing matching slot absent: capacity fail-closed for NEW effects.
                    if is_effect_slot_capacity_rejection(Some(&existing), identity) {
                        return Err(effect_slot_capacity_response());
                    }
                }
            }
            if adjustment_type == "subtract" {
                return Err(balance_adjustment_miss(users, user_id, amount).await);
            }
            return Err(not_found("User member tidak ditemukan"));
        }
        Err(error) => {
            eprintln!("Failed to update member balance in transaction: {error}");
            return Err(internal_error());
        }
    };

    let (balance_before, balance_after) = if let Some(identity) = effect_identity {
        if let Some(marker) = find_balance_effect_by_identity(&user, identity) {
            (
                read_f64(&marker, "balanceBefore"),
                read_f64(&marker, "balanceAfter"),
            )
        } else {
            let after = read_f64(&user, "balance");
            (after - delta, after)
        }
    } else {
        let after = read_f64(&user, "balance");
        (after - delta, after)
    };

    let audit_id = ensure_balance_audit(
        adjustments,
        Some(session),
        user_id,
        operator_id,
        amount,
        adjustment_type,
        reason,
        balance_before,
        balance_after,
        effect_identity,
        true,
    )
    .await?;

    let body = build_response_from_user_and_audit(
        user,
        amount,
        adjustment_type,
        reason,
        balance_before,
        balance_after,
    )?;
    Ok(BalanceApplyResult {
        response_body: body,
        audit_id,
    })
}

/// Standalone Mongo path: money + marker in SAME document update; audit is a forward step.
async fn apply_balance_adjustment_standalone(
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    user_id: ObjectId,
    operator_id: ObjectId,
    amount: f64,
    delta: f64,
    adjustment_type: &str,
    reason: &str,
    effect_identity: Option<&EffectIdentity>,
) -> Result<BalanceApplyResult, BalanceStandaloneError> {
    let now = DateTime::now();
    let Some(identity) = effect_identity else {
        // Without key (rollout off): keep legacy best-effort but no orchestration release concerns.
        return apply_balance_adjustment_legacy_best_effort(
            users,
            adjustments,
            user_id,
            operator_id,
            amount,
            delta,
            adjustment_type,
            reason,
        )
        .await
        .map_err(BalanceStandaloneError::PreEffect);
    };

    let filter = balance_effect_filter(user_id, identity, adjustment_type, amount);
    let pipeline = balance_effect_pipeline(identity, adjustment_type, amount, delta, reason, now);
    let updated = users
        .find_one_and_update(filter, UpdateModifications::Pipeline(pipeline))
        .return_document(ReturnDocument::After)
        .await;

    let user = match updated {
        Ok(Some(user)) => user,
        Ok(None) => {
            // Either already applied for this full identity, capacity exhausted, insufficient
            // balance, or missing user.
            let existing = users
                .find_one(doc! { "_id": user_id, "role": "member" })
                .await
                .map_err(|error| {
                    eprintln!("Failed to load member after balance marker miss: {error}");
                    BalanceStandaloneError::PreEffect(internal_error())
                })?;
            let Some(existing) = existing else {
                return Err(BalanceStandaloneError::PreEffect(not_found(
                    "User member tidak ditemukan",
                )));
            };
            if let Some(marker) = find_balance_effect_by_identity(&existing, identity) {
                // Effect already durable — finish audit/snapshot without re-applying money.
                // Existing unresolved slots remain reconcilable even at the unresolved cap.
                return finish_balance_after_effect(
                    users,
                    adjustments,
                    existing,
                    marker,
                    user_id,
                    operator_id,
                    amount,
                    adjustment_type,
                    reason,
                    identity,
                )
                .await;
            }
            if is_effect_slot_capacity_rejection(Some(&existing), identity) {
                // Fail closed for NEW money effects; leave started for operator reconcilation of
                // other unresolved slots. Do not alter money.
                return Err(BalanceStandaloneError::PreEffect(
                    effect_slot_capacity_response(),
                ));
            }
            if adjustment_type == "subtract" && read_f64(&existing, "balance") < amount {
                return Err(BalanceStandaloneError::PreEffect(status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Saldo user tidak mencukupi untuk pengurangan ini",
                )));
            }
            return Err(BalanceStandaloneError::PreEffect(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Saldo user tidak bisa disesuaikan",
            )));
        }
        Err(error) => {
            eprintln!("Failed atomic balance effect+marker update: {error}");
            return Err(BalanceStandaloneError::PreEffect(internal_error()));
        }
    };

    let marker = find_balance_effect_by_identity(&user, identity).ok_or_else(|| {
        eprintln!("Atomic balance update returned user without effect marker");
        BalanceStandaloneError::AfterEffect(internal_error())
    })?;

    finish_balance_after_effect(
        users,
        adjustments,
        user,
        marker,
        user_id,
        operator_id,
        amount,
        adjustment_type,
        reason,
        identity,
    )
    .await
}

async fn finish_balance_after_effect(
    _users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    user: Document,
    marker: Document,
    user_id: ObjectId,
    operator_id: ObjectId,
    amount: f64,
    adjustment_type: &str,
    reason: &str,
    identity: &EffectIdentity,
) -> Result<BalanceApplyResult, BalanceStandaloneError> {
    // Refuse borrowed markers: payload must bind full identity.
    if !effect_marker_matches_identity(&marker, identity) {
        eprintln!("balance effect marker identity mismatch");
        return Err(BalanceStandaloneError::AfterEffect(internal_error()));
    }
    let balance_before = read_f64(&marker, "balanceBefore");
    let balance_after = read_f64(&marker, "balanceAfter");
    let audit_id = match ensure_balance_audit(
        adjustments,
        None,
        user_id,
        operator_id,
        amount,
        adjustment_type,
        reason,
        balance_before,
        balance_after,
        Some(identity),
        false,
    )
    .await
    {
        Ok(id) => id,
        Err(response) => {
            // Money is durable; do not attempt unverified compensation or release.
            return Err(BalanceStandaloneError::AfterEffect(response));
        }
    };

    // Prefer immutable marker fields for the user projection stored as the response snapshot.
    let body = if let Some(value) =
        build_immutable_balance_response_from_parts(&user, &marker, amount, adjustment_type, reason)
    {
        value
    } else {
        build_response_from_user_and_audit(
            user,
            amount,
            adjustment_type,
            reason,
            balance_before,
            balance_after,
        )
        .map_err(BalanceStandaloneError::AfterEffect)?
    };

    Ok(BalanceApplyResult {
        response_body: body,
        audit_id,
    })
}

fn build_immutable_balance_response_from_parts(
    user: &Document,
    marker: &Document,
    amount: f64,
    adjustment_type: &str,
    reason: &str,
) -> Option<serde_json::Value> {
    let balance_before = read_f64(marker, "balanceBefore");
    let balance_after = read_f64(marker, "balanceAfter");
    let user_item = UserItem {
        id: user
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: marker
            .get_str("name")
            .ok()
            .map(str::to_string)
            .unwrap_or_else(|| read_string(user, "name")),
        email: marker
            .get_str("email")
            .ok()
            .map(str::to_string)
            .unwrap_or_else(|| read_string(user, "email")),
        level: marker
            .get_str("level")
            .ok()
            .map(str::to_string)
            .unwrap_or_else(|| read_string(user, "level")),
        balance: balance_after,
        points: match marker.get("points") {
            Some(Bson::Int32(v)) => i64::from(*v),
            Some(Bson::Int64(v)) => *v,
            Some(Bson::Double(v)) => *v as i64,
            _ => user
                .get_i64("points")
                .ok()
                .or_else(|| user.get_i32("points").ok().map(i64::from))
                .unwrap_or(0),
        },
        active: marker
            .get_bool("active")
            .ok()
            .or_else(|| user.get_bool("active").ok())
            .unwrap_or(true),
        member_code: None,
        has_open_api_key: false,
        created_at: marker
            .get_datetime("createdAt")
            .ok()
            .map(|value| {
                value
                    .try_to_rfc3339_string()
                    .unwrap_or_else(|_| value.to_string())
            })
            .unwrap_or_else(|| date_string(user, "createdAt")),
        updated_at: marker
            .get_datetime("updatedAt")
            .or_else(|_| marker.get_datetime("appliedAt"))
            .ok()
            .map(|value| {
                value
                    .try_to_rfc3339_string()
                    .unwrap_or_else(|_| value.to_string())
            })
            .unwrap_or_else(|| date_string(user, "updatedAt")),
    };
    let response_body = AdjustBalanceResponse {
        message: if adjustment_type == "add" {
            "Saldo user berhasil ditambahkan"
        } else {
            "Saldo user berhasil dikurangi"
        },
        user: user_item,
        audit: BalanceAuditResponse {
            amount,
            adjustment_type: adjustment_type.to_string(),
            reason: reason.to_string(),
            balance_before,
            balance_after,
        },
    };
    serde_json::to_value(&response_body).ok()
}

async fn ensure_balance_audit(
    adjustments: &mongodb::Collection<Document>,
    mut session: Option<&mut ClientSession>,
    user_id: ObjectId,
    operator_id: ObjectId,
    amount: f64,
    adjustment_type: &str,
    reason: &str,
    balance_before: f64,
    balance_after: f64,
    effect_identity: Option<&EffectIdentity>,
    transactional: bool,
) -> Result<Option<ObjectId>, axum::response::Response> {
    if let Some(identity) = effect_identity {
        let filter = doc! {
            "idempotencyKey": &identity.idempotency_key,
            "adjustedBy": operator_id,
            "user": user_id,
            "routeKey": ROUTE_BALANCE_ADJUST,
            "requestDigest": &identity.request_digest,
        };
        let existing = if let Some(session) = session.as_mut() {
            adjustments
                .find_one(filter.clone())
                .session(&mut **session)
                .await
        } else {
            adjustments.find_one(filter).await
        };
        if let Ok(Some(doc)) = existing {
            return Ok(doc.get_object_id("_id").ok());
        }
    }

    let now = DateTime::now();
    let mut audit_doc = doc! {
        "user": user_id,
        "adjustedBy": operator_id,
        "type": adjustment_type,
        "amount": amount,
        "balanceBefore": balance_before,
        "balanceAfter": balance_after,
        "reason": reason,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if !transactional {
        audit_doc.insert("transactional", false);
    }
    if let Some(identity) = effect_identity {
        audit_doc.insert("idempotencyKey", &identity.idempotency_key);
        audit_doc.insert("routeKey", ROUTE_BALANCE_ADJUST);
        audit_doc.insert("requestDigest", &identity.request_digest);
        audit_doc.insert(
            "resourceId",
            identity.resource_id.clone().unwrap_or_default(),
        );
    }

    let insert = if let Some(session) = session.as_mut() {
        adjustments
            .insert_one(audit_doc)
            .session(&mut **session)
            .await
    } else {
        adjustments.insert_one(audit_doc).await
    };

    match insert {
        Ok(result) => Ok(result.inserted_id.as_object_id()),
        Err(error) => {
            // Duplicate key on unique audit index would mean concurrent finisher — re-read.
            if is_duplicate_key_error(&error) {
                if let Some(identity) = effect_identity {
                    let existing = adjustments
                        .find_one(doc! {
                            "idempotencyKey": &identity.idempotency_key,
                            "adjustedBy": operator_id,
                            "user": user_id,
                            "routeKey": ROUTE_BALANCE_ADJUST,
                            "requestDigest": &identity.request_digest,
                        })
                        .await
                        .ok()
                        .flatten();
                    if let Some(doc) = existing {
                        return Ok(doc.get_object_id("_id").ok());
                    }
                }
            }
            eprintln!("Failed to insert balance adjustment audit: {error}");
            Err(internal_error())
        }
    }
}

async fn apply_balance_adjustment_legacy_best_effort(
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    user_id: ObjectId,
    operator_id: ObjectId,
    amount: f64,
    delta: f64,
    adjustment_type: &str,
    reason: &str,
) -> Result<BalanceApplyResult, axum::response::Response> {
    let mut filter = doc! { "_id": user_id, "role": "member" };
    if adjustment_type == "subtract" {
        filter.insert("balance", doc! { "$gte": amount });
    }
    let updated_user = users
        .find_one_and_update(
            filter,
            doc! { "$inc": { "balance": delta }, "$set": { "updatedAt": DateTime::now() } },
        )
        .projection(member_projection())
        .return_document(ReturnDocument::After)
        .await;
    let user = match updated_user {
        Ok(Some(user)) => user,
        Ok(None) => {
            if adjustment_type == "subtract" {
                return Err(balance_adjustment_miss(users, user_id, amount).await);
            }
            return Err(not_found("User member tidak ditemukan"));
        }
        Err(error) => {
            eprintln!("Failed to update member balance in legacy fallback: {error}");
            return Err(internal_error());
        }
    };
    let balance_after = read_f64(&user, "balance");
    let balance_before = balance_after - delta;
    let audit_id = ensure_balance_audit(
        adjustments,
        None,
        user_id,
        operator_id,
        amount,
        adjustment_type,
        reason,
        balance_before,
        balance_after,
        None,
        false,
    )
    .await?;
    let body = build_response_from_user_and_audit(
        user,
        amount,
        adjustment_type,
        reason,
        balance_before,
        balance_after,
    )?;
    Ok(BalanceApplyResult {
        response_body: body,
        audit_id,
    })
}

async fn balance_adjustment_miss(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
    amount: f64,
) -> axum::response::Response {
    let user = users
        .find_one(doc! { "_id": user_id, "role": "member" })
        .projection(doc! { "balance": 1 })
        .await
        .ok()
        .flatten();
    let Some(user) = user else {
        return not_found("User member tidak ditemukan");
    };
    if read_f64(&user, "balance") < amount {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Saldo user tidak mencukupi untuk pengurangan ini",
        );
    }
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "Saldo user tidak bisa disesuaikan",
    )
}

async fn release_balance_started_pre_effect(
    db: &mongodb::Database,
    operator_id: ObjectId,
    key: Option<&str>,
    request_digest: &str,
    lease_generation: u64,
) {
    let Some(key) = key else {
        return;
    };
    let store = MongoIdempotencyStore::new(db);
    // Only safe before money marker. After effect, callers must leave started.
    let _ = store
        .release_started(
            operator_id,
            ROUTE_BALANCE_ADJUST,
            key,
            request_digest,
            lease_generation,
        )
        .await;
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write)) => {
            write.code == 11000
        }
        _ => {
            let message = error.to_string();
            message.contains("E11000") || message.contains("duplicate key")
        }
    }
}
