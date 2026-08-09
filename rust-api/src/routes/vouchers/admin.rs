use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    error::ErrorKind,
};

use serde_json::Value;

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

const VOUCHER_EXPORT_LIMIT: i64 = 5000;

pub async fn admin_export(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<VoucherQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageVouchers").await {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

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
    let docs = match vouchers
        .find(match_doc)
        .sort(doc! { "createdAt": -1 })
        .limit(VOUCHER_EXPORT_LIMIT)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let users = user_briefs(&db, &docs).await;

    let mut rows = vec![vec![
        "Kode".to_string(),
        "Nominal".to_string(),
        "Status".to_string(),
        "Dibuat Oleh".to_string(),
        "Dibuat Pada".to_string(),
        "Ditukar Oleh".to_string(),
        "Ditukar Pada".to_string(),
        "Diarsip Oleh".to_string(),
        "Alasan Arsip".to_string(),
    ]];

    for document in &docs {
        let item = voucher_from_doc(document.clone(), &users);
        let status = if item.is_archived {
            "Arsip"
        } else if item.is_redeemed {
            "Redeemed"
        } else {
            "Aktif"
        };
        rows.push(vec![
            item.code,
            item.amount.to_string(),
            status.to_string(),
            item.created_by
                .as_ref()
                .map(|user| user.email.clone())
                .unwrap_or_default(),
            item.created_at,
            item.redeemed_by
                .as_ref()
                .map(|user| user.email.clone())
                .unwrap_or_default(),
            item.redeemed_at.unwrap_or_default(),
            item.archived_by
                .as_ref()
                .map(|user| user.email.clone())
                .unwrap_or_default(),
            item.archive_reason.unwrap_or_default(),
        ]);
    }

    let csv = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|value| {
                    let escaped = value.replace('"', "\"\"");
                    format!("\"{escaped}\"")
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    let date_key = DateTime::now()
        .try_to_rfc3339_string()
        .ok()
        .and_then(|value| value.get(0..10).map(ToString::to_string))
        .unwrap_or_else(|| "export".to_string());
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename=\"vouchers-{date_key}.csv\""
    )) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }
    response_headers.insert("x-export-limit", HeaderValue::from_static("5000"));

    (axum::http::StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
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
    let kind = payload
        .kind
        .as_ref()
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("balance")
        .to_ascii_lowercase();
    let is_discount = kind == "discount";
    if !matches!(kind.as_str(), "balance" | "discount") {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Jenis voucher harus balance atau discount",
        );
    }

    let normalized_amount = if is_discount {
        0
    } else {
        match normalize_amount(payload.amount) {
            Ok(value) => value,
            Err(response) => return response,
        }
    };

    let discount_type = payload
        .discount_type
        .as_ref()
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or("fixed")
        .to_ascii_lowercase();
    let discount_value = payload
        .discount_value
        .as_ref()
        .cloned()
        .and_then(|value| match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|v| v.round() as i64)),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        })
        .unwrap_or(0);
    let max_uses = payload
        .max_uses
        .as_ref()
        .cloned()
        .and_then(|value| match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|v| v.round() as i64)),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        })
        .unwrap_or(1)
        .clamp(1, 10_000);
    let min_purchase = payload
        .min_purchase
        .as_ref()
        .cloned()
        .and_then(|value| match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|v| v.round() as i64)),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        })
        .unwrap_or(0)
        .max(0);
    let max_discount = payload
        .max_discount
        .as_ref()
        .cloned()
        .and_then(|value| match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|v| v.round() as i64)),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        })
        .unwrap_or(0)
        .max(0);
    let one_per_user = payload.one_per_user.unwrap_or(true);

    if is_discount {
        if discount_type != "fixed" && discount_type != "percentage" {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Tipe diskon harus fixed atau percentage",
            );
        }
        if discount_type == "percentage" && !(1..=100).contains(&discount_value) {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Diskon persen harus 1-100",
            );
        }
        if discount_type == "fixed" && discount_value < 1 {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Diskon nominal harus lebih dari 0",
            );
        }
    }

    let parse_optional_datetime = |value: Option<Value>| -> Result<Option<DateTime>, Response> {
        let Some(text) = value.and_then(|v| match v {
            Value::String(s) => Some(s),
            _ => None,
        }) else {
            return Ok(None);
        };
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        // Accept full RFC3339 or bare local datetime-local (treat as Asia/Jakarta like flash sales).
        if let Ok(parsed) = DateTime::parse_rfc3339_str(text) {
            return Ok(Some(parsed));
        }
        // Reuse flash-sale style: append Z only as last resort is wrong for WIB; use fixed +7.
        use chrono::{FixedOffset, NaiveDateTime, TimeZone};
        let naive = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M")
            .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S"));
        if let Ok(naive) = naive {
            if let Some(jakarta) = FixedOffset::east_opt(7 * 3600) {
                if let Some(localized) = jakarta.from_local_datetime(&naive).single() {
                    return Ok(Some(DateTime::from_millis(localized.timestamp_millis())));
                }
            }
        }
        Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Format tanggal voucher tidak valid",
        ))
    };
    let starts_at = match parse_optional_datetime(payload.starts_at) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let expires_at = match parse_optional_datetime(payload.expires_at) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let (Some(start), Some(end)) = (starts_at, expires_at) {
        if start.timestamp_millis() >= end.timestamp_millis() {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Tanggal mulai harus sebelum tanggal selesai",
            );
        }
    }

    let normalized_code = match normalize_voucher_code(payload.code) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let normalized_prefix = match normalize_voucher_prefix(payload.prefix) {
        Ok(value) => value,
        Err(response) => return response,
    };
    // Prefix only applies to auto-generated batches, not custom single codes.
    if !normalized_code.is_empty() && !normalized_prefix.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Prefix tidak dipakai bersama custom code",
        );
    }
    // Discount vouchers are single public codes with maxUses slots (not batch unique codes).
    let normalized_quantity = if is_discount {
        1
    } else if normalized_code.is_empty() {
        normalize_quantity(payload.quantity)
    } else {
        1
    };
    let db = client.database(&state.mongo_db);
    let vouchers = db.collection::<Document>("vouchers");

    let codes = if is_discount || !normalized_code.is_empty() {
        let code = if normalized_code.is_empty() {
            match generate_voucher_codes(&vouchers, 1, &normalized_prefix).await {
                Ok(mut values) => values.pop().unwrap_or_default(),
                Err(response) => return response,
            }
        } else {
            normalized_code
        };
        let exists = vouchers
            .find_one(doc! { "code": &code })
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
        vec![code]
    } else {
        match generate_voucher_codes(&vouchers, normalized_quantity, &normalized_prefix).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    };

    let parse_oid_list = |values: Option<Vec<String>>| -> Vec<ObjectId> {
        values
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| ObjectId::parse_str(value.trim()).ok())
            .collect()
    };
    let scope_product_ids = parse_oid_list(payload.product_ids);
    let scope_category_ids = parse_oid_list(payload.category_ids);
    let scope_operator_ids = parse_oid_list(payload.operator_ids);

    let now = DateTime::now();
    let documents = codes
        .into_iter()
        .map(|code| {
            let mut document = if is_discount {
                doc! {
                    "code": code,
                    "kind": "discount",
                    "amount": 0_i64,
                    "discountType": &discount_type,
                    "discountValue": discount_value,
                    "maxUses": max_uses,
                    "usedCount": 0_i64,
                    "minPurchase": min_purchase,
                    "maxDiscount": max_discount,
                    "onePerUser": one_per_user,
                    "isRedeemed": false,
                    "isArchived": false,
                    "createdAt": now,
                    "updatedAt": now,
                    "__v": 0,
                }
            } else {
                doc! {
                    "code": code,
                    "kind": "balance",
                    "amount": normalized_amount,
                    "isRedeemed": false,
                    "isArchived": false,
                    "createdAt": now,
                    "updatedAt": now,
                    "__v": 0,
                }
            };
            if is_discount {
                if !scope_product_ids.is_empty() {
                    document.insert("productIds", &scope_product_ids);
                }
                if !scope_category_ids.is_empty() {
                    document.insert("categoryIds", &scope_category_ids);
                }
                if !scope_operator_ids.is_empty() {
                    document.insert("operatorIds", &scope_operator_ids);
                }
            }
            if let Some(starts_at) = starts_at {
                document.insert("startsAt", starts_at);
            }
            if let Some(expires_at) = expires_at {
                document.insert("expiresAt", expires_at);
            }
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
