use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, PgPool, Row};
use uuid::Uuid;

use crate::{
    security::{require_sql_permission, require_sql_user},
    sql_auth::verify_step_up,
    state::AppState,
};

use super::{
    responses::{not_found, status_message, string_message},
    types::{MessageResponse, PaymentMethodPayload, PaymentMethodResponse},
    utils::{is_operational_now, visibility_issues},
    validation::{validate_payment_method_create_payload, validate_payment_method_payload},
};

fn unavailable() -> Response {
    status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Database unavailable")
}
fn method_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value).ok()
}

fn row_method(row: &PgRow) -> Value {
    json!({"_id": row.get::<Uuid,_>("id").to_string(), "name": row.get::<String,_>("name"), "category": row.get::<Option<Uuid>,_>("category_id").map(|v|v.to_string()),
        "accountNumber": row.get::<String,_>("account_number"), "accountName": row.get::<String,_>("account_name"), "icon": row.get::<String,_>("icon"),
        "minAmount": row.get::<f64,_>("min_amount"), "maxAmount": row.get::<f64,_>("max_amount"), "adminFee": row.get::<f64,_>("admin_fee"), "adminPercent": row.get::<f64,_>("admin_percent"),
        "operationalStart": row.get::<String,_>("operational_start"), "operationalEnd": row.get::<String,_>("operational_end"), "useUniqueCode": row.get::<bool,_>("use_unique_code"), "status": row.get::<String,_>("status"),
        "createdAt": row.get::<DateTime<Utc>,_>("created_at").to_rfc3339(), "updatedAt": row.get::<DateTime<Utc>,_>("updated_at").to_rfc3339(), "__v": 0})
}

fn public_method(row: &PgRow) -> Value {
    json!({"_id":row.get::<Uuid,_>("id").to_string(),"name":row.get::<String,_>("name"),"category":{"_id":row.get::<Uuid,_>("category_id").to_string(),"name":row.get::<String,_>("category_name"),"slug":row.get::<String,_>("category_slug"),"icon":row.get::<String,_>("category_icon"),"status":row.get::<String,_>("category_status")},"accountNumber":row.get::<String,_>("account_number"),"accountName":row.get::<String,_>("account_name"),"minAmount":row.get::<f64,_>("min_amount"),"maxAmount":row.get::<f64,_>("max_amount"),"adminFee":row.get::<f64,_>("admin_fee"),"adminPercent":row.get::<f64,_>("admin_percent"),"operationalStart":row.get::<String,_>("operational_start"),"operationalEnd":row.get::<String,_>("operational_end"),"status":row.get::<String,_>("status"),"createdAt":row.get::<DateTime<Utc>,_>("created_at").to_rfc3339(),"updatedAt":row.get::<DateTime<Utc>,_>("updated_at").to_rfc3339(),"__v":0,"icon":row.get::<String,_>("icon"),"useUniqueCode":row.get::<bool,_>("use_unique_code")})
}
async fn fetch_method(pool: &PgPool, id: Uuid) -> Result<Option<PgRow>, sqlx::Error> {
    sqlx::query("SELECT m.*, c.name category_name,c.slug category_slug,c.icon category_icon,c.status category_status FROM payment_methods m LEFT JOIN payment_categories c ON c.id=m.category_id WHERE m.id=$1")
        .bind(id).fetch_optional(pool).await
}

pub async fn methods_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "viewPayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let rows = match sqlx::query("SELECT m.*, c.name category_name,c.slug category_slug,c.icon category_icon,c.status category_status, (SELECT count(*) FROM deposits d WHERE d.payment_method_id=m.id) deposit_count, (SELECT count(*) FROM guest_orders g WHERE g.payment_method_id=m.id) guest_count, (SELECT count(*) FROM payment_reference_allocations r WHERE r.payment_method_id=m.id) reference_count, (SELECT count(*) FROM deposits d WHERE d.payment_method_id=m.id AND d.status='pending') pending_deposit_count, (SELECT count(*) FROM guest_orders g WHERE g.payment_method_id=m.id AND g.payment_status='unpaid') waiting_payment_count FROM payment_methods m LEFT JOIN payment_categories c ON c.id=m.category_id ORDER BY m.created_at DESC").fetch_all(pool).await { Ok(rows) => rows, Err(_) => return status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR,"Internal Server Error") };
    Json(rows.iter().map(|r| {
        let start: String=r.get("operational_start"); let end: String=r.get("operational_end"); let operational=is_operational_now(&start,&end);
        let category = r.get::<Option<Uuid>,_>("category_id").map(|id| json!({"_id":id.to_string(),"name":r.get::<Option<String>,_>("category_name").unwrap_or_default(),"slug":r.get::<Option<String>,_>("category_slug").unwrap_or_default(),"icon":r.get::<Option<String>,_>("category_icon").unwrap_or_default(),"status":r.get::<Option<String>,_>("category_status").unwrap_or_default()}));
        let status: String=r.get("status"); let category_status:Option<String>=r.get("category_status"); let issues=visibility_issues(&status, category_status.as_deref(), operational,&start,&end);
        let deposits:i64=r.get("deposit_count"); let guests:i64=r.get("guest_count"); let refs:i64=r.get("reference_count"); let pending:i64=r.get("pending_deposit_count"); let waiting:i64=r.get("waiting_payment_count"); let total=deposits+guests+refs;
        json!({"_id":r.get::<Uuid,_>("id").to_string(),"name":r.get::<String,_>("name"),"category":category,"accountNumber":r.get::<String,_>("account_number"),"accountName":r.get::<String,_>("account_name"),"icon":r.get::<String,_>("icon"),"minAmount":r.get::<f64,_>("min_amount"),"maxAmount":r.get::<f64,_>("max_amount"),"adminFee":r.get::<f64,_>("admin_fee"),"adminPercent":r.get::<f64,_>("admin_percent"),"operationalStart":start,"operationalEnd":end,"useUniqueCode":r.get::<bool,_>("use_unique_code"),"status":status,"createdAt":r.get::<DateTime<Utc>,_>("created_at").to_rfc3339(),"updatedAt":r.get::<DateTime<Utc>,_>("updated_at").to_rfc3339(),"dependency":{"depositCount":deposits,"pendingDepositCount":pending,"guestTransactionCount":guests,"waitingPaymentCount":waiting,"totalUsageCount":total},"canDelete":total==0,"deleteBlockedReason":if total>0{format!("Metode ini sudah dipakai {total} transaksi/deposit historis.")}else{String::new()},"isOperationalNow":operational,"isVisibleToUsers":issues.is_empty(),"visibilityIssues":issues})
    }).collect::<Vec<_>>()).into_response()
}

pub async fn methods_public(State(state): State<Arc<AppState>>) -> Response {
    methods_public_response(&state).await
}
pub async fn methods_active(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_sql_user(&headers, &state).await {
        return response;
    }
    methods_public_response(&state).await
}

pub async fn method_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PaymentMethodPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let payload = match validate_payment_method_create_payload(pool, payload).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let actor = match require_sql_user(&headers, &state).await { Ok(actor) => actor, Err(response) => return response };
    if let Err(error) = verify_step_up(&headers, &state, &actor, "integrations.credentials", Utc::now()) { return error.into_response(); }
    let row=match sqlx::query("INSERT INTO payment_methods(name,category_id,account_number,account_name,icon,min_amount,max_amount,admin_fee,admin_percent,operational_start,operational_end,use_unique_code,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id")
        .bind(&payload.name).bind(payload.category).bind(&payload.account_number).bind(&payload.account_name).bind(&payload.icon).bind(payload.min_amount).bind(payload.max_amount).bind(payload.admin_fee).bind(payload.admin_percent).bind(&payload.operational_start).bind(&payload.operational_end).bind(payload.use_unique_code).bind(&payload.status).fetch_one(pool).await{Ok(r)=>r,Err(_)=>return status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR,"Internal Server Error")};
    let id: Uuid = row.get("id");
    let method = match fetch_method(pool, id).await {
        Ok(Some(r)) => row_method(&r),
        _ => return not_found("Payment method not found"),
    };
    (
        axum::http::StatusCode::CREATED,
        Json(PaymentMethodResponse {
            message: "Payment method created",
            method,
        }),
    )
        .into_response()
}

pub async fn method_update(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<PaymentMethodPayload>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let pool = &state.pg_pool;
    let Some(id) = method_uuid(&id) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID metode pembayaran tidak valid",
        );
    };
    let current = match fetch_method(pool, id).await {
        Ok(Some(r)) => r,
        Ok(None) => return not_found("Payment method not found"),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let payload = match validate_payment_method_payload(pool, payload, &current).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let actor = match require_sql_user(&headers, &state).await { Ok(actor) => actor, Err(response) => return response };
    if let Err(error) = verify_step_up(&headers, &state, &actor, "integrations.credentials", Utc::now()) { return error.into_response(); }
    if sqlx::query("UPDATE payment_methods SET name=$2,category_id=$3,account_number=$4,account_name=$5,icon=$6,min_amount=$7,max_amount=$8,admin_fee=$9,admin_percent=$10,operational_start=$11,operational_end=$12,use_unique_code=$13,status=$14,updated_at=now() WHERE id=$1").bind(id).bind(payload.name).bind(payload.category).bind(payload.account_number).bind(payload.account_name).bind(payload.icon).bind(payload.min_amount).bind(payload.max_amount).bind(payload.admin_fee).bind(payload.admin_percent).bind(payload.operational_start).bind(payload.operational_end).bind(payload.use_unique_code).bind(payload.status).execute(pool).await.is_err(){return status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR,"Internal Server Error");}
    let method = match fetch_method(pool, id).await {
        Ok(Some(r)) => row_method(&r),
        _ => return not_found("Payment method not found"),
    };
    Json(PaymentMethodResponse {
        message: "Payment method updated",
        method,
    })
    .into_response()
}

pub async fn method_delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_sql_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let actor = match require_sql_user(&headers, &state).await { Ok(actor) => actor, Err(response) => return response };
    if let Err(error) = verify_step_up(&headers, &state, &actor, "integrations.credentials", Utc::now()) { return error.into_response(); }
    let pool = &state.pg_pool;
    let Some(id) = method_uuid(&id) else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "ID metode pembayaran tidak valid",
        );
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let name = match sqlx::query_scalar::<_, String>(
        "SELECT name FROM payment_methods WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(v)) => v,
        Ok(None) => return not_found("Payment method not found"),
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let count=match sqlx::query_scalar::<_,i64>("SELECT (SELECT count(*) FROM deposits WHERE payment_method_id=$1)+(SELECT count(*) FROM guest_orders WHERE payment_method_id=$1)+(SELECT count(*) FROM payment_reference_allocations WHERE payment_method_id=$1)").bind(id).fetch_one(&mut *tx).await{Ok(v)=>v,Err(_)=>return status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR,"Internal Server Error")};
    if count > 0 {
        return string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Metode \"{name}\" sudah dipakai {count} transaksi/deposit dan tidak bisa dihapus."
            ),
        );
    }
    if sqlx::query("DELETE FROM payment_methods WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    Json(MessageResponse {
        message: "Payment method deleted",
    })
    .into_response()
}

async fn methods_public_response(state: &AppState) -> Response {
    let pool = &state.pg_pool;
    let rows=match sqlx::query("SELECT m.*,c.name category_name,c.slug category_slug,c.icon category_icon,c.status category_status FROM payment_methods m INNER JOIN payment_categories c ON c.id=m.category_id WHERE m.status='active' AND c.status='active' ORDER BY m.name").fetch_all(pool).await{Ok(v)=>v,Err(_)=>return Json(Vec::<Value>::new()).into_response()};
    Json(
        rows.iter()
            .filter_map(|r| {
                let start: String = r.get("operational_start");
                let end: String = r.get("operational_end");
                if !is_operational_now(&start, &end) {
                    return None;
                }
                Some(public_method(r))
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}
