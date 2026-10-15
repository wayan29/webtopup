use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;

use crate::{
    security::{require_sql_permission, require_sql_user},
    state::AppState,
    utils::dates::timestamp_now,
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
    let proxy_user = match require_sql_permission(&headers, &state, "viewDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let summary = build_deposit_queue_summary(&state.pg_pool, Some(proxy_user.id)).await;
    let latest = latest_pending_deposits(&state.pg_pool).await;

    Json(DepositQueueSnapshotResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        user: Some(crate::security::ProxyContextResponse { id: Some(proxy_user.id.to_string()), role: Some(proxy_user.role), email: Some(proxy_user.email) }),
        summary,
        latest,
    })
    .into_response()
}

async fn require_sql_member_user(headers: &HeaderMap, state: &AppState) -> Result<crate::sql_auth::SqlAuthenticatedUser, Response> {
    let user = require_sql_user(headers, state).await?;
    if user.role != "member" {
        return Err(status_message(StatusCode::FORBIDDEN, "Hanya member yang dapat mengakses data ini"));
    }
    Ok(user)
}

pub async fn member_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let user = match require_sql_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let rows = match sqlx::query(
        "SELECT d.id,d.user_id,d.payment_method_id,d.amount,d.unique_code,d.admin_fee,d.total_amount,d.status,d.proof,d.created_at,d.updated_at,\
         u.email AS user_email,u.name AS user_name,pm.name AS payment_method_name,pm.account_number AS payment_method_account_number,pm.account_name AS payment_method_account_name \
         FROM deposits d LEFT JOIN users u ON u.id=d.user_id LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id \
         WHERE d.user_id=$1 ORDER BY d.created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    Json(rows.iter().map(member_deposit_item_from_row).collect::<Vec<_>>()).into_response()
}

pub async fn request_deposit(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RequestDepositPayload>,
) -> Response {
    let proxy_user = match require_sql_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let user_id = proxy_user.id;
    let amount = match normalize_deposit_amount(payload.amount) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let payment_method_id = match payload.payment_method_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => match uuid::Uuid::parse_str(value) {
            Ok(id) => id,
            Err(_) => return status_message(StatusCode::NOT_FOUND, "Payment method not found"),
        },
        None => return status_message(StatusCode::BAD_REQUEST, "Payment method is required"),
    };
    let settings = deposit_settings(&state.pg_pool).await;
    if setting_bool(&settings, "maintenanceMode", false) {
        return status_message_owned(StatusCode::SERVICE_UNAVAILABLE, maintenance_message(&settings));
    }
    let min_deposit = setting_i64(&settings, "minDeposit", 10_000);
    let max_deposit = setting_i64(&settings, "maxDeposit", 10_000_000);
    if amount < min_deposit || amount > max_deposit {
        return status_message_owned(StatusCode::BAD_REQUEST, format!("Nominal deposit global harus di antara Rp {} dan Rp {}", format_idr(min_deposit), format_idr(max_deposit)));
    }
    let payment_method = match sqlx::query("SELECT m.*,c.status AS category_status FROM payment_methods m LEFT JOIN payment_categories c ON c.id=m.category_id WHERE m.id=$1")
        .bind(payment_method_id).fetch_optional(&state.pg_pool).await {
        Ok(Some(row)) => row,
        Ok(None) => return status_message(StatusCode::NOT_FOUND, "Payment method not found"),
        Err(_) => return internal_error(),
    };
    let method_status: String = payment_method.try_get("status").unwrap_or_default();
    if method_status != "active" { return status_message(StatusCode::BAD_REQUEST, "Payment method is not active"); }
    if payment_method.try_get::<Option<String>, _>("category_status").ok().flatten().as_deref() != Some("active") {
        return status_message(StatusCode::BAD_REQUEST, "Payment category is not available");
    }
    let operational_start: String = payment_method.try_get("operational_start").unwrap_or_default();
    let operational_end: String = payment_method.try_get("operational_end").unwrap_or_default();
    if !is_operational_now(&operational_start, &operational_end) {
        return status_message_owned(StatusCode::BAD_REQUEST, format!("Payment method is available only between {} and {}", operational_start, operational_end));
    }
    let min_amount = payment_method.try_get::<f64, _>("min_amount").unwrap_or(10_000.0) as i64;
    let max_amount = payment_method.try_get::<f64, _>("max_amount").unwrap_or(5_000_000.0) as i64;
    if amount < min_amount || amount > max_amount {
        return status_message_owned(StatusCode::BAD_REQUEST, format!("Amount must be between Rp {} and Rp {}", format_idr(min_amount), format_idr(max_amount)));
    }
    let admin_fee_fixed = payment_method.try_get::<f64, _>("admin_fee").unwrap_or_default().round() as i64;
    let admin_fee_percent = round_percent(amount, payment_method.try_get::<f64, _>("admin_percent").unwrap_or_default());
    let payment_method_fee = admin_fee_fixed + admin_fee_percent;
    let global_fee_value = setting_i64(&settings, "depositFee", 0);
    let global_fee = if setting_string(&settings, "depositFeeType", "fixed") == "percent" { round_percent(amount, global_fee_value as f64) } else { global_fee_value };
    let total_admin_fee = payment_method_fee + global_fee;
    if amount - total_admin_fee <= 0 { return status_message(StatusCode::BAD_REQUEST, "Biaya admin metode pembayaran ini melebihi nominal deposit. Hubungi admin."); }
    let unique_code = if payment_method.try_get::<bool, _>("use_unique_code").unwrap_or(true) { generate_unique_code() } else { 0 };
    let total_amount = amount + unique_code;
    let invoice_code = format!("INV{}", &uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase());
    let inserted = match sqlx::query("INSERT INTO deposits(user_id,payment_method_id,amount,unique_code,total_amount,admin_fee,status,reference,invoice_code) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$7) RETURNING id")
        .bind(user_id).bind(payment_method_id).bind(amount).bind(unique_code).bind(total_amount).bind(total_admin_fee).bind(&invoice_code).fetch_one(&state.pg_pool).await {
        Ok(row) => row,
        Err(_) => return internal_error(),
    };
    let deposit_id: uuid::Uuid = inserted.get("id");
    let row = match sqlx::query("SELECT d.id,d.user_id,d.payment_method_id,d.amount,d.unique_code,d.admin_fee,d.total_amount,d.status,d.proof,d.created_at,d.updated_at,u.email AS user_email,u.name AS user_name,pm.name AS payment_method_name,pm.account_number AS payment_method_account_number,pm.account_name AS payment_method_account_name FROM deposits d LEFT JOIN users u ON u.id=d.user_id LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id WHERE d.id=$1")
        .bind(deposit_id).fetch_one(&state.pg_pool).await { Ok(row) => row, Err(_) => return internal_error() };
    let bank_name = payment_method.try_get::<String, _>("name").unwrap_or_default();
    let account_number = payment_method.try_get::<String, _>("account_number").unwrap_or_default();
    let account_name = payment_method.try_get::<String, _>("account_name").unwrap_or_default();
    (
        StatusCode::CREATED,
        Json(DepositRequestResponse {
            message: "Deposit requested",
            deposit: member_deposit_item_from_row(&row),
            payment_info: DepositPaymentInfo { bank_name, account_number, account_name, amount, unique_code, total_amount, admin_fee: total_admin_fee, net_amount: amount-total_admin_fee, admin_fee_breakdown: DepositFeeBreakdown { payment_method_fee, global_fee } },
        }),
    ).into_response()
}

pub async fn admin_list(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<AdminDepositsQuery>) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "viewDeposits").await { Ok(user) => user, Err(response) => return response };
    let page = parse_positive_i64(query.page.as_deref(), 1, 100_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 20, 100);
    let (items, total, summary) = match sql_admin_deposits(&state, &query, proxy_user.id, page, limit).await { Ok(value) => value, Err(response) => return response };
    Json(AdminDepositsResponse { items, meta: AdminDepositsMeta { page, limit, total, total_pages: if total > 0 { (total + limit - 1) / limit } else { 1 } }, summary }).into_response()
}

pub async fn admin_export(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<AdminDepositsQuery>) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "viewDeposits").await { Ok(user) => user, Err(response) => return response };
    let actor = match require_sql_user(&headers, &state).await { Ok(user) => user, Err(response) => return response };
    if let Err(error) = crate::sql_auth::verify_step_up(&headers, &state, &actor, "exports.sensitive", chrono::Utc::now()) { return error.into_response(); }
    let (items, _, _) = match sql_admin_deposits(&state, &query, proxy_user.id, 1, DEPOSIT_EXPORT_LIMIT).await { Ok(value) => value, Err(response) => return response };
    let csv = build_admin_deposits_csv(&items);
    let filename = format!("admin-deposits-{}.csv", date_key(chrono::Utc::now()));
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/csv; charset=utf-8"));
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) { response_headers.insert(header::CONTENT_DISPOSITION, value); }
    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

async fn sql_admin_deposits(state: &AppState, query: &AdminDepositsQuery, actor: uuid::Uuid, page: i64, limit: i64) -> Result<(Vec<AdminDepositItem>, i64, AdminDepositsSummary), Response> {
    let status = query.status.as_deref().map(str::trim).unwrap_or("");
    let assignment = query.assignment.as_deref().map(str::trim).unwrap_or("");
    if !status.is_empty() && !matches!(status, "pending" | "approved" | "rejected" | "refunded") { return Err(status_message(StatusCode::BAD_REQUEST, "Status deposit tidak valid")); }
    if !assignment.is_empty() && !matches!(assignment, "unassigned" | "mine" | "locked") { return Err(status_message(StatusCode::BAD_REQUEST, "Filter claim deposit tidak valid")); }
    let invoice = query.invoice_id.as_deref().unwrap_or("").trim();
    let user_query = query.user_query.as_deref().unwrap_or("").trim();
    let transfer = query.total_transfer.as_deref().unwrap_or("").trim();
    let filters = "($1='' OR d.status=$1) AND ($2='' OR (d.status='pending' AND (($2='unassigned' AND d.assigned_to IS NULL) OR ($2='mine' AND d.assigned_to=$3) OR ($2='locked' AND d.assigned_to IS NOT NULL AND d.assigned_to<>$3)))) AND ($4='' OR position(lower($4) in lower(d.id::text))>0 OR position(lower($4) in lower(d.invoice_code))>0) AND ($5='' OR position(lower($5) in lower(u.name))>0 OR position(lower($5) in lower(u.email))>0) AND ($6='' OR position($6 in COALESCE(d.total_amount,d.amount)::text)>0)";
    let total_sql = format!("SELECT count(*)::bigint FROM deposits d LEFT JOIN users u ON u.id=d.user_id WHERE {filters}");
    let total: i64 = sqlx::query_scalar(&total_sql).bind(status).bind(assignment).bind(actor).bind(invoice).bind(user_query).bind(transfer).fetch_one(&state.pg_pool).await.map_err(|_| internal_error())?;
    let summary_row = sqlx::query(&format!("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE d.status='pending')::bigint AS pending,count(*) FILTER(WHERE d.status='approved')::bigint AS approved,count(*) FILTER(WHERE d.status='rejected')::bigint AS rejected FROM deposits d LEFT JOIN users u ON u.id=d.user_id WHERE {filters}"))
        .bind(status).bind(assignment).bind(actor).bind(invoice).bind(user_query).bind(transfer).fetch_one(&state.pg_pool).await.map_err(|_| internal_error())?;
    let summary = AdminDepositsSummary { total: summary_row.get("total"), pending: summary_row.get("pending"), approved: summary_row.get("approved"), rejected: summary_row.get("rejected") };
    let rows = sqlx::query(&format!("SELECT d.id,d.amount,d.unique_code,d.admin_fee,d.total_amount,(d.amount-d.admin_fee) AS net_amount,d.status,d.created_at,d.updated_at,d.assigned_at,d.processed_at,d.processing_note,d.invoice_code,u.id AS user_id,u.name AS user_name,u.email AS user_email,u.role AS user_role,pm.id AS payment_method_id,pm.name AS payment_method_name,pm.account_number AS payment_method_account_number,pm.account_name AS payment_method_account_name,a.id AS assigned_to_id,a.name AS assigned_to_name,a.email AS assigned_to_email,a.role AS assigned_to_role,p.id AS processed_by_id,p.name AS processed_by_name,p.email AS processed_by_email,p.role AS processed_by_role FROM deposits d LEFT JOIN users u ON u.id=d.user_id LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id LEFT JOIN users a ON a.id=d.assigned_to LEFT JOIN users p ON p.id=d.processed_by WHERE {filters} ORDER BY d.created_at DESC LIMIT $7 OFFSET $8"))
        .bind(status).bind(assignment).bind(actor).bind(invoice).bind(user_query).bind(transfer).bind(limit).bind((page-1)*limit).fetch_all(&state.pg_pool).await.map_err(|_| internal_error())?;
    Ok((rows.iter().map(admin_deposit_item_from_row).collect(), total, summary))
}

pub async fn claim_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Ok(deposit_id) = uuid::Uuid::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID deposit tidak valid");
    };
    let updated = sqlx::query("UPDATE deposits SET assigned_to=$2, assigned_at=now(), updated_at=now() WHERE id=$1 AND status='pending' AND (assigned_to IS NULL OR assigned_to=$2) RETURNING id")
        .bind(deposit_id).bind(proxy_user.id).fetch_optional(&state.pg_pool).await;
    match updated {
        Ok(Some(_)) => {},
        Ok(None) => return deposit_assignment_conflict(),
        Err(_) => return internal_error(),
    }
    match sql_admin_deposit(&state, deposit_id).await {
        Some(deposit) => Json(DepositAssignmentResponse { message: "Deposit claimed", deposit }).into_response(),
        None => internal_error(),
    }
}

pub async fn release_deposit_claim(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Ok(deposit_id) = uuid::Uuid::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID deposit tidak valid");
    };
    let owner = proxy_user.role == "owner";
    let updated = sqlx::query("UPDATE deposits SET assigned_to=NULL, assigned_at=NULL, updated_at=now() WHERE id=$1 AND status='pending' AND ($3 OR assigned_to=$2) RETURNING id")
        .bind(deposit_id).bind(proxy_user.id).bind(owner).fetch_optional(&state.pg_pool).await;
    match updated {
        Ok(Some(_)) => {},
        Ok(None) => return deposit_assignment_conflict(),
        Err(_) => return internal_error(),
    }
    match sql_admin_deposit(&state, deposit_id).await {
        Some(deposit) => Json(DepositAssignmentResponse { message: "Deposit claim released", deposit }).into_response(),
        None => internal_error(),
    }
}

pub async fn reject_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<DepositProcessingPayload>,
) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let actor = match require_sql_user(&headers, &state).await { Ok(user) => user, Err(response) => return response };
    if let Err(error) = crate::sql_auth::verify_step_up(&headers, &state, &actor, "finance.deposit_approval", chrono::Utc::now()) { return error.into_response(); }
    let Ok(deposit_id) = uuid::Uuid::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID deposit tidak valid");
    };
    let note = match normalize_processing_note(payload.note, true) { Ok(note) => note, Err(response) => return response };
    let updated = sqlx::query("UPDATE deposits SET status='rejected', processed_by=$2, processed_at=now(), processing_note=$3, updated_at=now() WHERE id=$1 AND status='pending' AND ($4 OR assigned_to IS NULL OR assigned_to=$2) RETURNING id")
        .bind(deposit_id).bind(proxy_user.id).bind(note).bind(proxy_user.role == "owner").fetch_optional(&state.pg_pool).await;
    match updated {
        Ok(Some(_)) => {},
        Ok(None) => return deposit_assignment_conflict(),
        Err(_) => return internal_error(),
    }
    match sql_admin_deposit(&state, deposit_id).await {
        Some(deposit) => Json(DepositAssignmentResponse { message: "Deposit rejected", deposit }).into_response(),
        None => internal_error(),
    }
}

pub async fn approve_deposit(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<DepositProcessingPayload>,
) -> Response {
    let proxy_user = match require_sql_permission(&headers, &state, "approveDeposits").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let actor = match require_sql_user(&headers, &state).await { Ok(user) => user, Err(response) => return response };
    if let Err(error) = crate::sql_auth::verify_step_up(&headers, &state, &actor, "finance.deposit_approval", chrono::Utc::now()) { return error.into_response(); }
    let Ok(deposit_id) = uuid::Uuid::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID deposit tidak valid");
    };
    let note = match normalize_processing_note(payload.note, false) { Ok(note) => note, Err(response) => return response };
    let mut tx = match state.pg_pool.begin().await { Ok(tx) => tx, Err(_) => return unavailable() };
    let row = match sqlx::query("SELECT user_id, amount, admin_fee FROM deposits WHERE id=$1 AND status='pending' AND ($3 OR assigned_to IS NULL OR assigned_to=$2) FOR UPDATE")
        .bind(deposit_id).bind(proxy_user.id).bind(proxy_user.role == "owner").fetch_optional(&mut *tx).await {
            Ok(Some(row)) => row,
            Ok(None) => return deposit_assignment_conflict(),
            Err(_) => return internal_error(),
        };
    let Some(user_id) = row.try_get::<Option<uuid::Uuid>, _>("user_id").ok().flatten() else { return status_message(StatusCode::NOT_FOUND, "User tidak ditemukan"); };
    let amount: Option<i64> = row.try_get("amount").ok();
    let admin_fee: i64 = row.try_get("admin_fee").unwrap_or(0).max(0);
    let Some(net_amount) = amount.and_then(|amount| amount.checked_sub(admin_fee)).filter(|amount| *amount > 0) else {
        return status_message(StatusCode::BAD_REQUEST, "Nilai deposit tidak valid");
    };
    let user = match sqlx::query("UPDATE users SET balance=balance+$2, updated_at=now() WHERE id=$1 RETURNING balance")
        .bind(user_id).bind(net_amount).fetch_optional(&mut *tx).await {
            Ok(Some(user)) => user,
            Ok(None) => return status_message(StatusCode::NOT_FOUND, "User tidak ditemukan"),
            Err(_) => return internal_error(),
        };
    let new_balance: i64 = user.try_get("balance").unwrap_or(0);
    let source = format!("deposit-approve:{deposit_id}");
    if sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'credit',1,$3,$4)")
        .bind(user_id).bind(&source).bind(net_amount).bind(new_balance).execute(&mut *tx).await.is_err() {
        return internal_error();
    }
    if sqlx::query("UPDATE deposits SET status='approved', action_key=$2, processed_by=$3, processed_at=now(), processing_note=$4, updated_at=now() WHERE id=$1")
        .bind(deposit_id).bind(&source).bind(proxy_user.id).bind(note).execute(&mut *tx).await.is_err() {
        return internal_error();
    }
    if sqlx::query("INSERT INTO financial_audits(actor_id,action,subject_id,amount,operation_key) VALUES($1,'deposit-approve',$2,$3,$4)")
        .bind(proxy_user.id).bind(deposit_id).bind(net_amount).bind(&source).execute(&mut *tx).await.is_err() {
        return internal_error();
    }
    if tx.commit().await.is_err() { return internal_error(); }
    match sql_admin_deposit(&state, deposit_id).await {
        Some(deposit) => Json(DepositApprovalResponse { message: "Deposit approved", deposit, admin_fee_deducted: admin_fee, net_amount_added: net_amount, new_balance }).into_response(),
        None => internal_error(),
    }
}

async fn sql_admin_deposit(state: &AppState, id: uuid::Uuid) -> Option<AdminDepositItem> {
    let row = sqlx::query("SELECT d.id,d.amount,d.unique_code,d.admin_fee,d.total_amount,(d.amount-d.admin_fee) AS net_amount,d.status,d.created_at,d.updated_at,d.assigned_at,d.processed_at,d.processing_note,d.invoice_code,u.id AS user_id,u.name AS user_name,u.email AS user_email,u.role AS user_role,pm.id AS payment_method_id,pm.name AS payment_method_name,pm.account_number AS payment_method_account_number,pm.account_name AS payment_method_account_name,a.id AS assigned_to_id,a.name AS assigned_to_name,a.email AS assigned_to_email,a.role AS assigned_to_role,p.id AS processed_by_id,p.name AS processed_by_name,p.email AS processed_by_email,p.role AS processed_by_role FROM deposits d LEFT JOIN users u ON u.id=d.user_id LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id LEFT JOIN users a ON a.id=d.assigned_to LEFT JOIN users p ON p.id=d.processed_by WHERE d.id=$1")
        .bind(id).fetch_optional(&state.pg_pool).await.ok()??;
    Some(admin_deposit_item_from_row(&row))
}
