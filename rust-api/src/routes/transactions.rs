use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Datelike, Local, TimeZone};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{ReturnDocument, UpdateModifications},
};
use serde_json::{Map, Value};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_member_user, require_permission, ErrorResponse},
    services::idempotency::{
        self, effect_marker_matches_identity, effect_slot_capacity_response,
        find_balance_effect_by_identity, is_effect_slot_capacity_rejection,
        mark_effect_resolved_update, prune_resolved_effect_slots_pipeline, refund_credit_filter,
        refund_credit_pipeline, CompletedSnapshot, DomainMarkerRecovery, DomainRecovery,
        EffectIdentity, IdempotencyBegin, IdempotencyStore, MongoIdempotencyStore,
        REFUND_PHASE_AUDITED, REFUND_PHASE_CLAIMED, REFUND_PHASE_CREDITED,
        ROUTE_TRANSACTION_REFUND,
    },
    state::AppState,
    utils::bson::{escape_regex, read_i64, read_string},
};

mod csv;
mod json;
mod list;
pub(crate) mod provider;
mod status;
mod stuck;
pub(crate) mod types;

use super::validation_engine::{
    product_validation_config, run_paid_validation, PaidValidationStatus,
};
use csv::build_transaction_csv;
use json::{bson_to_json, document_to_json, document_to_map};
use list::{
    build_transactions_pipeline, document_array, first_array_item, first_document, lookup_stage,
    unwind_stage,
};
use provider::{check_vendor_status, top_up_vendor};
use status::{
    apply_optional_payload_string, apply_transition_plan, apply_user_balance_delta, award_points,
    insert_optional_datetime_or_unset, insert_optional_object_id_or_unset,
    insert_optional_string_or_unset, revoke_awarded_points, rollback_transaction_status,
    transaction_status_snapshot,
};
use stuck::stuck_transaction_item_from_doc;
use types::*;

const DEFAULT_THRESHOLD_MINUTES: i64 = 15;
const MAX_THRESHOLD_MINUTES: i64 = 24 * 60;
const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;
const MANUAL_MAX_LIMIT: i64 = 100;
const TRANSACTION_EXPORT_LIMIT: i64 = 5000;
const REPORT_OFFSET: &str = "+07:00";
const ALLOWED_TRANSACTION_STATUSES: [&str; 4] = ["pending", "processing", "success", "failed"];

pub async fn stuck_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<StuckTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let threshold_minutes = parse_positive_i64(
        query.threshold_minutes.as_deref(),
        DEFAULT_THRESHOLD_MINUTES,
        MAX_THRESHOLD_MINUTES,
    );
    let limit = parse_positive_i64(query.limit.as_deref(), DEFAULT_LIMIT, MAX_LIMIT);
    let cutoff_ms = DateTime::now().timestamp_millis() - (threshold_minutes * 60 * 1000);
    let cutoff = DateTime::from_millis(cutoff_ms);
    let filter = doc! {
        "status": { "$in": ["pending", "processing"] },
        "updatedAt": { "$lte": cutoff }
    };

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("transactions");
    let items = match collection
        .aggregate(vec![
            doc! { "$match": filter.clone() },
            doc! { "$sort": { "updatedAt": 1 } },
            doc! { "$limit": limit },
            doc! {
                "$lookup": {
                    "from": "users",
                    "localField": "user",
                    "foreignField": "_id",
                    "as": "user"
                }
            },
            doc! { "$unwind": { "path": "$user", "preserveNullAndEmptyArrays": true } },
            doc! {
                "$lookup": {
                    "from": "products",
                    "localField": "product",
                    "foreignField": "_id",
                    "as": "product"
                }
            },
            doc! { "$unwind": { "path": "$product", "preserveNullAndEmptyArrays": true } },
        ])
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
    .into_iter()
    .map(|document| stuck_transaction_item_from_doc(document, cutoff_ms, threshold_minutes))
    .collect::<Vec<_>>();
    let total = collection.count_documents(filter).await.unwrap_or(0);

    Json(StuckTransactionsResponse {
        threshold_minutes,
        total,
        items,
    })
    .into_response()
}

pub async fn create_transaction(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTransactionPayload>,
) -> Response {
    let proxy_user = match require_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let user_id = proxy_user.id;
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let target = normalize_payload_text(payload.target.as_deref());
    if target.is_empty() {
        return status_message(StatusCode::BAD_REQUEST, "Target wajib diisi");
    }
    let server_id = normalize_payload_text(payload.server_id.as_deref());

    let db = client.database(&state.mongo_db);
    if let Some(message) = active_maintenance_message(&db).await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "message": message })),
        )
            .into_response();
    }

    let products = db.collection::<Document>("products");
    let product_filter = if let Some(product_id) = payload
        .product_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Ok(product_id) = ObjectId::parse_str(product_id) else {
            return status_message(StatusCode::NOT_FOUND, "Product not found");
        };
        doc! { "_id": product_id }
    } else if let Some(product_code) = payload
        .product_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        doc! { "code": product_code }
    } else {
        return status_message(StatusCode::NOT_FOUND, "Product not found");
    };
    let Some(product) = (match products.find_one(product_filter).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "Product not found");
    };
    if product.get_bool("status").ok() == Some(false) {
        return status_message(StatusCode::BAD_REQUEST, "Product is unavailable");
    }
    let purchase_issues = product_purchase_issues(&db, &product).await;
    if !purchase_issues.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "message": format!("Produk tidak tersedia untuk dibeli: {}", purchase_issues.join(", "))
            })),
        )
            .into_response();
    }

    let users = db.collection::<Document>("users");
    let transactions = db.collection::<Document>("transactions");
    let Some(user) = (match users.find_one(doc! { "_id": user_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "User not found");
    };
    let user_level = non_empty_or(read_string(&user, "level"), "basic");
    let base_price = product_price_for_level(&product, &user_level);
    let mut price = base_price;
    let mut flash_sale_reservation = None;
    let mut applied_discount = None;

    if payload.use_flash_sale.unwrap_or(false) {
        if let Some(reservation) =
            reserve_flash_sale_stock(&db, product.get_object_id("_id").ok(), base_price).await
        {
            price = reservation.price;
            flash_sale_reservation = Some(reservation);
        }
    }

    // Optional checkout discount voucher (after flash sale so min-purchase uses discounted base).
    let voucher_code = payload
        .voucher_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_uppercase());
    if let Some(code) = voucher_code {
        let vouchers = db.collection::<Document>("vouchers");
        let product_ctx = crate::routes::vouchers::DiscountProductContext {
            product_id: product.get_object_id("_id").ok(),
            category_id: product.get_object_id("categoryId").ok(),
            operator_id: product.get_object_id("operatorId").ok(),
        };
        match crate::routes::vouchers::consume_discount_voucher(
            &vouchers,
            &code,
            price,
            Some(user_id),
            &product_ctx,
        )
        .await
        {
            Ok(applied) => {
                price = applied.final_price;
                applied_discount = Some(applied);
            }
            Err(response) => {
                rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
                return response;
            }
        }
    }

    let updated_user = users
        .find_one_and_update(
            doc! { "_id": user_id, "balance": { "$gte": price } },
            doc! { "$inc": { "balance": -price }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await;
    let Some(updated_user) = (match updated_user {
        Ok(value) => value,
        Err(_) => {
            rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
            if let Some(applied) = applied_discount.as_ref() {
                let vouchers = db.collection::<Document>("vouchers");
                crate::routes::vouchers::release_discount_slot(&vouchers, applied, Some(user_id)).await;
            }
            return internal_error();
        }
    }) else {
        rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
        if let Some(applied) = applied_discount.as_ref() {
            let vouchers = db.collection::<Document>("vouchers");
            crate::routes::vouchers::release_discount_slot(&vouchers, applied, Some(user_id)).await;
        }
        return status_message(StatusCode::BAD_REQUEST, "Insufficient balance");
    };

    let ref_id = match generate_ref_id(&db).await {
        Ok(value) => value,
        Err(_) => {
            rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
            if let Some(applied) = applied_discount.as_ref() {
                let vouchers = db.collection::<Document>("vouchers");
                crate::routes::vouchers::release_discount_slot(&vouchers, applied, Some(user_id)).await;
            }
            let _ = apply_user_balance_delta(&users, user_id, price).await;
            return internal_error();
        }
    };
    let now = DateTime::now();
    let product_id = product
        .get_object_id("_id")
        .unwrap_or_else(|_| ObjectId::new());
    let mut transaction_doc = doc! {
        "user": user_id,
        "product": product_id,
        "target": &target,
        "amount": price,
        "status": "pending",
        "vendorTrxId": &ref_id,
        "refunded": false,
        "source": "web",
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    if !server_id.is_empty() {
        transaction_doc.insert("serverId", server_id.clone());
    }
    if let Some(applied) = applied_discount.as_ref() {
        transaction_doc.insert("discountVoucherCode", &applied.code);
        transaction_doc.insert("discountAmount", applied.discount_amount);
        transaction_doc.insert("baseAmount", base_price);
    }
    let transaction_id = match transactions.insert_one(transaction_doc).await {
        Ok(result) => match result.inserted_id.as_object_id() {
            Some(id) => id,
            None => {
                rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
                if let Some(applied) = applied_discount.as_ref() {
                    let vouchers = db.collection::<Document>("vouchers");
                    crate::routes::vouchers::release_discount_slot(&vouchers, applied, Some(user_id)).await;
                }
                let _ = apply_user_balance_delta(&users, user_id, price).await;
                return internal_error();
            }
        },
        Err(_) => {
            rollback_flash_sale_stock(&db, flash_sale_reservation.as_ref()).await;
            if let Some(applied) = applied_discount.as_ref() {
                let vouchers = db.collection::<Document>("vouchers");
                crate::routes::vouchers::release_discount_slot(&vouchers, applied, Some(user_id)).await;
            }
            let _ = apply_user_balance_delta(&users, user_id, price).await;
            return internal_error();
        }
    };

    if let Some(validation_config) = product_validation_config(&product) {
        let validation_result = run_paid_validation(&validation_config, &target, &server_id).await;
        apply_initial_validation_result(&db, transaction_id, user_id, price, validation_result)
            .await;
    } else {
        let recheck_product = recheck_product_from_product_doc(&product);
        if let Ok(vendor_result) =
            top_up_vendor(&state, &ref_id, &target, &server_id, &recheck_product).await
        {
            apply_initial_vendor_result(&db, transaction_id, user_id, price, &vendor_result).await;
        }
    }

    let transaction = transactions
        .find_one(doc! { "_id": transaction_id })
        .await
        .ok()
        .flatten()
        .map(document_to_json)
        .unwrap_or_else(|| serde_json::json!({ "_id": transaction_id.to_hex() }));
    let remaining_balance = users
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "balance": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "balance"))
        .unwrap_or_else(|| read_i64(&updated_user, "balance"));

    (
        StatusCode::CREATED,
        Json(CreateTransactionResponse {
            message: "Transaction created",
            transaction,
            remaining_balance,
        }),
    )
        .into_response()
}

pub async fn manual_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "processManualTransaction").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let page = parse_positive_i64(query.page.as_deref(), 1, 100_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 20, MANUAL_MAX_LIMIT);
    let pipeline = match build_transactions_pipeline(&query, page, limit, true) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };
    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();
    let total = first_array_item(&result, "meta")
        .map(|item| read_i64(&item, "total"))
        .unwrap_or(0);
    let total_pages = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };
    let summary = first_array_item(&result, "summary")
        .map(|item| ManualTransactionsSummary {
            total: read_i64(&item, "total"),
            pending: read_i64(&item, "pending"),
            processing: read_i64(&item, "processing"),
            success: read_i64(&item, "success"),
            failed: read_i64(&item, "failed"),
            amount_total: read_i64(&item, "amountTotal"),
        })
        .unwrap_or_default();

    Json(ManualTransactionsResponse {
        items: document_array(&result, "items")
            .into_iter()
            .map(manual_transaction_item_from_doc)
            .collect(),
        meta: ManualTransactionsMeta {
            page,
            limit,
            total,
            total_pages,
        },
        summary,
    })
    .into_response()
}

pub async fn admin_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let page = parse_positive_i64(query.page.as_deref(), 1, 100_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 20, MANUAL_MAX_LIMIT);
    let pipeline = match build_transactions_pipeline(&query, page, limit, false) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };
    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();
    let total = first_array_item(&result, "meta")
        .map(|item| read_i64(&item, "total"))
        .unwrap_or(0);
    let total_pages = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };
    let summary = first_array_item(&result, "summary")
        .map(|item| ManualTransactionsSummary {
            total: read_i64(&item, "total"),
            pending: read_i64(&item, "pending"),
            processing: read_i64(&item, "processing"),
            success: read_i64(&item, "success"),
            failed: read_i64(&item, "failed"),
            amount_total: read_i64(&item, "amountTotal"),
        })
        .unwrap_or_default();

    Json(ManualTransactionsResponse {
        items: document_array(&result, "items")
            .into_iter()
            .map(manual_transaction_item_from_doc)
            .collect(),
        meta: ManualTransactionsMeta {
            page,
            limit,
            total,
            total_pages,
        },
        summary,
    })
    .into_response()
}

pub async fn admin_transactions_export(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ManualTransactionsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTransactions").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let pipeline = match build_transactions_pipeline(&query, 1, TRANSACTION_EXPORT_LIMIT, false) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") {
        return response;
    }
    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();
    let items = document_array(&result, "items")
        .into_iter()
        .map(manual_transaction_item_from_doc)
        .collect::<Vec<_>>();
    let csv = build_transaction_csv(&items);
    let filename = format!("admin-transactions-{}.csv", date_key(DateTime::now()));
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

pub async fn refund_transaction(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<RefundPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.refund") {
        return response;
    }
    let processor_id = proxy_user.id;
    let idempotency_key = match idempotency::require_idempotency_key(&headers) {
        Ok(key) => key,
        Err(error) => return error.into_response(),
    };
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi tidak valid");
    };
    let reason = payload.reason.unwrap_or_default().trim().to_string();
    if reason.len() < 5 || reason.len() > 300 {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Alasan refund wajib 5-300 karakter",
        );
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let transactions = db.collection::<Document>("transactions");
    let users = db.collection::<Document>("users");
    let adjustments = db.collection::<Document>("userbalanceadjustments");
    let hmac_key = state.session_token_hash_secret.as_bytes();
    let request_digest = idempotency::refund_digest(hmac_key, &transaction_id.to_hex(), &reason);
    let active_key = idempotency_key.clone();
    let mut lease_generation: u64 = 0;
    let effect_identity = active_key
        .as_ref()
        .map(|key| EffectIdentity::refund(processor_id, key, &request_digest, transaction_id));

    if let Some(ref key) = active_key {
        let store = MongoIdempotencyStore::new(&db);
        let recovery = RefundMarkerRecovery {
            transactions: &transactions,
            users: &users,
            adjustments: &adjustments,
            processor_id,
            transaction_id,
            reason: reason.clone(),
            request_digest: request_digest.clone(),
        };
        match idempotency::begin_with_recovery(
            &store,
            &recovery,
            processor_id,
            ROUTE_TRANSACTION_REFUND,
            key,
            &request_digest,
            DateTime::now(),
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
                    "refund", "replayed",
                );
                return idempotency::completed_response(status, body);
            }
            Ok(IdempotencyBegin::Conflict) => {
                crate::routes::auth::security_audit::metric_idempotency_duplicate_prevented(
                    "refund", "conflict",
                );
                return idempotency::conflict_response();
            }
            Ok(IdempotencyBegin::InProgress) => {
                crate::routes::auth::security_audit::metric_idempotency_duplicate_prevented(
                    "refund",
                    "in_progress",
                );
                return idempotency::in_progress_response();
            }
            Err(error) => return error.into_response(),
        }
    }

    match execute_refund_state_machine(
        &db,
        &transactions,
        &users,
        &adjustments,
        processor_id,
        transaction_id,
        &reason,
        active_key.as_deref(),
        &request_digest,
        lease_generation,
        effect_identity.as_ref(),
    )
    .await
    {
        Ok(body_value) => {
            if let Some(ref key) = active_key {
                let store = MongoIdempotencyStore::new(&db);
                let complete = CompletedSnapshot {
                    status: 200,
                    body: body_value.clone(),
                    resource_id: Some(transaction_id.to_hex()),
                };
                if let Err(error) = store
                    .complete(
                        processor_id,
                        ROUTE_TRANSACTION_REFUND,
                        key,
                        &request_digest,
                        lease_generation,
                        &complete,
                        DateTime::now(),
                    )
                    .await
                {
                    // Domain applied; leave started for recovery. 500 is client-ambiguous.
                    eprintln!("Failed to finalize refund idempotency record: {error:?}");
                    return error.into_response();
                }
                if let Some(identity) = effect_identity.as_ref() {
                    if let Ok(Some(tx)) =
                        transactions.find_one(doc! { "_id": transaction_id }).await
                    {
                        if let Ok(user_id) = tx.get_object_id("user") {
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
                                    UpdateModifications::Pipeline(
                                        prune_resolved_effect_slots_pipeline(now),
                                    ),
                                )
                                .await;
                        }
                    }
                }
            }
            (StatusCode::OK, Json(body_value)).into_response()
        }
        Err(RefundExecError::Client(response)) => response,
        Err(RefundExecError::Ambiguous(response)) => response,
    }
}

enum RefundExecError {
    /// Validation / conflict before durable money — safe pre-effect release may have run.
    Client(Response),
    /// After claim/credit: do not release; return 500 for reconciliation UX.
    Ambiguous(Response),
}

async fn execute_refund_state_machine(
    db: &mongodb::Database,
    transactions: &mongodb::Collection<Document>,
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    processor_id: ObjectId,
    transaction_id: ObjectId,
    reason: &str,
    active_key: Option<&str>,
    request_digest: &str,
    lease_generation: u64,
    effect_identity: Option<&EffectIdentity>,
) -> Result<Value, RefundExecError> {
    let Some(transaction) = (match transactions.find_one(doc! { "_id": transaction_id }).await {
        Ok(value) => value,
        Err(_) => {
            release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
            return Err(RefundExecError::Client(internal_error()));
        }
    }) else {
        release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
        return Err(RefundExecError::Client(status_message(
            StatusCode::NOT_FOUND,
            "Transaction not found",
        )));
    };

    // Resume path: transaction already claimed under our key — never treat claim alone as success.
    if transaction.get_bool("refunded").unwrap_or(false) {
        if let Some(key) = active_key {
            if transaction.get_str("idempotencyKey").ok() == Some(key) {
                return forward_refund_from_claim(
                    db,
                    transactions,
                    users,
                    adjustments,
                    &transaction,
                    processor_id,
                    transaction_id,
                    reason,
                    key,
                    effect_identity,
                )
                .await;
            }
            // Different key already refunded this resource.
            release_refund_started_pre_effect(db, processor_id, Some(key), request_digest, lease_generation).await;
            return Err(RefundExecError::Client(status_message(
                StatusCode::CONFLICT,
                "Transaksi ini sudah direfund",
            )));
        }
        return Err(RefundExecError::Client(status_message(
            StatusCode::CONFLICT,
            "Transaksi ini sudah direfund",
        )));
    }

    if read_string(&transaction, "status") == "success" {
        release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
        return Err(RefundExecError::Client(status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi sukses harus diubah ke failed dari edit status agar poin ikut direkonsiliasi",
        )));
    }
    let Some(user_id) = transaction.get_object_id("user").ok() else {
        release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
        return Err(RefundExecError::Client(status_message(
            StatusCode::NOT_FOUND,
            "User transaksi tidak ditemukan",
        )));
    };
    let amount = read_i64(&transaction, "amount");
    let Some(pre_claim_snapshot) = transaction_refund_snapshot(&transaction) else {
        release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
        return Err(RefundExecError::Client(internal_error()));
    };
    let refund_reason = build_refund_reason(&transaction_id, reason);
    let now = DateTime::now();

    // Phase: claimed — exclusive claim. Claim alone is NOT proof of credit/audit.
    let mut set_fields = doc! {
        "status": "failed",
        "refunded": true,
        "refundedBy": processor_id,
        "refundedAt": now,
        "refundReason": reason,
        "statusUpdatedBy": processor_id,
        "statusUpdatedAt": now,
        "statusUpdateNote": &refund_reason,
        "updatedAt": now,
        "refundPhase": REFUND_PHASE_CLAIMED,
    };
    if let Some(key) = active_key {
        set_fields.insert("idempotencyKey", key);
    }
    // Freeze an immutable response skeleton at claim time for exact replay later.
    if let Ok(skeleton) =
        serde_json::to_value(manual_transaction_item_from_doc(transaction.clone()))
    {
        set_fields.insert(
            "refundResponseSnapshotJson",
            serde_json::to_string(&skeleton).unwrap_or_default(),
        );
    }

    let claimed = match transactions
        .find_one_and_update(
            doc! {
                "_id": transaction_id,
                "refunded": { "$ne": true },
                "updatedAt": pre_claim_snapshot.updated_at,
            },
            doc! { "$set": set_fields },
        )
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => {
            if let Some(key) = active_key {
                if let Ok(Some(current)) =
                    transactions.find_one(doc! { "_id": transaction_id }).await
                {
                    if current.get_bool("refunded").unwrap_or(false)
                        && current.get_str("idempotencyKey").ok() == Some(key)
                    {
                        return forward_refund_from_claim(
                            db,
                            transactions,
                            users,
                            adjustments,
                            &current,
                            processor_id,
                            transaction_id,
                            reason,
                            key,
                            effect_identity,
                        )
                        .await;
                    }
                }
                // Lost the claim race without our key — pure pre-effect for us.
                release_refund_started_pre_effect(db, processor_id, Some(key), request_digest, lease_generation)
                    .await;
            }
            return Err(RefundExecError::Client(status_message(
                StatusCode::CONFLICT,
                "Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.",
            )));
        }
        Err(_) => {
            release_refund_started_pre_effect(db, processor_id, active_key, request_digest, lease_generation).await;
            return Err(RefundExecError::Client(internal_error()));
        }
    };

    // From here: claim is durable. Never release started; never unsafe rollback+delete.
    finish_refund_after_claim(
        db,
        transactions,
        users,
        adjustments,
        &claimed,
        processor_id,
        transaction_id,
        user_id,
        amount,
        reason,
        &refund_reason,
        active_key,
        effect_identity,
    )
    .await
}

async fn forward_refund_from_claim(
    db: &mongodb::Database,
    transactions: &mongodb::Collection<Document>,
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    claimed: &Document,
    processor_id: ObjectId,
    transaction_id: ObjectId,
    reason: &str,
    key: &str,
    effect_identity: Option<&EffectIdentity>,
) -> Result<Value, RefundExecError> {
    let phase = claimed
        .get_str("refundPhase")
        .unwrap_or(REFUND_PHASE_CLAIMED);
    // Only complete when credit (+ preferably audit) is proven.
    if phase == REFUND_PHASE_AUDITED || phase == REFUND_PHASE_CREDITED {
        if let Some(snapshot) =
            reconstruct_refund_snapshot_immutable(claimed, users, key, effect_identity).await
        {
            // Ensure audit exists if only credited.
            if phase == REFUND_PHASE_CREDITED {
                let _ = ensure_refund_audit(
                    adjustments,
                    claimed,
                    processor_id,
                    transaction_id,
                    reason,
                    key,
                    effect_identity,
                )
                .await;
                let _ = transactions
                    .update_one(
                        doc! {
                            "_id": transaction_id,
                            "idempotencyKey": key,
                            "refundPhase": REFUND_PHASE_CREDITED,
                        },
                        doc! { "$set": { "refundPhase": REFUND_PHASE_AUDITED, "updatedAt": DateTime::now() } },
                    )
                    .await;
            }
            return Ok(snapshot.body);
        }
    }

    let Some(user_id) = claimed.get_object_id("user").ok() else {
        return Err(RefundExecError::Ambiguous(internal_error()));
    };
    let amount = read_i64(claimed, "amount");
    let refund_reason = build_refund_reason(&transaction_id, reason);
    finish_refund_after_claim(
        db,
        transactions,
        users,
        adjustments,
        claimed,
        processor_id,
        transaction_id,
        user_id,
        amount,
        reason,
        &refund_reason,
        Some(key),
        effect_identity,
    )
    .await
}

async fn finish_refund_after_claim(
    _db: &mongodb::Database,
    transactions: &mongodb::Collection<Document>,
    users: &mongodb::Collection<Document>,
    adjustments: &mongodb::Collection<Document>,
    claimed: &Document,
    processor_id: ObjectId,
    transaction_id: ObjectId,
    user_id: ObjectId,
    amount: i64,
    reason: &str,
    refund_reason: &str,
    active_key: Option<&str>,
    effect_identity: Option<&EffectIdentity>,
) -> Result<Value, RefundExecError> {
    let now = DateTime::now();
    let key = active_key.unwrap_or("");

    // Phase: credited — atomic money + full-identity marker on user.
    let credit_applied = if key.is_empty() || effect_identity.is_none() {
        // Rollout-off path: best-effort credit without key coupling.
        match users
            .find_one_and_update(
                doc! { "_id": user_id },
                doc! { "$inc": { "balance": amount }, "$set": { "updatedAt": now } },
            )
            .return_document(ReturnDocument::After)
            .await
        {
            Ok(Some(_)) => true,
            Ok(None) => {
                return Err(RefundExecError::Ambiguous(internal_error()));
            }
            Err(_) => return Err(RefundExecError::Ambiguous(internal_error())),
        }
    } else {
        let identity = effect_identity.expect("checked above");
        let filter = refund_credit_filter(user_id, identity);
        let pipeline = refund_credit_pipeline(identity, amount, refund_reason, transaction_id, now);
        match users
            .find_one_and_update(filter, UpdateModifications::Pipeline(pipeline))
            .return_document(ReturnDocument::After)
            .await
        {
            Ok(Some(user)) => {
                // Freeze credit marker numbers onto the transaction for immutable audit/replay.
                if let Some(marker) = find_balance_effect_by_identity(&user, identity) {
                    if !effect_marker_matches_identity(&marker, identity) {
                        return Err(RefundExecError::Ambiguous(internal_error()));
                    }
                    let before = marker
                        .get("balanceBefore")
                        .cloned()
                        .unwrap_or(Bson::Int64(0));
                    let after = marker
                        .get("balanceAfter")
                        .cloned()
                        .unwrap_or(Bson::Int64(amount));
                    let _ = transactions
                        .update_one(
                            doc! { "_id": transaction_id, "idempotencyKey": key },
                            doc! {
                                "$set": {
                                    "refundBalanceBefore": before,
                                    "refundBalanceAfter": after,
                                    "refundPhase": REFUND_PHASE_CREDITED,
                                    "updatedAt": DateTime::now(),
                                }
                            },
                        )
                        .await;
                }
                true
            }
            Ok(None) => {
                // Already credited for this full identity, capacity exhausted, or missing user.
                let existing = users.find_one(doc! { "_id": user_id }).await.ok().flatten();
                match existing {
                    Some(user) if find_balance_effect_by_identity(&user, identity).is_some() => {
                        // Existing matching unresolved slot remains reconcilable at the cap.
                        true
                    }
                    Some(user) if is_effect_slot_capacity_rejection(Some(&user), identity) => {
                        // NEW credit blocked by unresolved/total slot cap. Claim is durable so
                        // leave started; surface a stable capacity outcome (no money mutation).
                        return Err(RefundExecError::Ambiguous(effect_slot_capacity_response()));
                    }
                    _ => {
                        // Claim durable but credit impossible — leave started; no release.
                        return Err(RefundExecError::Ambiguous(internal_error()));
                    }
                }
            }
            Err(error) => {
                eprintln!("Failed atomic refund credit+marker: {error}");
                return Err(RefundExecError::Ambiguous(internal_error()));
            }
        }
    };

    if !credit_applied {
        return Err(RefundExecError::Ambiguous(internal_error()));
    }

    if !key.is_empty() {
        let _ = transactions
            .update_one(
                doc! {
                    "_id": transaction_id,
                    "idempotencyKey": key,
                    "refundPhase": { "$in": [REFUND_PHASE_CLAIMED, REFUND_PHASE_CREDITED] },
                },
                doc! {
                    "$set": {
                        "refundPhase": REFUND_PHASE_CREDITED,
                        "updatedAt": DateTime::now(),
                    }
                },
            )
            .await;
    }

    // Phase: audited — insert once; failure leaves credited for forward reconcile.
    if let Err(error) = ensure_refund_audit(
        adjustments,
        claimed,
        processor_id,
        transaction_id,
        reason,
        if key.is_empty() { "" } else { key },
        effect_identity,
    )
    .await
    {
        eprintln!(
            "Failed refund audit after credit; leaving claimed/credited for reconcile: {error:?}"
        );
        return Err(RefundExecError::Ambiguous(internal_error()));
    }

    if !key.is_empty() {
        let _ = transactions
            .update_one(
                doc! {
                    "_id": transaction_id,
                    "idempotencyKey": key,
                },
                doc! {
                    "$set": {
                        "refundPhase": REFUND_PHASE_AUDITED,
                        "updatedAt": DateTime::now(),
                    }
                },
            )
            .await;
    }

    // Build immutable response from claim-time skeleton + refund stamps (not live population).
    let body = build_immutable_refund_response(claimed, reason)
        .or_else(|| {
            let item = manual_transaction_item_from_doc(claimed.clone());
            serde_json::to_value(&RefundResponse {
                message: "Saldo transaksi berhasil direfund",
                transaction: item,
            })
            .ok()
        })
        .ok_or_else(|| RefundExecError::Ambiguous(internal_error()))?;

    // Persist exact response body on the transaction for future exact replay.
    if !key.is_empty() {
        if let Ok(encoded) = serde_json::to_string(&body) {
            let _ = transactions
                .update_one(
                    doc! { "_id": transaction_id, "idempotencyKey": key },
                    doc! {
                        "$set": {
                            "refundCompletedResponseJson": encoded,
                            "updatedAt": DateTime::now(),
                        }
                    },
                )
                .await;
        }
    }

    Ok(body)
}

async fn ensure_refund_audit(
    adjustments: &mongodb::Collection<Document>,
    claimed: &Document,
    processor_id: ObjectId,
    transaction_id: ObjectId,
    reason: &str,
    key: &str,
    effect_identity: Option<&EffectIdentity>,
) -> Result<Option<ObjectId>, ()> {
    let user_id = claimed.get_object_id("user").map_err(|_| ())?;
    let amount = read_i64(claimed, "amount");
    let refund_reason = build_refund_reason(&transaction_id, reason);

    if let Some(identity) = effect_identity {
        if let Ok(Some(existing)) = adjustments
            .find_one(doc! {
                "idempotencyKey": &identity.idempotency_key,
                "adjustedBy": processor_id,
                "transactionId": transaction_id,
                "routeKey": ROUTE_TRANSACTION_REFUND,
                "requestDigest": &identity.request_digest,
            })
            .await
        {
            return Ok(existing.get_object_id("_id").ok());
        }
    } else if !key.is_empty() {
        if let Ok(Some(existing)) = adjustments
            .find_one(doc! {
                "idempotencyKey": key,
                "adjustedBy": processor_id,
                "user": user_id,
            })
            .await
        {
            return Ok(existing.get_object_id("_id").ok());
        }
    }

    // Prefer values frozen on the transaction after credit; else amount-only (immutable to retries).
    let balance_before = claimed
        .get_i64("refundBalanceBefore")
        .ok()
        .or_else(|| {
            claimed
                .get_f64("refundBalanceBefore")
                .ok()
                .map(|v| v as i64)
        })
        .unwrap_or(0);
    let balance_after = claimed
        .get_i64("refundBalanceAfter")
        .ok()
        .or_else(|| claimed.get_f64("refundBalanceAfter").ok().map(|v| v as i64))
        .unwrap_or(amount);

    let audit_now = DateTime::now();
    let mut audit_doc = doc! {
        "user": user_id,
        "adjustedBy": processor_id,
        "type": "add",
        "amount": amount,
        "balanceBefore": balance_before,
        "balanceAfter": balance_after,
        "reason": &refund_reason,
        "createdAt": audit_now,
        "updatedAt": audit_now,
        "__v": 0,
        "transactionId": transaction_id,
    };
    if let Some(identity) = effect_identity {
        audit_doc.insert("idempotencyKey", &identity.idempotency_key);
        audit_doc.insert("routeKey", ROUTE_TRANSACTION_REFUND);
        audit_doc.insert("requestDigest", &identity.request_digest);
        audit_doc.insert(
            "resourceId",
            identity
                .resource_id
                .clone()
                .unwrap_or_else(|| transaction_id.to_hex()),
        );
    } else if !key.is_empty() {
        audit_doc.insert("idempotencyKey", key);
    }
    match adjustments.insert_one(audit_doc).await {
        Ok(result) => Ok(result.inserted_id.as_object_id()),
        Err(error) => {
            if is_duplicate_key_error(&error) {
                if let Some(identity) = effect_identity {
                    if let Ok(Some(existing)) = adjustments
                        .find_one(doc! {
                            "idempotencyKey": &identity.idempotency_key,
                            "adjustedBy": processor_id,
                            "transactionId": transaction_id,
                            "routeKey": ROUTE_TRANSACTION_REFUND,
                            "requestDigest": &identity.request_digest,
                        })
                        .await
                    {
                        return Ok(existing.get_object_id("_id").ok());
                    }
                } else if !key.is_empty() {
                    if let Ok(Some(existing)) = adjustments
                        .find_one(doc! {
                            "idempotencyKey": key,
                            "adjustedBy": processor_id,
                            "user": user_id,
                        })
                        .await
                    {
                        return Ok(existing.get_object_id("_id").ok());
                    }
                }
            }
            eprintln!("Failed to insert refund audit: {error}");
            Err(())
        }
    }
}

fn build_immutable_refund_response(claimed: &Document, reason: &str) -> Option<Value> {
    if let Ok(raw) = claimed.get_str("refundCompletedResponseJson") {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            return Some(value);
        }
    }
    // Rebuild from claim-time JSON skeleton + refund fields (deterministic, not live joins).
    let mut item = if let Ok(raw) = claimed.get_str("refundResponseSnapshotJson") {
        serde_json::from_str::<ManualTransactionItemJson>(raw)
            .ok()
            .map(manual_item_from_json)
    } else {
        None
    }
    .unwrap_or_else(|| manual_transaction_item_from_doc(claimed.clone()));

    item.refunded = true;
    item.refund_reason = reason.to_string();
    item.refunded_at = claimed
        .get_datetime("refundedAt")
        .ok()
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .or(item.refunded_at);
    item.status = "failed".to_string();
    item.status_update_note = claimed
        .get_str("statusUpdateNote")
        .ok()
        .map(str::to_string)
        .unwrap_or(item.status_update_note);
    item.updated_at = claimed
        .get_datetime("updatedAt")
        .ok()
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or(item.updated_at);

    serde_json::to_value(&RefundResponse {
        message: "Saldo transaksi berhasil direfund",
        transaction: item,
    })
    .ok()
}

/// JSON-shaped mirror for immutable refund snapshots (serde only; not a Mongo model).
#[derive(serde::Deserialize)]
struct ManualTransactionItemJson {
    #[serde(rename = "_id")]
    id: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    amount: i64,
    #[serde(default)]
    status: String,
    #[serde(rename = "vendorTrxId", default)]
    vendor_trx_id: String,
    #[serde(rename = "customerRefId", default)]
    customer_ref_id: String,
    #[serde(default)]
    sn: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    refunded: bool,
    #[serde(rename = "refundedAt")]
    refunded_at: Option<String>,
    #[serde(rename = "refundReason", default)]
    refund_reason: String,
    #[serde(default)]
    source: String,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
    #[serde(rename = "statusUpdatedAt")]
    status_updated_at: Option<String>,
    #[serde(rename = "statusUpdateNote", default)]
    status_update_note: String,
    #[serde(default)]
    user: UserBriefJson,
    #[serde(default)]
    product: ProductBriefJson,
    #[serde(rename = "statusUpdatedBy", default)]
    status_updated_by: UserBriefJson,
    #[serde(rename = "discountVoucherCode", default)]
    discount_voucher_code: Option<String>,
    #[serde(rename = "discountAmount", default)]
    discount_amount: Option<i64>,
    #[serde(rename = "baseAmount", default)]
    base_amount: Option<i64>,
    #[serde(rename = "flashSale", default)]
    flash_sale: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct UserBriefJson {
    #[serde(rename = "_id", default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    role: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct ProductBriefJson {
    #[serde(rename = "_id", default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    brand: String,
    #[serde(rename = "vendorName", default)]
    vendor_name: String,
}

fn manual_item_from_json(value: ManualTransactionItemJson) -> ManualTransactionItem {
    ManualTransactionItem {
        id: value.id,
        target: value.target,
        amount: value.amount,
        status: value.status,
        vendor_trx_id: value.vendor_trx_id,
        customer_ref_id: value.customer_ref_id,
        sn: value.sn,
        message: value.message,
        refunded: value.refunded,
        refunded_at: value.refunded_at,
        refund_reason: value.refund_reason,
        source: value.source,
        created_at: value.created_at,
        updated_at: value.updated_at,
        status_updated_at: value.status_updated_at,
        status_update_note: value.status_update_note,
        discount_voucher_code: value.discount_voucher_code,
        discount_amount: value.discount_amount,
        base_amount: value.base_amount,
        flash_sale: value.flash_sale,
        user: UserBrief {
            id: value.user.id,
            name: value.user.name,
            email: value.user.email,
            role: value.user.role,
        },
        product: ProductBrief {
            id: value.product.id,
            name: value.product.name,
            code: value.product.code,
            category: value.product.category,
            brand: value.product.brand,
            vendor_name: value.product.vendor_name,
        },
        status_updated_by: UserBrief {
            id: value.status_updated_by.id,
            name: value.status_updated_by.name,
            email: value.status_updated_by.email,
            role: value.status_updated_by.role,
        },
    }
}

async fn reconstruct_refund_snapshot_immutable(
    claimed: &Document,
    users: &mongodb::Collection<Document>,
    key: &str,
    effect_identity: Option<&EffectIdentity>,
) -> Option<CompletedSnapshot> {
    let phase = claimed.get_str("refundPhase").ok()?;
    // Claim alone is never enough.
    if phase != REFUND_PHASE_CREDITED && phase != REFUND_PHASE_AUDITED {
        // Also accept credit marker on user even if phase lagging — full identity only.
        let user_id = claimed.get_object_id("user").ok()?;
        let user = users
            .find_one(doc! { "_id": user_id })
            .await
            .ok()
            .flatten()?;
        let has_credit = if let Some(identity) = effect_identity {
            find_balance_effect_by_identity(&user, identity).is_some()
        } else {
            false
        };
        if !has_credit {
            return None;
        }
    }
    let body = build_immutable_refund_response(
        claimed,
        claimed.get_str("refundReason").unwrap_or_default(),
    )?;
    let transaction_id = claimed.get_object_id("_id").ok()?;
    Some(CompletedSnapshot {
        status: 200,
        body,
        resource_id: Some(transaction_id.to_hex()),
    })
}

struct RefundMarkerRecovery<'a> {
    transactions: &'a mongodb::Collection<Document>,
    users: &'a mongodb::Collection<Document>,
    adjustments: &'a mongodb::Collection<Document>,
    processor_id: ObjectId,
    transaction_id: ObjectId,
    reason: String,
    request_digest: String,
}

impl DomainMarkerRecovery for RefundMarkerRecovery<'_> {
    async fn recover(
        &self,
        actor_id: ObjectId,
        route_key: &str,
        idempotency_key: &str,
        request_digest: &str,
    ) -> DomainRecovery {
        if route_key != ROUTE_TRANSACTION_REFUND || actor_id != self.processor_id {
            return DomainRecovery::None;
        }
        if request_digest != self.request_digest {
            return DomainRecovery::None;
        }
        let identity = EffectIdentity::refund(
            actor_id,
            idempotency_key,
            request_digest,
            self.transaction_id,
        );
        let Some(document) = (match self
            .transactions
            .find_one(doc! {
                "_id": self.transaction_id,
                "refunded": true,
                "refundedBy": self.processor_id,
                "refundReason": &self.reason,
                "idempotencyKey": idempotency_key,
            })
            .await
        {
            Ok(value) => value,
            Err(_) => return DomainRecovery::None,
        }) else {
            return DomainRecovery::None;
        };

        let phase = document
            .get_str("refundPhase")
            .unwrap_or(REFUND_PHASE_CLAIMED);

        // Claim alone is NOT completion proof.
        if phase == REFUND_PHASE_CLAIMED {
            // Credit marker may exist even if phase lagging.
            if let Ok(user_id) = document.get_object_id("user") {
                if let Ok(Some(user)) = self.users.find_one(doc! { "_id": user_id }).await {
                    if find_balance_effect_by_identity(&user, &identity).is_some() {
                        if let Some(snapshot) = reconstruct_refund_snapshot_immutable(
                            &document,
                            self.users,
                            idempotency_key,
                            Some(&identity),
                        )
                        .await
                        {
                            let has_audit = self
                                .adjustments
                                .find_one(doc! {
                                    "idempotencyKey": idempotency_key,
                                    "adjustedBy": self.processor_id,
                                    "transactionId": self.transaction_id,
                                    "routeKey": ROUTE_TRANSACTION_REFUND,
                                    "requestDigest": request_digest,
                                })
                                .await
                                .ok()
                                .flatten()
                                .is_some();
                            if has_audit {
                                return DomainRecovery::EffectApplied {
                                    snapshot: Some(snapshot),
                                };
                            }
                        }
                        return DomainRecovery::EffectApplied { snapshot: None };
                    }
                }
            }
            // Claim without credit: allow forward reconcile (Started), not success replay.
            return DomainRecovery::EffectApplied { snapshot: None };
        }

        if phase == REFUND_PHASE_CREDITED || phase == REFUND_PHASE_AUDITED {
            if let Some(snapshot) = reconstruct_refund_snapshot_immutable(
                &document,
                self.users,
                idempotency_key,
                Some(&identity),
            )
            .await
            {
                let has_audit = self
                    .adjustments
                    .find_one(doc! {
                        "idempotencyKey": idempotency_key,
                        "adjustedBy": self.processor_id,
                        "transactionId": self.transaction_id,
                        "routeKey": ROUTE_TRANSACTION_REFUND,
                        "requestDigest": request_digest,
                    })
                    .await
                    .ok()
                    .flatten()
                    .is_some();
                if has_audit || phase == REFUND_PHASE_AUDITED {
                    return DomainRecovery::EffectApplied {
                        snapshot: Some(snapshot),
                    };
                }
                return DomainRecovery::EffectApplied { snapshot: None };
            }
            return DomainRecovery::EffectApplied { snapshot: None };
        }

        DomainRecovery::EffectApplied { snapshot: None }
    }
}

/// Release only for pure pre-effect aborts (before claim). Never after claim/credit.
async fn release_refund_started_pre_effect(
    db: &mongodb::Database,
    processor_id: ObjectId,
    key: Option<&str>,
    request_digest: &str,
    lease_generation: u64,
) {
    let Some(key) = key else {
        return;
    };
    let store = MongoIdempotencyStore::new(db);
    let _ = store
        .release_started(
            processor_id,
            ROUTE_TRANSACTION_REFUND,
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

pub async fn update_status(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<StatusUpdatePayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "transactions.manual") {
        return response;
    }
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi tidak valid");
    };
    let payload = match normalize_status_payload(payload) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let transactions = db.collection::<Document>("transactions");
    let users = db.collection::<Document>("users");
    let point_transactions = db.collection::<Document>("pointtransactions");
    let settings = db.collection::<Document>("settings");
    let Some(transaction) = (match transactions.find_one(doc! { "_id": transaction_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "Transaction not found");
    };

    let Some(user_id) = transaction.get_object_id("user").ok() else {
        return status_message(StatusCode::NOT_FOUND, "User transaksi tidak ditemukan");
    };
    let amount = read_i64(&transaction, "amount");
    let Some(snapshot) = transaction_status_snapshot(&transaction) else {
        return internal_error();
    };
    let transition =
        apply_transition_plan(&snapshot.status, snapshot.refunded, amount, &payload.status);
    let audit_note = build_admin_status_note(&snapshot.status, &payload.status, &payload.note);

    let mut balance_delta_applied = 0;
    let mut points_revoked = 0;
    let mut points_awarded = 0;
    let mut claimed = false;

    let result = async {
        let now = DateTime::now();
        let mut set_fields = doc! {
            "status": &payload.status,
            "refunded": transition.next_refunded,
            "statusUpdatedBy": processor_id,
            "statusUpdatedAt": now,
            "updatedAt": now,
        };
        let mut unset_fields = Document::new();

        apply_optional_payload_string(
            &mut set_fields,
            &mut unset_fields,
            "vendorTrxId",
            &payload.vendor_trx_id,
        );
        apply_optional_payload_string(&mut set_fields, &mut unset_fields, "sn", &payload.sn);
        if payload.note.is_empty() {
            unset_fields.insert("statusUpdateNote", 1);
        } else {
            set_fields.insert("statusUpdateNote", payload.note.clone());
        }

        let mut update = doc! { "$set": set_fields };
        if !unset_fields.is_empty() {
            update.insert("$unset", unset_fields);
        }
        let updated_transaction = transactions
            .find_one_and_update(
                doc! {
                    "_id": transaction_id,
                    "status": &snapshot.status,
                    "refunded": snapshot.refunded,
                    "updatedAt": snapshot.updated_at,
                },
                update,
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| StatusUpdateError::Internal)?
            .ok_or(StatusUpdateError::Conflict)?;
        claimed = true;

        if transition.balance_delta != 0 {
            apply_user_balance_delta(&users, user_id, transition.balance_delta).await?;
            balance_delta_applied = transition.balance_delta;
        }

        if transition.should_revoke_points {
            points_revoked = revoke_awarded_points(
                &users,
                &point_transactions,
                user_id,
                transaction_id,
                &audit_note,
            )
            .await?;
        }

        if transition.should_award_points {
            points_awarded = award_points(
                &settings,
                &users,
                &point_transactions,
                user_id,
                amount,
                transaction_id,
                &audit_note,
            )
            .await?;
        }

        Ok::<Document, StatusUpdateError>(updated_transaction)
    }
    .await;

    let fallback_transaction = match result {
        Ok(transaction) => transaction,
        Err(error) => {
            if claimed {
                rollback_transaction_status(&transactions, transaction_id, &snapshot).await;
            }
            if points_awarded > 0 {
                let _ = revoke_awarded_points(
                    &users,
                    &point_transactions,
                    user_id,
                    transaction_id,
                    "Rollback points after failed transaction status update",
                )
                .await;
            }
            if points_revoked > 0 {
                let _ = award_points(
                    &settings,
                    &users,
                    &point_transactions,
                    user_id,
                    amount,
                    transaction_id,
                    "Rollback points after failed transaction status update",
                )
                .await;
            }
            if balance_delta_applied != 0 {
                let _ = apply_user_balance_delta(&users, user_id, -balance_delta_applied).await;
            }

            return error.into_response();
        }
    };

    let populated = match populated_transaction_item(&db, transaction_id).await {
        Some(item) => item,
        None => manual_transaction_item_from_doc(fallback_transaction),
    };
    Json(StatusUpdateResponse {
        message: "Transaction updated",
        transaction: populated,
    })
    .into_response()
}

pub async fn recheck_status(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi tidak valid");
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let transactions = db.collection::<Document>("transactions");
    let users = db.collection::<Document>("users");
    let point_transactions = db.collection::<Document>("pointtransactions");
    let settings = db.collection::<Document>("settings");
    let Some(transaction) = (match transactions.find_one(doc! { "_id": transaction_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "Transaction not found");
    };

    let current_status = read_string(&transaction, "status");
    if !matches!(current_status.as_str(), "pending" | "processing") {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Hanya transaksi pending/proses yang bisa dicek ulang ke vendor",
        );
    }

    let product = if let Ok(product_id) = transaction.get_object_id("product") {
        match find_product_for_recheck(&db, product_id).await {
            ProductRecheckTarget::Vendor(product) => Some(product),
            ProductRecheckTarget::Validation => {
                return status_message(
                    StatusCode::BAD_REQUEST,
                    "Produk validasi menunggu review manual dan tidak dicek ulang ke vendor",
                );
            }
            ProductRecheckTarget::Missing => None,
        }
    } else {
        None
    };
    let vendor_status = match check_vendor_status(&state, &transaction, product.as_ref()).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };

    if vendor_status.status == "pending" {
        let populated = populated_transaction_item(&db, transaction_id).await;
        return Json(RecheckResponse {
            changed: false,
            status: current_status,
            message: vendor_status.message.clone(),
            vendor_message: vendor_status.message,
            transaction: populated,
        })
        .into_response();
    }

    let Some(user_id) = transaction.get_object_id("user").ok() else {
        return status_message(StatusCode::NOT_FOUND, "User transaksi tidak ditemukan");
    };
    let amount = read_i64(&transaction, "amount");
    let Some(snapshot) = transaction_status_snapshot(&transaction) else {
        return internal_error();
    };
    let transition = apply_transition_plan(
        &snapshot.status,
        snapshot.refunded,
        amount,
        &vendor_status.status,
    );
    let audit_note = format!("Vendor recheck: {}", vendor_status.message);

    let mut balance_delta_applied = 0;
    let mut points_revoked = 0;
    let mut points_awarded = 0;
    let mut claimed = false;

    let result = async {
        let now = DateTime::now();
        let mut set_fields = doc! {
            "status": &vendor_status.status,
            "refunded": transition.next_refunded,
            "statusUpdatedBy": processor_id,
            "statusUpdatedAt": now,
            "statusUpdateNote": &audit_note,
            "updatedAt": now,
        };
        let mut unset_fields = Document::new();
        insert_optional_string_or_unset(
            &mut set_fields,
            &mut unset_fields,
            "sn",
            vendor_status.sn.as_deref(),
        );

        let mut update = doc! { "$set": set_fields };
        if !unset_fields.is_empty() {
            update.insert("$unset", unset_fields);
        }

        let updated_transaction = transactions
            .find_one_and_update(
                doc! {
                    "_id": transaction_id,
                    "status": &snapshot.status,
                    "refunded": snapshot.refunded,
                    "updatedAt": snapshot.updated_at,
                },
                update,
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(|_| StatusUpdateError::Internal)?
            .ok_or(StatusUpdateError::Conflict)?;
        claimed = true;

        if transition.balance_delta != 0 {
            apply_user_balance_delta(&users, user_id, transition.balance_delta).await?;
            balance_delta_applied = transition.balance_delta;
        }

        if transition.should_revoke_points {
            points_revoked = revoke_awarded_points(
                &users,
                &point_transactions,
                user_id,
                transaction_id,
                &audit_note,
            )
            .await?;
        }

        if transition.should_award_points {
            points_awarded = award_points(
                &settings,
                &users,
                &point_transactions,
                user_id,
                amount,
                transaction_id,
                &audit_note,
            )
            .await?;
        }

        Ok::<Document, StatusUpdateError>(updated_transaction)
    }
    .await;

    if let Err(error) = result {
        if claimed {
            rollback_transaction_status(&transactions, transaction_id, &snapshot).await;
        }
        if points_awarded > 0 {
            let _ = revoke_awarded_points(
                &users,
                &point_transactions,
                user_id,
                transaction_id,
                "Rollback points after failed transaction recheck",
            )
            .await;
        }
        if points_revoked > 0 {
            let _ = award_points(
                &settings,
                &users,
                &point_transactions,
                user_id,
                amount,
                transaction_id,
                "Rollback points after failed transaction recheck",
            )
            .await;
        }
        if balance_delta_applied != 0 {
            let _ = apply_user_balance_delta(&users, user_id, -balance_delta_applied).await;
        }

        return error.into_response();
    }

    let populated = populated_transaction_item(&db, transaction_id).await;
    Json(RecheckResponse {
        changed: true,
        status: vendor_status.status,
        message: "Status transaksi diperbarui dari vendor".to_string(),
        vendor_message: vendor_status.message,
        transaction: populated,
    })
    .into_response()
}

pub async fn member_transactions(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_user = match require_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = proxy_user.id;
    let role = proxy_user.role.as_str();
    let db = client.database(&state.mongo_db);
    let balance_filter = if matches!(role, "owner" | "admin" | "cs") {
        doc! {}
    } else {
        doc! { "user": user_id }
    };
    let balance_transactions = load_sorted_docs(&db, "transactions", balance_filter).await;
    let products = transaction_products(&db, &balance_transactions).await;
    let users = transaction_users(&db, &balance_transactions).await;
    let mut items = balance_transactions
        .into_iter()
        .map(|document| balance_transaction_json(document, &users, &products))
        .collect::<Vec<_>>();

    if !matches!(role, "owner" | "admin" | "cs") {
        let guest_transactions =
            load_sorted_docs(&db, "guesttransactions", doc! { "user": user_id }).await;
        let guest_products = transaction_products(&db, &guest_transactions).await;
        items.extend(
            guest_transactions
                .into_iter()
                .map(|document| guest_transaction_json(document, user_id, &guest_products)),
        );
    }

    items.sort_by(|left, right| json_date(right, "createdAt").cmp(&json_date(left, "createdAt")));
    Json(Value::Array(items)).into_response()
}

fn manual_transaction_item_from_doc(mut document: Document) -> ManualTransactionItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();

    ManualTransactionItem {
        id,
        target: read_string(&document, "target"),
        amount: read_i64(&document, "amount"),
        status: read_string(&document, "status"),
        vendor_trx_id: read_string(&document, "vendorTrxId"),
        customer_ref_id: read_string(&document, "customerRefId"),
        sn: read_string(&document, "sn"),
        message: read_string(&document, "message"),
        refunded: document.get_bool("refunded").unwrap_or(false),
        refunded_at: date_string(&document, "refundedAt"),
        refund_reason: read_string(&document, "refundReason"),
        source: non_empty_or(read_string(&document, "source"), "web"),
        created_at: date_string(&document, "createdAt").unwrap_or_default(),
        updated_at: date_string(&document, "updatedAt").unwrap_or_default(),
        status_updated_at: date_string(&document, "statusUpdatedAt"),
        status_update_note: read_string(&document, "statusUpdateNote"),
        user: document
            .get_document("user")
            .ok()
            .and_then(user_brief_from_doc)
            .unwrap_or_default(),
        product: document
            .get_document("product")
            .ok()
            .and_then(product_brief_from_doc)
            .unwrap_or_default(),
        status_updated_by: document
            .get_document("statusUpdatedBy")
            .ok()
            .and_then(user_brief_from_doc)
            .unwrap_or_default(),
        discount_voucher_code: document
            .get_str("discountVoucherCode")
            .ok()
            .map(ToString::to_string)
            .filter(|value| !value.is_empty()),
        discount_amount: document
            .get("discountAmount")
            .and_then(|value| match value {
                Bson::Int32(v) => Some(i64::from(*v)),
                Bson::Int64(v) => Some(*v),
                Bson::Double(v) => Some(*v as i64),
                _ => None,
            })
            .filter(|value| *value > 0),
        base_amount: document
            .get("baseAmount")
            .and_then(|value| match value {
                Bson::Int32(v) => Some(i64::from(*v)),
                Bson::Int64(v) => Some(*v),
                Bson::Double(v) => Some(*v as i64),
                _ => None,
            })
            .filter(|value| *value > 0),
        flash_sale: document
            .get_object_id("flashSale")
            .ok()
            .map(|id| id.to_hex())
            .or_else(|| {
                document
                    .get_str("flashSale")
                    .ok()
                    .map(ToString::to_string)
                    .filter(|value| !value.is_empty())
            }),
    }
}

fn transaction_refund_snapshot(document: &Document) -> Option<TransactionRefundSnapshot> {
    Some(TransactionRefundSnapshot {
        status: read_string(document, "status"),
        updated_at: *document.get_datetime("updatedAt").ok()?,
        refunded: document.get_bool("refunded").unwrap_or(false),
        refunded_by: document.get_object_id("refundedBy").ok(),
        refunded_at: document.get_datetime("refundedAt").ok().copied(),
        refund_reason: document
            .get_str("refundReason")
            .ok()
            .map(ToString::to_string),
        status_updated_by: document.get_object_id("statusUpdatedBy").ok(),
        status_updated_at: document.get_datetime("statusUpdatedAt").ok().copied(),
        status_update_note: document
            .get_str("statusUpdateNote")
            .ok()
            .map(ToString::to_string),
    })
}

fn build_refund_reason(transaction_id: &ObjectId, reason: &str) -> String {
    let id = transaction_id.to_hex();
    let suffix = id
        .get(id.len().saturating_sub(8)..)
        .unwrap_or(id.as_str())
        .to_uppercase();
    format!("Refund transaksi {suffix}: {reason}")
}

async fn rollback_transaction_refund(
    transactions: &mongodb::Collection<Document>,
    transaction_id: ObjectId,
    snapshot: &TransactionRefundSnapshot,
) {
    let mut set_fields = doc! {
        "status": &snapshot.status,
        "refunded": snapshot.refunded,
        "updatedAt": snapshot.updated_at,
    };
    let mut unset_fields = Document::new();
    insert_optional_object_id_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "refundedBy",
        snapshot.refunded_by,
    );
    insert_optional_datetime_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "refundedAt",
        snapshot.refunded_at,
    );
    insert_optional_string_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "refundReason",
        snapshot.refund_reason.as_deref(),
    );
    insert_optional_object_id_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdatedBy",
        snapshot.status_updated_by,
    );
    insert_optional_datetime_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdatedAt",
        snapshot.status_updated_at,
    );
    insert_optional_string_or_unset(
        &mut set_fields,
        &mut unset_fields,
        "statusUpdateNote",
        snapshot.status_update_note.as_deref(),
    );

    let mut update = doc! { "$set": set_fields };
    if !unset_fields.is_empty() {
        update.insert("$unset", unset_fields);
    }
    let _ = transactions
        .update_one(doc! { "_id": transaction_id }, update)
        .await;
}

fn normalize_status_payload(payload: StatusUpdatePayload) -> Result<StatusPayload, Response> {
    let status = payload.status.unwrap_or_default().trim().to_string();
    if !ALLOWED_TRANSACTION_STATUSES.contains(&status.as_str()) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Status transaksi tidak valid",
        ));
    }

    let note_source = payload.note.or(payload.message);
    let note = note_source.unwrap_or_default().trim().to_string();
    if note.len() > 500 {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Catatan status maksimal 500 karakter",
        ));
    }

    let vendor_trx_id = match payload.vendor_trx_id {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > 120 {
                return Err(status_message(
                    StatusCode::BAD_REQUEST,
                    "Vendor Trx ID maksimal 120 karakter",
                ));
            }
            Some(value)
        }
        None => None,
    };
    let sn = match payload.sn {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > 300 {
                return Err(status_message(
                    StatusCode::BAD_REQUEST,
                    "SN / Token maksimal 300 karakter",
                ));
            }
            Some(value)
        }
        None => None,
    };

    Ok(StatusPayload {
        status,
        vendor_trx_id,
        sn,
        note,
    })
}

fn build_admin_status_note(previous_status: &str, next_status: &str, note: &str) -> String {
    if note.is_empty() {
        format!("Manual status update: {previous_status} -> {next_status}")
    } else {
        note.to_string()
    }
}

fn normalize_payload_text(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

async fn active_maintenance_message(db: &mongodb::Database) -> Option<String> {
    let settings = db.collection::<Document>("settings");
    let maintenance = settings
        .find_one(doc! { "key": "maintenanceMode" })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| bson_to_bool(&value))
        .unwrap_or(false);
    if !maintenance {
        return None;
    }

    let message = settings
        .find_one(doc! { "key": "maintenanceMessage" })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .and_then(|value| match value {
            Bson::String(value) => Some(value.trim().to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.".to_string()
        });
    Some(message)
}

fn bson_to_bool(value: &Bson) -> bool {
    match value {
        Bson::Boolean(value) => *value,
        Bson::String(value) => value == "true" || value == "1",
        Bson::Int32(value) => *value != 0,
        Bson::Int64(value) => *value != 0,
        Bson::Double(value) => *value != 0.0,
        _ => false,
    }
}

fn product_price_for_level(product: &Document, level: &str) -> i64 {
    let price = product.get_document("price").ok();
    let key = if matches!(level, "gold" | "platinum") {
        level
    } else {
        "basic"
    };
    price
        .map(|document| read_i64(document, key))
        .filter(|value| *value > 0)
        .unwrap_or(0)
}

async fn product_purchase_issues(db: &mongodb::Database, product: &Document) -> Vec<String> {
    let mut issues = Vec::new();
    if referenced_status_false(db, "categories", product.get_object_id("categoryId").ok()).await
        || named_status_false(db, "categories", &read_string(product, "category")).await
    {
        issues.push("Kategori nonaktif".to_string());
    }
    if referenced_status_false(db, "operators", product.get_object_id("operatorId").ok()).await
        || named_status_false(db, "operators", &read_string(product, "brand")).await
    {
        issues.push("Operator nonaktif".to_string());
    }
    if referenced_status_false(
        db,
        "producttypes",
        product.get_object_id("productTypeId").ok(),
    )
    .await
    {
        issues.push("Jenis produk nonaktif".to_string());
    }
    issues
}

async fn referenced_status_false(
    db: &mongodb::Database,
    collection: &str,
    id: Option<ObjectId>,
) -> bool {
    let Some(id) = id else {
        return false;
    };
    db.collection::<Document>(collection)
        .find_one(doc! { "_id": id })
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
}

async fn named_status_false(db: &mongodb::Database, collection: &str, name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    db.collection::<Document>(collection)
        .find_one(
            doc! { "name": { "$regex": format!("^{}$", escape_regex(name)), "$options": "i" } },
        )
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
}

async fn reserve_flash_sale_stock(
    db: &mongodb::Database,
    product_id: Option<ObjectId>,
    base_price: i64,
) -> Option<FlashSaleReservation> {
    let product_id = product_id?;
    let now = DateTime::now();
    let flash_sale = db
        .collection::<Document>("flashsales")
        .find_one(doc! {
            "isActive": true,
            "startDate": { "$lte": now },
            "endDate": { "$gte": now },
            "products.productId": product_id,
        })
        .await
        .ok()
        .flatten()?;
    let products = flash_sale.get_array("products").ok()?;
    let flash_product = products.iter().find_map(|value| match value {
        Bson::Document(document)
            if document.get_object_id("productId").ok() == Some(product_id) =>
        {
            Some(document)
        }
        _ => None,
    })?;
    let stock = read_i64(flash_product, "stock");
    let sold_count = read_i64(flash_product, "soldCount");
    if stock - sold_count <= 0 {
        return None;
    }
    let discount_type = read_string(flash_product, "discountType");
    let discount_value = read_i64(flash_product, "discountValue");
    let price = if discount_type == "percentage" {
        (base_price - ((base_price * discount_value) / 100)).max(0)
    } else {
        (base_price - discount_value).max(0)
    };
    let flash_sale_id = flash_sale.get_object_id("_id").ok()?;
    let result = db
        .collection::<Document>("flashsales")
        .update_one(
            doc! {
                "_id": flash_sale_id,
                "products.productId": product_id,
                "$expr": {
                    "$gt": [
                        {
                            "$size": {
                                "$filter": {
                                    "input": "$products",
                                    "as": "product",
                                    "cond": {
                                        "$and": [
                                            { "$eq": ["$$product.productId", product_id] },
                                            { "$gt": [{ "$subtract": ["$$product.stock", "$$product.soldCount"] }, 0] }
                                        ]
                                    }
                                }
                            }
                        },
                        0
                    ]
                },
            },
            doc! { "$inc": { "products.$.soldCount": 1 } },
        )
        .await
        .ok()?;
    if result.modified_count == 0 {
        return None;
    }
    Some(FlashSaleReservation {
        flash_sale_id,
        product_id,
        price,
    })
}

async fn rollback_flash_sale_stock(
    db: &mongodb::Database,
    reservation: Option<&FlashSaleReservation>,
) {
    let Some(reservation) = reservation else {
        return;
    };
    let _ = db
        .collection::<Document>("flashsales")
        .update_one(
            doc! { "_id": reservation.flash_sale_id, "products.productId": reservation.product_id },
            doc! { "$inc": { "products.$.soldCount": -1 } },
        )
        .await;
}

async fn generate_ref_id(db: &mongodb::Database) -> Result<String, ()> {
    let settings = db.collection::<Document>("settings");
    let prefix = setting_string(&settings, "refIdPrefix", "REF").await;
    let date_format = setting_string(&settings, "refIdDateFormat", "DDMMYYYY").await;
    let separator = setting_string(&settings, "refIdSeparator", "").await;
    let digits = setting_i64(&settings, "refIdSequenceDigits", 4)
        .await
        .clamp(1, 10) as usize;
    let now = Local::now();
    let start = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .ok_or(())?
        .timestamp_millis();
    let end = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 23, 59, 59)
        .single()
        .ok_or(())?
        .timestamp_millis()
        + 999;
    let today_count = db
        .collection::<Document>("transactions")
        .count_documents(doc! {
            "createdAt": {
                "$gte": DateTime::from_millis(start),
                "$lte": DateTime::from_millis(end),
            }
        })
        .await
        .map_err(|_| ())?;
    let date_part = format_ref_date(&date_format, now.day(), now.month(), now.year());
    let sequence = format!("{:0width$}", today_count + 1, width = digits);
    Ok(vec![prefix, date_part, sequence]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(&separator))
}

async fn setting_string(
    collection: &mongodb::Collection<Document>,
    key: &str,
    fallback: &str,
) -> String {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .and_then(|value| match value {
            Bson::String(value) => Some(value),
            _ => Some(value.to_string()),
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

async fn setting_i64(collection: &mongodb::Collection<Document>, key: &str, fallback: i64) -> i64 {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| bson_number_to_i64(&value))
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn format_ref_date(format: &str, day: u32, month: u32, year: i32) -> String {
    let yy = year.rem_euclid(100).to_string();
    match format {
        "YYYYMMDD" => format!("{year:04}{month:02}{day:02}"),
        "MMDDYYYY" => format!("{month:02}{day:02}{year:04}"),
        "DDMMYY" => format!("{day:02}{month:02}{yy:0>2}"),
        "YYMMDD" => format!("{yy:0>2}{month:02}{day:02}"),
        "NONE" => String::new(),
        _ => format!("{day:02}{month:02}{year:04}"),
    }
}

fn recheck_product_from_product_doc(product: &Document) -> RecheckProduct {
    let vendor = product.get_document("vendor").ok();
    let code = read_string(product, "code");
    RecheckProduct {
        code: code.clone(),
        vendor_name: vendor
            .map(|value| read_string(value, "name"))
            .unwrap_or_default(),
        vendor_sku: vendor
            .map(|value| read_string(value, "sku"))
            .filter(|value| !value.is_empty())
            .unwrap_or(code),
    }
}

async fn apply_initial_validation_result(
    db: &mongodb::Database,
    transaction_id: ObjectId,
    user_id: ObjectId,
    price: i64,
    validation_result: super::validation_engine::PaidValidationResult,
) {
    let transactions = db.collection::<Document>("transactions");
    let users = db.collection::<Document>("users");
    let mut set_fields = doc! {
        "updatedAt": DateTime::now(),
        "message": validation_result.message.clone(),
    };
    match validation_result.status {
        PaidValidationStatus::Success => {
            set_fields.insert("status", "success");
            set_fields.insert(
                "statusUpdateNote",
                format!("Validasi otomatis berhasil: {}", validation_result.message),
            );
            if let Some(sn) = validation_result.sn {
                set_fields.insert("sn", sn);
            }
        }
        PaidValidationStatus::Failed => {
            set_fields.insert("status", "failed");
            set_fields.insert(
                "statusUpdateNote",
                format!("Validasi otomatis gagal: {}", validation_result.message),
            );
            set_fields.insert("refunded", true);
            set_fields.insert("refundedAt", DateTime::now());
            set_fields.insert("refundReason", "Validasi otomatis gagal");
        }
        PaidValidationStatus::ProviderError => {
            set_fields.insert("status", "pending");
            set_fields.insert(
                "statusUpdateNote",
                format!("Validasi otomatis tertunda: {}", validation_result.message),
            );
        }
    }
    let _ = transactions
        .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_fields })
        .await;

    if validation_result.status == PaidValidationStatus::Failed {
        let _ = apply_user_balance_delta(&users, user_id, price).await;
    }

    if validation_result.status == PaidValidationStatus::Success {
        let _ = award_points(
            &db.collection::<Document>("settings"),
            &users,
            &db.collection::<Document>("pointtransactions"),
            user_id,
            price,
            transaction_id,
            &format!("Earned from transaction - Rp {}", format_idr_amount(price)),
        )
        .await;
    }
}

async fn apply_initial_vendor_result(
    db: &mongodb::Database,
    transaction_id: ObjectId,
    user_id: ObjectId,
    price: i64,
    vendor_result: &VendorTopUpResult,
) {
    let transactions = db.collection::<Document>("transactions");
    let users = db.collection::<Document>("users");
    let mut set_fields = doc! {
        "status": &vendor_result.status,
        "updatedAt": DateTime::now(),
    };
    if let Some(value) = &vendor_result.vendor_trx_id {
        set_fields.insert("vendorTrxId", value.clone());
    }
    if let Some(value) = &vendor_result.sn {
        set_fields.insert("sn", value.clone());
    }
    if let Some(value) = &vendor_result.message {
        set_fields.insert("message", value.clone());
    }
    let _ = transactions
        .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_fields })
        .await;

    if vendor_result.status == "failed" {
        let _ = apply_user_balance_delta(&users, user_id, price).await;
        let _ = transactions
            .update_one(
                doc! { "_id": transaction_id },
                doc! {
                    "$set": {
                        "refunded": true,
                        "refundedAt": DateTime::now(),
                        "refundReason": "Vendor returned failed during initial processing",
                        "updatedAt": DateTime::now(),
                    }
                },
            )
            .await;
    }

    if vendor_result.status == "success" {
        let _ = award_points(
            &db.collection::<Document>("settings"),
            &users,
            &db.collection::<Document>("pointtransactions"),
            user_id,
            price,
            transaction_id,
            &format!("Earned from transaction - Rp {}", format_idr_amount(price)),
        )
        .await;
    }
}

enum ProductRecheckTarget {
    Vendor(RecheckProduct),
    Validation,
    Missing,
}

async fn find_product_for_recheck(
    db: &mongodb::Database,
    product_id: ObjectId,
) -> ProductRecheckTarget {
    let Some(document) = db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .projection(doc! { "code": 1, "vendor": 1, "validation": 1 })
        .await
        .ok()
        .flatten()
    else {
        return ProductRecheckTarget::Missing;
    };
    if product_validation_config(&document).is_some() {
        return ProductRecheckTarget::Validation;
    }
    let vendor = document.get_document("vendor").ok();
    let code = read_string(&document, "code");
    ProductRecheckTarget::Vendor(RecheckProduct {
        code: code.clone(),
        vendor_name: vendor
            .map(|value| read_string(value, "name"))
            .unwrap_or_default(),
        vendor_sku: vendor
            .map(|value| read_string(value, "sku"))
            .filter(|value| !value.is_empty())
            .unwrap_or(code),
    })
}

fn bson_number_to_i64(value: &Bson) -> i64 {
    match value {
        Bson::Int32(value) => i64::from(*value),
        Bson::Int64(value) => *value,
        Bson::Double(value) => *value as i64,
        Bson::String(value) => value.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

enum StatusUpdateError {
    Conflict,
    UserNotFound,
    InsufficientBalance(i64),
    InsufficientPoints,
    Internal,
}

impl StatusUpdateError {
    fn into_response(self) -> Response {
        match self {
            StatusUpdateError::Conflict => status_message(
                StatusCode::CONFLICT,
                "Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.",
            ),
            StatusUpdateError::UserNotFound => {
                status_message(StatusCode::NOT_FOUND, "User transaksi tidak ditemukan")
            }
            StatusUpdateError::InsufficientBalance(amount) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "message": format!(
                        "Saldo user tidak cukup untuk memproses ulang transaksi. Dibutuhkan Rp{}.",
                        format_idr_amount(amount)
                    )
                })),
            )
                .into_response(),
            StatusUpdateError::InsufficientPoints => internal_error(),
            StatusUpdateError::Internal => internal_error(),
        }
    }
}

fn format_idr_amount(amount: i64) -> String {
    let mut digits = amount.abs().to_string();
    let mut parts = Vec::new();
    while digits.len() > 3 {
        let split_at = digits.len() - 3;
        parts.push(digits.split_off(split_at));
    }
    parts.push(digits);
    parts.reverse();
    let formatted = parts.join(".");
    if amount < 0 {
        format!("-{formatted}")
    } else {
        formatted
    }
}

async fn populated_transaction_item(
    db: &mongodb::Database,
    transaction_id: ObjectId,
) -> Option<ManualTransactionItem> {
    let document = db
        .collection::<Document>("transactions")
        .aggregate(vec![
            doc! { "$match": { "_id": transaction_id } },
            lookup_stage("users", "user", "user"),
            unwind_stage("$user"),
            lookup_stage("products", "product", "product"),
            unwind_stage("$product"),
            lookup_stage("users", "statusUpdatedBy", "statusUpdatedBy"),
            unwind_stage("$statusUpdatedBy"),
            doc! { "$limit": 1 },
        ])
        .await
        .ok()?
        .try_collect::<Vec<_>>()
        .await
        .ok()?
        .into_iter()
        .next()?;
    Some(manual_transaction_item_from_doc(document))
}

async fn load_sorted_docs(
    db: &mongodb::Database,
    collection: &str,
    filter: Document,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn transaction_users(
    db: &mongodb::Database,
    transactions: &[Document],
) -> HashMap<String, Value> {
    let mut ids = transactions
        .iter()
        .filter_map(|doc| doc.get_object_id("user").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>("users")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "email": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = doc
                    .get_object_id("_id")
                    .map(|id| id.to_hex())
                    .unwrap_or_default();
                (id, document_to_json(doc))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

async fn transaction_products(
    db: &mongodb::Database,
    transactions: &[Document],
) -> HashMap<String, Value> {
    let mut ids = transactions
        .iter()
        .filter_map(|doc| doc.get_object_id("product").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "code": 1, "name": 1, "category": 1, "brand": 1, "vendor": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = doc
                    .get_object_id("_id")
                    .map(|id| id.to_hex())
                    .unwrap_or_default();
                (id, document_to_json(doc))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

fn balance_transaction_json(
    document: Document,
    users: &HashMap<String, Value>,
    products: &HashMap<String, Value>,
) -> Value {
    let user_id = document
        .get_object_id("user")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product_id = document
        .get_object_id("product")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let mut map = document_to_map(document);
    map.insert(
        "user".to_string(),
        users
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "_id": user_id })),
    );
    if let Some(product) = products.get(&product_id) {
        map.insert("product".to_string(), product.clone());
    }
    map.insert("source".to_string(), Value::String("balance".to_string()));
    Value::Object(map)
}

fn guest_transaction_json(
    document: Document,
    user_id: ObjectId,
    products: &HashMap<String, Value>,
) -> Value {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product_id = document
        .get_object_id("product")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let mut map = Map::new();
    map.insert("_id".to_string(), Value::String(id));
    map.insert(
        "user".to_string(),
        serde_json::json!({ "_id": user_id.to_hex() }),
    );
    if let Some(product) = products.get(&product_id) {
        map.insert("product".to_string(), product.clone());
    }
    map.insert(
        "target".to_string(),
        bson_to_json(document.get("target").cloned().unwrap_or(Bson::Null)),
    );
    map.insert(
        "amount".to_string(),
        bson_to_json(document.get("totalAmount").cloned().unwrap_or(Bson::Null)),
    );
    map.insert(
        "status".to_string(),
        bson_to_json(
            document
                .get("transactionStatus")
                .cloned()
                .unwrap_or(Bson::Null),
        ),
    );
    if let Some(value) = document.get("vendorTrxId").cloned() {
        map.insert("vendorTrxId".to_string(), bson_to_json(value));
    }
    if let Some(value) = document.get("sn").cloned() {
        map.insert("sn".to_string(), bson_to_json(value));
    }
    map.insert(
        "paymentStatus".to_string(),
        bson_to_json(document.get("paymentStatus").cloned().unwrap_or(Bson::Null)),
    );
    map.insert(
        "invoiceNumber".to_string(),
        bson_to_json(document.get("invoiceNumber").cloned().unwrap_or(Bson::Null)),
    );
    map.insert(
        "source".to_string(),
        Value::String("payment_gateway".to_string()),
    );
    map.insert(
        "createdAt".to_string(),
        bson_to_json(document.get("createdAt").cloned().unwrap_or(Bson::Null)),
    );
    map.insert(
        "updatedAt".to_string(),
        bson_to_json(document.get("updatedAt").cloned().unwrap_or(Bson::Null)),
    );
    Value::Object(map)
}

fn json_date(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn user_brief_from_doc(document: &Document) -> Option<UserBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(UserBrief {
        id,
        name: read_string(document, "name"),
        email: read_string(document, "email"),
        role: document.get_str("role").ok().map(ToString::to_string),
    })
}

fn product_brief_from_doc(document: &Document) -> Option<ProductBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(ProductBrief {
        id,
        name: read_string(document, "name"),
        code: read_string(document, "code"),
        category: read_string(document, "category"),
        brand: read_string(document, "brand"),
        vendor_name: read_string(document, "vendorName"),
    })
}

fn date_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .ok()
}

fn date_key(date: DateTime) -> String {
    date.try_to_rfc3339_string()
        .ok()
        .and_then(|value| value.get(0..10).map(ToString::to_string))
        .unwrap_or_else(|| "unknown-date".to_string())
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}

fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}

fn non_empty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}
