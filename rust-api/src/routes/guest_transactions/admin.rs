use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    options::ReturnDocument,
};

use crate::{
    routes::validation_engine::{
        product_validation_config, run_paid_validation, PaidValidationStatus,
    },
    security::{require_permission, ErrorResponse},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::*;

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<GuestTransactionsQuery>,
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
    let limit = parse_positive_i64(query.limit.as_deref(), 20, MAX_LIMIT);
    let pipeline = match build_pipeline(&query, page, limit) {
        Ok(pipeline) => pipeline,
        Err(response) => return response,
    };
    let result = first_document(
        client
            .database(&state.mongo_db)
            .collection::<Document>("guesttransactions")
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
        .map(|item| GuestTransactionsSummary {
            total: read_i64(&item, "total"),
            amount_total: read_i64(&item, "amountTotal"),
            waiting_payment: read_i64(&item, "waitingPayment"),
            paid: read_i64(&item, "paid"),
            expired: read_i64(&item, "expired"),
            cancelled: read_i64(&item, "cancelled"),
            processing: read_i64(&item, "processing"),
            success: read_i64(&item, "success"),
            failed: read_i64(&item, "failed"),
        })
        .unwrap_or_default();

    Json(GuestTransactionsResponse {
        items: document_array(&result, "items")
            .into_iter()
            .map(guest_transaction_item_from_doc)
            .collect(),
        meta: GuestTransactionsMeta {
            page,
            limit,
            total,
            total_pages,
        },
        summary,
    })
    .into_response()
}

pub async fn cancel_admin(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<GuestCancelPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi guest tidak valid");
    };
    let note = match normalize_optional_text(payload.note.as_deref(), 500, "Catatan tindakan") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("guesttransactions");
    let now = DateTime::now();
    let updated = match collection
        .find_one_and_update(
            doc! {
                "_id": transaction_id,
                "$or": [
                    { "paymentStatus": "waiting_payment" },
                    { "paymentStatus": "paid", "transactionStatus": "failed" }
                ]
            },
            doc! { "$set": {
                "paymentStatus": "cancelled",
                "transactionStatus": "failed",
                "statusUpdatedBy": processor_id,
                "statusUpdatedAt": now,
                "statusUpdateNote": build_action_note(
                    "Transaksi guest dibatalkan manual oleh admin",
                    note.as_deref(),
                ),
                "updatedAt": now,
            } },
        )
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };

    if updated.is_none() {
        return guest_cancel_rejection(&collection, transaction_id).await;
    }

    let transaction = populated_guest_transaction_item(&db, transaction_id)
        .await
        .or_else(|| updated.map(guest_transaction_item_from_doc));
    let Some(transaction) = transaction else {
        return internal_error();
    };

    Json(GuestMutationResponse {
        message: "Transaksi guest dibatalkan",
        transaction,
    })
    .into_response()
}

pub async fn confirm_admin(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<GuestConfirmPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi guest tidak valid");
    };
    let note = match normalize_optional_text(payload.note.as_deref(), 500, "Catatan tindakan") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("guesttransactions");
    let now = DateTime::now();
    let ref_id = generate_guest_ref_id();
    let claimed = match collection
        .find_one_and_update(
            doc! {
                "_id": transaction_id,
                "paymentStatus": "waiting_payment",
                "transactionStatus": "pending",
            },
            doc! { "$set": {
                "paymentStatus": "paid",
                "paidAt": now,
                "transactionStatus": "processing",
                "vendorTrxId": &ref_id,
                "statusUpdatedBy": processor_id,
                "statusUpdatedAt": now,
                "statusUpdateNote": build_action_note(
                    "Pembayaran guest dikonfirmasi manual dan dikirim ke vendor",
                    note.as_deref(),
                ),
                "updatedAt": now,
            } },
        )
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };

    let Some(claimed) = claimed else {
        return guest_confirm_rejection(&collection, transaction_id).await;
    };

    // Validation products: run validation engine instead of vendor top-up
    if let Ok(product_id) = claimed.get_object_id("product") {
        if let Some(product_doc) = load_guest_product_document(&db, product_id).await {
            if let Some(validation_config) = product_validation_config(&product_doc) {
                let target = read_string(&claimed, "target");
                let server_id = read_string(&claimed, "serverId");
                let validation_result =
                    run_paid_validation(&validation_config, &target, &server_id).await;

                let mut set_fields = doc! {
                    "statusUpdatedBy": processor_id,
                    "statusUpdatedAt": DateTime::now(),
                    "updatedAt": DateTime::now(),
                };
                match validation_result.status {
                    PaidValidationStatus::Success => {
                        set_fields.insert("transactionStatus", "success");
                        set_fields.insert(
                            "statusUpdateNote",
                            build_action_note(
                                &format!("Validasi berhasil: {}", validation_result.message),
                                note.as_deref(),
                            ),
                        );
                        if let Some(sn) = validation_result.sn {
                            set_fields.insert("sn", sn);
                        }
                        set_fields.insert("message", validation_result.message);
                    }
                    PaidValidationStatus::Failed => {
                        set_fields.insert("transactionStatus", "failed");
                        set_fields.insert(
                            "statusUpdateNote",
                            build_action_note(
                                &format!("Validasi otomatis gagal: {}", validation_result.message),
                                note.as_deref(),
                            ),
                        );
                        set_fields.insert("message", validation_result.message);
                    }
                    PaidValidationStatus::ProviderError => {
                        set_fields.insert("transactionStatus", "pending");
                        set_fields.insert(
                            "statusUpdateNote",
                            build_action_note(
                                &format!(
                                    "Validasi otomatis tertunda: {}",
                                    validation_result.message
                                ),
                                note.as_deref(),
                            ),
                        );
                        set_fields.insert("message", validation_result.message);
                    }
                }
                let _ = collection
                    .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_fields })
                    .await;
                let transaction = populated_guest_transaction_item(&db, transaction_id)
                    .await
                    .unwrap_or_else(|| guest_transaction_item_from_doc(claimed));
                return Json(GuestMutationResponse {
                    message: "Pembayaran guest berhasil dikonfirmasi",
                    transaction,
                })
                .into_response();
            }
        }
    }

    // Normal products: vendor top-up flow
    let product = if let Ok(product_id) = claimed.get_object_id("product") {
        load_guest_provider_product(&db, product_id).await
    } else {
        None
    };
    let Some(product) = product else {
        let _ = collection
                .update_one(
                    doc! { "_id": transaction_id },
                    doc! { "$set": {
                        "statusUpdatedBy": processor_id,
                        "statusUpdatedAt": DateTime::now(),
                        "statusUpdateNote": build_action_note(
                            "Pembayaran guest dikonfirmasi manual, tetapi pengiriman ke vendor gagal dan perlu dicek ulang.",
                            note.as_deref(),
                        ),
                        "updatedAt": DateTime::now(),
                    } },
                )
                .await;
        let transaction = populated_guest_transaction_item(&db, transaction_id)
            .await
            .unwrap_or_else(|| guest_transaction_item_from_doc(claimed));
        return Json(GuestMutationResponse {
            message: "Pembayaran guest berhasil dikonfirmasi",
            transaction,
        })
        .into_response();
    };

    match top_up_guest_vendor(
        &state,
        &ref_id,
        &read_string(&claimed, "target"),
        &read_string(&claimed, "serverId"),
        &product,
    )
    .await
    {
        Ok(vendor_result) => {
            let mut set_fields = doc! {
                "transactionStatus": &vendor_result.status,
                "statusUpdatedBy": processor_id,
                "statusUpdatedAt": DateTime::now(),
                "statusUpdateNote": build_action_note(
                    &format!(
                        "Pembayaran guest dikonfirmasi manual. Respons vendor: {}",
                        vendor_result.status.to_uppercase(),
                    ),
                    note.as_deref(),
                ),
                "updatedAt": DateTime::now(),
            };
            if let Some(value) = vendor_result.vendor_trx_id {
                set_fields.insert("vendorTrxId", value);
            }
            if let Some(value) = vendor_result.sn {
                set_fields.insert("sn", value);
            }
            if let Some(value) = vendor_result.message {
                set_fields.insert("message", value);
            }
            let _ = collection
                .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_fields })
                .await;
        }
        Err(_) => {
            let _ = collection
                .update_one(
                    doc! { "_id": transaction_id },
                    doc! { "$set": {
                        "statusUpdatedBy": processor_id,
                        "statusUpdatedAt": DateTime::now(),
                        "statusUpdateNote": build_action_note(
                            "Pembayaran guest dikonfirmasi manual, tetapi pengiriman ke vendor gagal dan perlu dicek ulang.",
                            note.as_deref(),
                        ),
                        "updatedAt": DateTime::now(),
                    } },
                )
                .await;
        }
    }

    let transaction = populated_guest_transaction_item(&db, transaction_id)
        .await
        .unwrap_or_else(|| guest_transaction_item_from_doc(claimed));

    Json(GuestMutationResponse {
        message: "Pembayaran guest berhasil dikonfirmasi",
        transaction,
    })
    .into_response()
}

pub async fn update_status_admin(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<GuestStatusPayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "processManualTransaction").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let processor_id = proxy_user.id;
    let Ok(transaction_id) = ObjectId::parse_str(id.trim()) else {
        return status_message(StatusCode::BAD_REQUEST, "ID transaksi guest tidak valid");
    };
    let normalized = match normalize_guest_status_payload(payload) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let db = client.database(&state.mongo_db);
    let collection = db.collection::<Document>("guesttransactions");
    let Some(existing) = (match collection.find_one(doc! { "_id": transaction_id }).await {
        Ok(value) => value,
        Err(_) => return internal_error(),
    }) else {
        return status_message(StatusCode::NOT_FOUND, "Transaksi guest tidak ditemukan");
    };

    if let Err(response) = validate_guest_manual_status_transition(
        &read_string(&existing, "paymentStatus"),
        &normalized.transaction_status,
    ) {
        return response;
    }

    let now = DateTime::now();
    let mut set_fields = doc! {
        "transactionStatus": &normalized.transaction_status,
        "statusUpdatedBy": processor_id,
        "statusUpdatedAt": now,
        "statusUpdateNote": build_action_note(
            &format!(
                "Status guest transaction diubah manual ke {}",
                normalized.transaction_status.to_uppercase(),
            ),
            normalized.note.as_deref(),
        ),
        "updatedAt": now,
    };
    let mut unset_fields = Document::new();
    apply_optional_string_payload(
        &mut set_fields,
        &mut unset_fields,
        "vendorTrxId",
        normalized.vendor_trx_id,
    );
    apply_optional_string_payload(&mut set_fields, &mut unset_fields, "sn", normalized.sn);

    let mut update = doc! { "$set": set_fields };
    if !unset_fields.is_empty() {
        update.insert("$unset", unset_fields);
    }
    let fallback = match collection
        .find_one_and_update(doc! { "_id": transaction_id }, update)
        .return_document(ReturnDocument::After)
        .await
    {
        Ok(Some(document)) => document,
        Ok(None) => {
            return status_message(StatusCode::NOT_FOUND, "Transaksi guest tidak ditemukan")
        }
        Err(_) => return internal_error(),
    };

    let transaction = populated_guest_transaction_item(&db, transaction_id)
        .await
        .unwrap_or_else(|| guest_transaction_item_from_doc(fallback));

    Json(GuestMutationResponse {
        message: "Status transaksi guest diperbarui",
        transaction,
    })
    .into_response()
}
