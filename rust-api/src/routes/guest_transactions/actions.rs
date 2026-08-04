use axum::{http::StatusCode, response::IntoResponse, Json};
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::ErrorResponse, utils::bson::read_string};

use super::{GuestStatusPayload, OwnedErrorResponse};

pub(super) struct NormalizedGuestStatusPayload {
    pub(super) transaction_status: String,
    pub(super) note: Option<String>,
    pub(super) vendor_trx_id: Option<Option<String>>,
    pub(super) sn: Option<Option<String>>,
}

pub(super) async fn guest_cancel_rejection(
    collection: &mongodb::Collection<Document>,
    transaction_id: ObjectId,
) -> axum::response::Response {
    let existing = match collection
        .find_one(doc! { "_id": transaction_id })
        .projection(doc! { "paymentStatus": 1, "transactionStatus": 1 })
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let Some(existing) = existing else {
        return status_message(StatusCode::NOT_FOUND, "Transaksi guest tidak ditemukan");
    };
    let payment_status = read_string(&existing, "paymentStatus");
    let transaction_status = read_string(&existing, "transactionStatus");

    if payment_status == "cancelled" {
        return status_message(StatusCode::BAD_REQUEST, "Transaksi guest sudah dibatalkan");
    }
    if payment_status == "expired" {
        return status_message(StatusCode::BAD_REQUEST, "Transaksi guest sudah expired");
    }
    if payment_status == "paid" && transaction_status == "processing" {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi guest yang sudah diproses vendor tidak bisa langsung dibatalkan. Selesaikan status fulfillment terlebih dahulu.",
        );
    }
    if payment_status == "paid" && transaction_status == "success" {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi guest yang sukses tidak bisa dibatalkan",
        );
    }

    status_message(
        StatusCode::BAD_REQUEST,
        "Transaksi guest tidak bisa dibatalkan",
    )
}

pub(super) async fn guest_confirm_rejection(
    collection: &mongodb::Collection<Document>,
    transaction_id: ObjectId,
) -> axum::response::Response {
    let existing = match collection
        .find_one(doc! { "_id": transaction_id })
        .projection(doc! { "paymentStatus": 1, "transactionStatus": 1, "expiredAt": 1 })
        .await
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    let Some(existing) = existing else {
        return status_message(StatusCode::NOT_FOUND, "Transaksi guest tidak ditemukan");
    };
    let payment_status = read_string(&existing, "paymentStatus");

    if payment_status == "paid" {
        return status_message(
            StatusCode::BAD_REQUEST,
            "Pembayaran guest sudah dikonfirmasi sebelumnya",
        );
    }
    if payment_status == "cancelled" {
        return status_message(StatusCode::BAD_REQUEST, "Transaksi guest sudah dibatalkan");
    }
    if payment_status == "expired" {
        return status_message(StatusCode::BAD_REQUEST, "Transaksi guest sudah expired");
    }

    status_message(
        StatusCode::BAD_REQUEST,
        "Transaksi guest tidak bisa dikonfirmasi",
    )
}

pub(super) fn normalize_guest_status_payload(
    payload: GuestStatusPayload,
) -> Result<NormalizedGuestStatusPayload, axum::response::Response> {
    let transaction_status = payload.transaction_status.trim().to_string();
    if !matches!(
        transaction_status.as_str(),
        "pending" | "processing" | "success" | "failed"
    ) {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Status transaksi guest tidak valid",
        ));
    }

    Ok(NormalizedGuestStatusPayload {
        transaction_status,
        note: normalize_optional_text(payload.note.as_deref(), 500, "Catatan tindakan")?,
        vendor_trx_id: normalize_optional_payload_text(
            payload.vendor_trx_id,
            120,
            "Vendor Trx ID",
        )?,
        sn: normalize_optional_payload_text(payload.sn, 300, "SN / Token")?,
    })
}

pub(super) fn normalize_optional_text(
    value: Option<&str>,
    max_length: usize,
    label: &'static str,
) -> Result<Option<String>, axum::response::Response> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.trim().to_string();
    if text.len() > max_length {
        return Err(status_message_owned(
            StatusCode::BAD_REQUEST,
            format!("{label} maksimal {max_length} karakter"),
        ));
    }
    Ok(Some(text).filter(|value| !value.is_empty()))
}

pub(super) fn validate_guest_manual_status_transition(
    payment_status: &str,
    next_status: &str,
) -> Result<(), axum::response::Response> {
    if payment_status == "waiting_payment" && next_status != "pending" {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi guest yang belum dibayar hanya boleh tetap berstatus pending. Konfirmasi pembayaran terlebih dahulu.",
        ));
    }
    if payment_status == "paid" && !matches!(next_status, "processing" | "success" | "failed") {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi guest yang sudah dibayar hanya bisa diubah ke processing, success, atau failed.",
        ));
    }
    if matches!(payment_status, "expired" | "cancelled") && next_status != "failed" {
        return Err(status_message(
            StatusCode::BAD_REQUEST,
            "Transaksi guest yang sudah expired atau dibatalkan hanya boleh berstatus failed.",
        ));
    }
    Ok(())
}

fn normalize_optional_payload_text(
    value: Option<String>,
    max_length: usize,
    label: &'static str,
) -> Result<Option<Option<String>>, axum::response::Response> {
    match value {
        Some(value) => normalize_optional_text(Some(&value), max_length, label).map(Some),
        None => Ok(None),
    }
}

fn internal_error() -> axum::response::Response {
    status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn status_message(status: StatusCode, message: &'static str) -> axum::response::Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn status_message_owned(status: StatusCode, message: String) -> axum::response::Response {
    (status, Json(OwnedErrorResponse { message })).into_response()
}
