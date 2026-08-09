use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, DateTime, Document};

use super::{internal_error, status_message, unavailable};
use super::{mappers::object_id_from_bson, redeem_helpers::*, types::*, validation::*};
use crate::{security::require_member_user, state::AppState, utils::bson::{read_i64, read_string}};

pub async fn redeem(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<VoucherRedeemPayload>,
) -> Response {
    let proxy_user = match require_member_user(&headers, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = proxy_user.id;
    let code = match normalize_voucher_code(payload.code) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => {
            return status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kode voucher wajib diisi",
            )
        }
        Err(response) => return response,
    };

    let db = client.database(&state.mongo_db);
    let vouchers = db.collection::<Document>("vouchers");
    let now = DateTime::now();
    let claimed = vouchers
        .find_one_and_update(
            doc! { "code": &code, "isRedeemed": false, "isArchived": false },
            doc! {
                "$set": {
                    "isRedeemed": true,
                    "redeemedBy": user_id,
                    "redeemedAt": now,
                    "updatedAt": now,
                },
            },
        )
        .return_document(mongodb::options::ReturnDocument::Before)
        .await;
    let Ok(Some(voucher)) = claimed else {
        return voucher_redeem_error(&vouchers, &code).await;
    };

    // Discount vouchers are applied at checkout, not via balance redeem.
    let kind = read_string(&voucher, "kind");
    if kind == "discount" {
        if let Some(voucher_id) = object_id_from_bson(voucher.get("_id")) {
            rollback_voucher_redeem(&vouchers, voucher_id).await;
        }
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode ini adalah voucher diskon — pakai di halaman order, bukan redeem saldo",
        );
    }

    let voucher_id = object_id_from_bson(voucher.get("_id"));
    let amount = read_i64(&voucher, "amount");
    let users = db.collection::<Document>("users");
    let updated_user = users
        .find_one_and_update(
            doc! { "_id": user_id },
            doc! { "$inc": { "balance": amount }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .await;
    let Ok(Some(user)) = updated_user else {
        if let Some(voucher_id) = voucher_id {
            rollback_voucher_redeem(&vouchers, voucher_id).await;
        }
        return status_message(axum::http::StatusCode::NOT_FOUND, "User tidak ditemukan");
    };

    let new_balance = read_i64(&user, "balance");
    if let Some(voucher_id) = voucher_id {
        let metadata_update = vouchers
            .update_one(
                doc! { "_id": voucher_id },
                doc! {
                    "$set": {
                        "redeemedBalanceBefore": new_balance - amount,
                        "redeemedBalanceAfter": new_balance,
                        "updatedAt": DateTime::now(),
                    },
                },
            )
            .await;
        if metadata_update.is_err() {
            rollback_user_balance(&users, user_id, amount).await;
            rollback_voucher_redeem(&vouchers, voucher_id).await;
            return internal_error();
        }
    }

    Json(VoucherRedeemResponse {
        message: "Voucher berhasil diredeem",
        code,
        amount,
        new_balance,
    })
    .into_response()
}
