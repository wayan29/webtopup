use axum::{response::Response, Json};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use super::status_message;
use crate::security::ErrorResponse;

pub(super) async fn voucher_redeem_error(
    vouchers: &mongodb::Collection<Document>,
    code: &str,
) -> Response {
    let voucher = vouchers
        .find_one(doc! { "code": code })
        .projection(doc! { "isRedeemed": 1, "isArchived": 1 })
        .await
        .ok()
        .flatten();
    let Some(voucher) = voucher else {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode voucher tidak valid atau sudah tidak bisa diredeem",
        );
    };
    if voucher.get_bool("isArchived").unwrap_or(false)
        || voucher.get_bool("isRedeemed").unwrap_or(false)
    {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode voucher tidak valid atau sudah tidak bisa diredeem",
        );
    }
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "Voucher tidak bisa diredeem",
    )
}

pub(super) async fn rollback_voucher_redeem(
    vouchers: &mongodb::Collection<Document>,
    voucher_id: ObjectId,
) {
    if let Err(error) = vouchers
        .update_one(
            doc! { "_id": voucher_id },
            doc! {
                "$set": { "isRedeemed": false, "updatedAt": DateTime::now() },
                "$unset": {
                    "redeemedBy": "",
                    "redeemedAt": "",
                    "redeemedBalanceBefore": "",
                    "redeemedBalanceAfter": "",
                },
            },
        )
        .await
    {
        eprintln!("Failed to roll back voucher redeem metadata: {error}");
    }
}

pub(super) async fn rollback_user_balance(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
    amount: i64,
) {
    if let Err(error) = users
        .update_one(
            doc! { "_id": user_id },
            doc! { "$inc": { "balance": -amount }, "$set": { "updatedAt": DateTime::now() } },
        )
        .await
    {
        eprintln!("Failed to roll back voucher redeem balance: {error}");
    }
}

#[allow(dead_code)]
fn _keep_error_response_import(_: Json<ErrorResponse>) {}
