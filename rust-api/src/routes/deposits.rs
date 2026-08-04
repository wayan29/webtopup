use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::ReturnDocument,
};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_member_user, require_permission, ErrorResponse},
    state::AppState,
    utils::{
        bson::{read_i64, read_string},
        dates::timestamp_now,
    },
};

const DEPOSIT_EXPORT_LIMIT: i64 = 5000;

mod mappers;
mod processing;
mod queries;
mod queue;
mod responses;
mod settings;
mod types;
mod utils;

use mappers::*;
use processing::*;
use queries::*;
use queue::*;
use responses::*;
use settings::*;
use types::*;
use utils::*;

pub async fn deposit_queue_snapshot(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "viewDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("deposits");
    let actor_id = Some(proxy_user.id);
    let summary = build_deposit_queue_summary(&collection, actor_id).await;
    let latest = latest_pending_deposits(&collection).await;

    Json(DepositQueueSnapshotResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        user: Some(proxy_user.into_response()),
        summary,
        latest,
    })
    .into_response()
}

pub async fn member_list(
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
    let filter = doc! { "user": user_id };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("deposits")
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let users = member_deposit_users(&db, &docs).await;
    let payment_methods = member_deposit_payment_methods(&db, &docs).await;
    Json(
        docs.into_iter()
            .map(|document| member_deposit_item_from_doc(document, &users, &payment_methods))
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn request_deposit(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RequestDepositPayload>,
) -> Response {
    let proxy_user = match require_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = proxy_user.id;
    let amount = match normalize_deposit_amount(payload.amount) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let payment_method_id = match payload
        .payment_method_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => match ObjectId::parse_str(value) {
            Ok(id) => id,
            Err(_) => {
                return status_message(
                    axum::http::StatusCode::NOT_FOUND,
                    "Payment method not found",
                )
            }
        },
        None => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Payment method is required",
            )
        }
    };

    let db = client.database(&state.mongo_db);
    let settings = deposit_settings(&db).await;
    if setting_bool(&settings, "maintenanceMode", false) {
        return status_message_owned(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            maintenance_message(&settings),
        );
    }
    let min_deposit = setting_i64(&settings, "minDeposit", 10_000);
    let max_deposit = setting_i64(&settings, "maxDeposit", 10_000_000);
    if amount < min_deposit || amount > max_deposit {
        return status_message_owned(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Nominal deposit global harus di antara Rp {} dan Rp {}",
                format_idr(min_deposit),
                format_idr(max_deposit)
            ),
        );
    }

    let payment_method = db
        .collection::<Document>("paymentmethods")
        .find_one(doc! { "_id": payment_method_id })
        .await
        .ok()
        .flatten();
    let Some(payment_method) = payment_method else {
        return status_message(
            axum::http::StatusCode::NOT_FOUND,
            "Payment method not found",
        );
    };
    if read_string(&payment_method, "status") != "active" {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payment method is not active",
        );
    }
    let category_id = payment_method.get_object_id("category").ok();
    let category_active = if let Some(category_id) = category_id {
        db.collection::<Document>("paymentcategories")
            .find_one(doc! { "_id": category_id })
            .projection(doc! { "status": 1 })
            .await
            .ok()
            .flatten()
            .map(|doc| read_string(&doc, "status") == "active")
            .unwrap_or(false)
    } else {
        false
    };
    if !category_active {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Payment category is not available",
        );
    }

    let operational_start = read_string(&payment_method, "operationalStart");
    let operational_end = read_string(&payment_method, "operationalEnd");
    if !is_operational_now(&operational_start, &operational_end) {
        return status_message_owned(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Payment method is available only between {} and {}",
                operational_start, operational_end
            ),
        );
    }

    let min_amount = read_i64(&payment_method, "minAmount");
    let max_amount = read_i64(&payment_method, "maxAmount");
    if amount < min_amount || amount > max_amount {
        return status_message_owned(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Amount must be between Rp {} and Rp {}",
                format_idr(min_amount),
                format_idr(max_amount)
            ),
        );
    }

    let admin_fee_fixed = read_i64(&payment_method, "adminFee");
    let admin_fee_percent = round_percent(amount, read_number_f64(&payment_method, "adminPercent"));
    let payment_method_fee = admin_fee_fixed + admin_fee_percent;
    let global_fee_value = setting_i64(&settings, "depositFee", 0);
    let global_fee = if setting_string(&settings, "depositFeeType", "fixed") == "percent" {
        round_percent(amount, global_fee_value as f64)
    } else {
        global_fee_value
    };
    let total_admin_fee = payment_method_fee + global_fee;
    if amount - total_admin_fee <= 0 {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Biaya admin metode pembayaran ini melebihi nominal deposit. Hubungi admin.",
        );
    }
    let unique_code = if payment_method.get_bool("useUniqueCode").unwrap_or(true) {
        generate_unique_code()
    } else {
        0
    };
    let total_amount = amount + unique_code;
    let now = DateTime::now();
    let inserted = db
        .collection::<Document>("deposits")
        .insert_one(doc! {
            "user": user_id,
            "amount": amount,
            "uniqueCode": unique_code,
            "totalAmount": total_amount,
            "adminFee": total_admin_fee,
            "paymentMethod": payment_method_id,
            "status": "pending",
            "createdAt": now,
            "updatedAt": now,
            "__v": 0,
        })
        .await;
    let Ok(inserted) = inserted else {
        return internal_error();
    };
    let deposit_id = inserted.inserted_id.as_object_id();
    let Some(deposit_id) = deposit_id else {
        return internal_error();
    };
    let deposit = db
        .collection::<Document>("deposits")
        .find_one(doc! { "_id": deposit_id })
        .await
        .ok()
        .flatten()
        .unwrap_or_else(Document::new);
    let users = member_deposit_users(&db, std::slice::from_ref(&deposit)).await;
    let payment_methods = HashMap::from([(
        payment_method_id.to_hex(),
        payment_method_from_doc(&payment_method).unwrap_or_default(),
    )]);
    let payment_method_brief = payment_methods
        .get(&payment_method_id.to_hex())
        .cloned()
        .unwrap_or_default();

    (
        axum::http::StatusCode::CREATED,
        Json(DepositRequestResponse {
            message: "Deposit requested",
            deposit: member_deposit_item_from_doc(deposit, &users, &payment_methods),
            payment_info: DepositPaymentInfo {
                bank_name: payment_method_brief.name,
                account_number: payment_method_brief.account_number,
                account_name: payment_method_brief.account_name,
                amount,
                unique_code,
                total_amount,
                admin_fee: total_admin_fee,
                net_amount: amount - total_admin_fee,
                admin_fee_breakdown: DepositFeeBreakdown {
                    payment_method_fee,
                    global_fee,
                },
            },
        }),
    )
        .into_response()
}

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminDepositsQuery>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "viewDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };

    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };

    let actor_id = Some(proxy_user.id);
    let page = parse_positive_i64(query.page.as_deref(), 1, 100_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 20, 100);
    let pipeline = match build_admin_deposits_pipeline(&query, actor_id, page, limit) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };

    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("deposits")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();
    let items = document_array(&result, "items")
        .into_iter()
        .map(admin_deposit_item_from_doc)
        .collect::<Vec<_>>();
    let total = first_array_item(&result, "meta")
        .map(|item| read_i64(&item, "total"))
        .unwrap_or(0);
    let total_pages = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };
    let summary = first_array_item(&result, "summary")
        .map(|item| AdminDepositsSummary {
            total: read_i64(&item, "total"),
            pending: read_i64(&item, "pending"),
            approved: read_i64(&item, "approved"),
            rejected: read_i64(&item, "rejected"),
        })
        .unwrap_or_default();

    Json(AdminDepositsResponse {
        items,
        meta: AdminDepositsMeta {
            page,
            limit,
            total,
            total_pages,
        },
        summary,
    })
    .into_response()
}

pub async fn admin_export(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AdminDepositsQuery>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "viewDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let actor_id = Some(proxy_user.id);
    let pipeline = match build_admin_deposits_pipeline(&query, actor_id, 1, DEPOSIT_EXPORT_LIMIT) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };
    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("deposits")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();
    let items = document_array(&result, "items")
        .into_iter()
        .map(admin_deposit_item_from_doc)
        .collect::<Vec<_>>();
    let csv = build_admin_deposits_csv(&items);
    let filename = format!("admin-deposits-{}.csv", date_key(DateTime::now()));
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

pub async fn claim_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(deposit_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID deposit tidak valid",
        );
    };
    let actor_id = proxy_user.id;

    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let updated = db
        .collection::<Document>("deposits")
        .find_one_and_update(
            doc! {
                "_id": deposit_id,
                "status": "pending",
                "$or": [
                    { "assignedTo": { "$exists": false } },
                    { "assignedTo": Bson::Null },
                    { "assignedTo": actor_id },
                ],
            },
            doc! { "$set": { "assignedTo": actor_id, "assignedAt": now, "updatedAt": now } },
        )
        .return_document(ReturnDocument::After)
        .await;
    let Ok(Some(deposit)) = updated else {
        return deposit_assignment_conflict();
    };
    let Some(deposit_id) = deposit.get_object_id("_id").ok() else {
        return internal_error();
    };
    let Some(deposit) = populated_admin_deposit_by_id(&db, deposit_id).await else {
        return internal_error();
    };

    Json(DepositAssignmentResponse {
        message: "Deposit claimed",
        deposit,
    })
    .into_response()
}

pub async fn release_deposit_claim(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(deposit_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID deposit tidak valid",
        );
    };
    let actor_id = proxy_user.id;

    let db = client.database(&state.mongo_db);
    let updated = db
        .collection::<Document>("deposits")
        .find_one_and_update(
            assignment_access_filter(deposit_id, actor_id, proxy_user.role == "owner"),
            doc! {
                "$set": { "updatedAt": DateTime::now() },
                "$unset": { "assignedTo": "", "assignedAt": "" },
            },
        )
        .return_document(ReturnDocument::After)
        .await;
    let Ok(Some(deposit)) = updated else {
        return deposit_assignment_conflict();
    };
    let Some(deposit_id) = deposit.get_object_id("_id").ok() else {
        return internal_error();
    };
    let Some(deposit) = populated_admin_deposit_by_id(&db, deposit_id).await else {
        return internal_error();
    };

    Json(DepositAssignmentResponse {
        message: "Deposit claim released",
        deposit,
    })
    .into_response()
}

pub async fn reject_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<DepositProcessingPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.deposit_approval") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(deposit_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID deposit tidak valid",
        );
    };
    let actor_id = proxy_user.id;
    let note = match normalize_processing_note(payload.note, true) {
        Ok(note) => note,
        Err(response) => return response,
    };

    let db = client.database(&state.mongo_db);
    let updated = db
        .collection::<Document>("deposits")
        .find_one_and_update(
            assignment_access_filter(deposit_id, actor_id, proxy_user.role == "owner"),
            processing_update("rejected", actor_id, &note),
        )
        .return_document(ReturnDocument::After)
        .await;
    let Ok(Some(deposit)) = updated else {
        return deposit_assignment_conflict();
    };
    let Some(deposit_id) = deposit.get_object_id("_id").ok() else {
        return internal_error();
    };
    let Some(deposit) = populated_admin_deposit_by_id(&db, deposit_id).await else {
        return internal_error();
    };

    Json(DepositAssignmentResponse {
        message: "Deposit rejected",
        deposit,
    })
    .into_response()
}

pub async fn approve_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<DepositProcessingPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "finance.deposit_approval") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(deposit_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID deposit tidak valid",
        );
    };
    let actor_id = proxy_user.id;
    let note = match normalize_processing_note(payload.note, false) {
        Ok(note) => note,
        Err(response) => return response,
    };

    let db = client.database(&state.mongo_db);
    let deposits = db.collection::<Document>("deposits");
    let updated = deposits
        .find_one_and_update(
            assignment_access_filter(deposit_id, actor_id, proxy_user.role == "owner"),
            processing_update("approved", actor_id, &note),
        )
        .return_document(ReturnDocument::After)
        .await;
    let Ok(Some(claimed_deposit)) = updated else {
        return deposit_assignment_conflict();
    };

    let Some(user_id) = claimed_deposit.get_object_id("user").ok() else {
        rollback_deposit_processing(&deposits, deposit_id).await;
        return status_message(axum::http::StatusCode::NOT_FOUND, "User tidak ditemukan");
    };
    let (admin_fee, net_amount) = match net_deposit_value(&claimed_deposit) {
        Ok(value) => value,
        Err(response) => {
            rollback_deposit_processing(&deposits, deposit_id).await;
            return response;
        }
    };

    let users = db.collection::<Document>("users");
    let updated_user = users
        .find_one_and_update(
            doc! { "_id": user_id },
            doc! { "$inc": { "balance": net_amount }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await;
    let Ok(Some(user)) = updated_user else {
        rollback_deposit_processing(&deposits, deposit_id).await;
        return status_message(axum::http::StatusCode::NOT_FOUND, "User tidak ditemukan");
    };

    let Some(deposit) = populated_admin_deposit_by_id(&db, deposit_id).await else {
        let _ = users
            .update_one(
                doc! { "_id": user_id },
                doc! { "$inc": { "balance": -net_amount }, "$set": { "updatedAt": DateTime::now() } },
            )
            .await;
        rollback_deposit_processing(&deposits, deposit_id).await;
        return internal_error();
    };

    Json(DepositApprovalResponse {
        message: "Deposit approved",
        deposit,
        admin_fee_deducted: admin_fee,
        net_amount_added: net_amount,
        new_balance: read_i64(&user, "balance"),
    })
    .into_response()
}
