use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    error::ErrorKind,
};

use super::{internal_error, status_message, unavailable};
use super::{mappers::*, queries::*, types::*, validation::*};
use crate::{
    security::{require_permission, ErrorResponse},
    state::AppState,
};

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<VoucherQuery>,
) -> Response {
    let _proxy_user = match require_permission(&headers, &state, "manageVouchers").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let page = query.page.unwrap_or(1).clamp(1, 100_000);
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let match_doc = match build_match(client, &state.mongo_db, &query).await {
        Ok(value) => value,
        Err(message) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse { message }),
            )
                .into_response();
        }
    };

    let db = client.database(&state.mongo_db);
    let vouchers = db.collection::<Document>("vouchers");
    let total = vouchers
        .count_documents(match_doc.clone())
        .await
        .unwrap_or_default() as i64;
    let docs = match vouchers
        .find(match_doc.clone())
        .sort(doc! { "createdAt": -1 })
        .skip(((page - 1) * limit) as u64)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let users = user_briefs(&db, &docs).await;
    let summary = voucher_summary(&vouchers, match_doc).await;

    Json(VoucherResponse {
        items: docs
            .into_iter()
            .map(|document| voucher_from_doc(document, &users))
            .collect(),
        meta: VoucherMeta {
            page,
            limit,
            total,
            total_pages: std::cmp::max(1, (total + limit - 1) / limit),
        },
        summary,
    })
    .into_response()
}

pub async fn create(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<VoucherCreatePayload>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "manageVouchers").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let creator_id = proxy_user.id;
    let normalized_amount = match normalize_amount(payload.amount) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let normalized_code = match normalize_voucher_code(payload.code) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let normalized_quantity = if normalized_code.is_empty() {
        normalize_quantity(payload.quantity)
    } else {
        1
    };
    let db = client.database(&state.mongo_db);
    let vouchers = db.collection::<Document>("vouchers");

    let codes = if normalized_code.is_empty() {
        match generate_voucher_codes(&vouchers, normalized_quantity).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        let exists = vouchers
            .find_one(doc! { "code": &normalized_code })
            .await
            .ok()
            .flatten()
            .is_some();
        if exists {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kode voucher sudah dipakai",
            );
        }
        vec![normalized_code]
    };

    let now = DateTime::now();
    let documents = codes
        .into_iter()
        .map(|code| {
            let mut document = doc! {
                "code": code,
                "amount": normalized_amount,
                "isRedeemed": false,
                "isArchived": false,
                "createdAt": now,
                "updatedAt": now,
                "__v": 0,
            };
            document.insert("createdBy", creator_id);
            document
        })
        .collect::<Vec<_>>();

    let inserted_ids = if documents.len() == 1 {
        match vouchers
            .insert_one(documents.into_iter().next().unwrap())
            .await
        {
            Ok(result) => result
                .inserted_id
                .as_object_id()
                .map(|id| vec![id])
                .unwrap_or_default(),
            Err(error) => {
                if is_duplicate_key_error(&error) {
                    return status_message(
                        axum::http::StatusCode::BAD_REQUEST,
                        "Kode voucher sudah dipakai",
                    );
                }
                return internal_error();
            }
        }
    } else {
        match vouchers.insert_many(documents).ordered(true).await {
            Ok(result) => result
                .inserted_ids
                .into_values()
                .filter_map(|value| value.as_object_id())
                .collect(),
            Err(error) => {
                if is_duplicate_key_error(&error) {
                    return status_message(
                        axum::http::StatusCode::BAD_REQUEST,
                        "Kode voucher sudah dipakai",
                    );
                }
                return internal_error();
            }
        }
    };

    let created_docs = match vouchers
        .find(doc! { "_id": { "$in": inserted_ids } })
        .sort(doc! { "createdAt": -1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let users = user_briefs(&db, &created_docs).await;
    let items = created_docs
        .into_iter()
        .map(|document| voucher_from_doc(document, &users))
        .collect::<Vec<_>>();
    let created_count = items.len() as i64;
    (
        axum::http::StatusCode::CREATED,
        Json(VoucherCreateResponse {
            message: if created_count == 1 {
                "Voucher berhasil dibuat".to_string()
            } else {
                format!("{} voucher berhasil dibuat", created_count)
            },
            items,
            created_count,
        }),
    )
        .into_response()
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    matches!(
        error.kind.as_ref(),
        ErrorKind::Write(_) | ErrorKind::InsertMany(_)
    ) && error.to_string().contains("E11000")
}

pub async fn archive(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    payload: Option<Json<VoucherArchivePayload>>,
) -> Response {
    let proxy_user = match require_permission(&headers, &state, "manageVouchers").await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let processor_id = proxy_user.id;
    let voucher_id = match ObjectId::parse_str(id.trim()) {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID voucher tidak valid",
            )
        }
    };
    let reason = match normalize_archive_reason(payload.and_then(|Json(payload)| payload.reason)) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let vouchers = client
        .database(&state.mongo_db)
        .collection::<Document>("vouchers");
    let Some(voucher) = vouchers
        .find_one(doc! { "_id": voucher_id })
        .await
        .ok()
        .flatten()
    else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Voucher tidak ditemukan");
    };
    if voucher.get_bool("isArchived").unwrap_or(false) {
        return Json(VoucherActionResponse {
            message: "Voucher sudah diarsipkan",
            archived: Some(true),
        })
        .into_response();
    }
    let is_redeemed = voucher.get_bool("isRedeemed").unwrap_or(false);
    let archive_reason = if !reason.is_empty() {
        reason
    } else if is_redeemed {
        "Voucher redeemed diarsipkan untuk audit".to_string()
    } else {
        "Voucher diarsipkan manual oleh admin".to_string()
    };
    let mut set_doc = doc! {
        "isArchived": true,
        "archivedAt": DateTime::now(),
        "archiveReason": archive_reason,
        "updatedAt": DateTime::now(),
    };
    set_doc.insert("archivedBy", processor_id);
    if vouchers
        .update_one(doc! { "_id": voucher_id }, doc! { "$set": set_doc })
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(VoucherActionResponse {
        message: if is_redeemed {
            "Voucher redeemed diarsipkan agar histori audit tetap tersimpan"
        } else {
            "Voucher berhasil diarsipkan"
        },
        archived: Some(true),
    })
    .into_response()
}

pub async fn restore(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageVouchers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let voucher_id = match ObjectId::parse_str(id.trim()) {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "ID voucher tidak valid",
            )
        }
    };
    let vouchers = client
        .database(&state.mongo_db)
        .collection::<Document>("vouchers");
    let Some(voucher) = vouchers
        .find_one(doc! { "_id": voucher_id })
        .await
        .ok()
        .flatten()
    else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Voucher tidak ditemukan");
    };
    if !voucher.get_bool("isArchived").unwrap_or(false) {
        return Json(serde_json::json!({ "message": "Voucher sudah aktif" })).into_response();
    }
    if voucher.get_bool("isRedeemed").unwrap_or(false) {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Voucher yang sudah diredeem tidak bisa diaktifkan kembali",
        );
    }
    if vouchers
        .update_one(
            doc! { "_id": voucher_id },
            doc! {
                "$set": { "isArchived": false, "updatedAt": DateTime::now() },
                "$unset": { "archivedBy": "", "archivedAt": "", "archiveReason": "" },
            },
        )
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(serde_json::json!({ "message": "Voucher berhasil diaktifkan kembali" })).into_response()
}
