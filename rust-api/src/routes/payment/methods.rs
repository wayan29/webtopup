use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::oid::ObjectId;
use mongodb::bson::{doc, Document};
use serde_json::Value;

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{load_active_proxy_user, require_permission},
    state::AppState,
    utils::bson::read_string,
};

use super::{
    mappers::{
        payment_method_item_from_doc, public_payment_method_from_doc,
        public_payment_method_raw_from_doc,
    },
    queries::{aggregate_documents, deposit_stats_by_method, guest_stats_by_method},
    responses::{not_found, status_message, string_message, unavailable},
    types::{MessageResponse, PaymentMethodPayload, PaymentMethodResponse},
    utils::is_operational_now,
    validation::{validate_payment_method_create_payload, validate_payment_method_payload},
};

pub async fn methods_admin_all(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewPayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let deposit_stats = deposit_stats_by_method(&db).await;
    let guest_stats = guest_stats_by_method(&db).await;
    let docs = aggregate_documents(&db, "paymentmethods", vec![
        doc! { "$lookup": { "from": "paymentcategories", "localField": "category", "foreignField": "_id", "as": "categoryData" } },
        doc! { "$unwind": { "path": "$categoryData", "preserveNullAndEmptyArrays": true } },
        doc! { "$sort": { "createdAt": -1 } },
    ]).await;
    Json(
        docs.into_iter()
            .map(|document| payment_method_item_from_doc(document, &deposit_stats, &guest_stats))
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub async fn methods_public(State(state): State<Arc<AppState>>) -> Response {
    methods_public_response(&state).await
}

pub async fn methods_active(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = load_active_proxy_user(&headers, &state).await {
        return response;
    }
    methods_public_response(&state).await
}

pub async fn method_create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PaymentMethodPayload>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let payload = match validate_payment_method_create_payload(&db, payload).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") {
        return response;
    }
    let methods = db.collection::<Document>("paymentmethods");
    let now = mongodb::bson::DateTime::now();
    let document = doc! {
        "name": payload.name,
        "category": payload.category,
        "accountNumber": payload.account_number,
        "accountName": payload.account_name,
        "icon": payload.icon,
        "minAmount": payload.min_amount,
        "maxAmount": payload.max_amount,
        "adminFee": payload.admin_fee,
        "adminPercent": payload.admin_percent,
        "operationalStart": payload.operational_start,
        "operationalEnd": payload.operational_end,
        "useUniqueCode": payload.use_unique_code,
        "status": payload.status,
        "createdAt": now,
        "updatedAt": now,
        "__v": 0,
    };
    let insert_result = match methods.insert_one(document).await {
        Ok(result) => result,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        }
    };
    let Some(method_id) = insert_result.inserted_id.as_object_id() else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };
    let method = methods
        .find_one(doc! { "_id": method_id })
        .await
        .ok()
        .flatten();
    let Some(method) = method else {
        return not_found("Payment method not found");
    };
    (
        axum::http::StatusCode::CREATED,
        Json(PaymentMethodResponse {
            message: "Payment method created",
            method: public_payment_method_raw_from_doc(method),
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
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let method_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID metode pembayaran tidak valid",
            )
        }
    };
    let db = client.database(&state.mongo_db);
    let methods = db.collection::<Document>("paymentmethods");
    let current = methods
        .find_one(doc! { "_id": method_id })
        .await
        .ok()
        .flatten();
    let Some(current) = current else {
        return not_found("Payment method not found");
    };
    let payload = match validate_payment_method_payload(&db, payload, &current).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") {
        return response;
    }
    if methods
        .update_one(
            doc! { "_id": method_id },
            doc! {
                "$set": {
                    "name": payload.name,
                    "category": payload.category,
                    "accountNumber": payload.account_number,
                    "accountName": payload.account_name,
                    "icon": payload.icon,
                    "minAmount": payload.min_amount,
                    "maxAmount": payload.max_amount,
                    "adminFee": payload.admin_fee,
                    "adminPercent": payload.admin_percent,
                    "operationalStart": payload.operational_start,
                    "operationalEnd": payload.operational_end,
                    "useUniqueCode": payload.use_unique_code,
                    "status": payload.status,
                    "updatedAt": mongodb::bson::DateTime::now(),
                }
            },
        )
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    let method = methods
        .find_one(doc! { "_id": method_id })
        .await
        .ok()
        .flatten();
    let Some(method) = method else {
        return not_found("Payment method not found");
    };
    Json(PaymentMethodResponse {
        message: "Payment method updated",
        method: public_payment_method_raw_from_doc(method),
    })
    .into_response()
}

pub async fn method_delete(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "managePayment").await {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let method_id = match ObjectId::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID metode pembayaran tidak valid",
            )
        }
    };
    let db = client.database(&state.mongo_db);
    let methods = db.collection::<Document>("paymentmethods");
    let method = methods
        .find_one(doc! { "_id": method_id })
        .await
        .ok()
        .flatten();
    let Some(method) = method else {
        return not_found("Payment method not found");
    };
    let deposit_count = db
        .collection::<Document>("deposits")
        .count_documents(doc! { "paymentMethod": method_id })
        .await
        .unwrap_or(0);
    let guest_transaction_count = db
        .collection::<Document>("guesttransactions")
        .count_documents(doc! { "paymentMethod": method_id })
        .await
        .unwrap_or(0);
    let total_usage_count = deposit_count + guest_transaction_count;
    if total_usage_count > 0 {
        return string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "Metode \"{}\" sudah dipakai {} transaksi/deposit dan tidak bisa dihapus.",
                read_string(&method, "name"),
                total_usage_count
            ),
        );
    }
    if methods.delete_one(doc! { "_id": method_id }).await.is_err() {
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
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = aggregate_documents(&db, "paymentmethods", vec![
        doc! { "$match": { "status": "active" } },
        doc! { "$lookup": { "from": "paymentcategories", "localField": "category", "foreignField": "_id", "as": "categoryData" } },
        doc! { "$unwind": { "path": "$categoryData", "preserveNullAndEmptyArrays": true } },
        doc! { "$match": { "categoryData.status": "active" } },
        doc! { "$sort": { "name": 1 } },
    ]).await;

    Json(
        docs.into_iter()
            .filter_map(public_payment_method_from_doc)
            .filter(|method| {
                let start = method
                    .get("operationalStart")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let end = method
                    .get("operationalEnd")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                is_operational_now(start, end)
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}
