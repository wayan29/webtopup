//! Checkout discount vouchers (multi-slot codes) separate from balance top-up vouchers.

use axum::response::Response;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde::Serialize;

use super::{mappers::object_id_from_bson, status_message};
use crate::utils::bson::{read_i64, read_string};

#[derive(Clone, Debug)]
pub struct AppliedDiscount {
    pub voucher_id: ObjectId,
    pub code: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub discount_amount: i64,
    pub final_price: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountValidateResponse {
    pub valid: bool,
    pub code: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub discount_amount: i64,
    pub base_amount: i64,
    pub final_amount: i64,
    pub remaining_uses: i64,
    pub message: String,
}

fn is_active_window(document: &Document, now: DateTime) -> bool {
    if let Ok(starts) = document.get_datetime("startsAt") {
        if starts.timestamp_millis() > now.timestamp_millis() {
            return false;
        }
    }
    if let Ok(ends) = document.get_datetime("expiresAt") {
        if ends.timestamp_millis() < now.timestamp_millis() {
            return false;
        }
    }
    true
}

pub fn compute_discount_amount(
    base_amount: i64,
    discount_type: &str,
    discount_value: i64,
    max_discount: i64,
    min_purchase: i64,
) -> Result<i64, &'static str> {
    if base_amount < 1 {
        return Err("Nominal belanja tidak valid");
    }
    if min_purchase > 0 && base_amount < min_purchase {
        return Err("Belum memenuhi minimum belanja voucher");
    }
    let raw = if discount_type == "percentage" {
        if discount_value < 1 || discount_value > 100 {
            return Err("Persen diskon tidak valid");
        }
        (base_amount * discount_value) / 100
    } else if discount_type == "fixed" {
        if discount_value < 1 {
            return Err("Nominal diskon tidak valid");
        }
        discount_value.min(base_amount)
    } else {
        return Err("Tipe diskon tidak valid");
    };
    let capped = if max_discount > 0 {
        raw.min(max_discount)
    } else {
        raw
    };
    let amount = capped.min(base_amount - 1).max(0); // leave at least Rp1 payable when possible
    if amount < 1 && base_amount > 1 {
        return Err("Diskon tidak menghasilkan potongan");
    }
    // Allow full free only if base is 1 and discount covers it
    Ok(if base_amount == 1 { capped.min(1) } else { amount })
}

/// Validate a discount voucher without consuming a slot.
#[derive(Clone, Debug, Default)]
pub struct DiscountProductContext {
    pub product_id: Option<ObjectId>,
    pub category_id: Option<ObjectId>,
    pub operator_id: Option<ObjectId>,
}

fn object_id_list(document: &Document, key: &str) -> Vec<ObjectId> {
    document
        .get_array(key)
        .ok()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| match value {
                    Bson::ObjectId(id) => Some(*id),
                    Bson::String(text) => ObjectId::parse_str(text).ok(),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn scope_allows(document: &Document, ctx: &DiscountProductContext) -> bool {
    let product_ids = object_id_list(document, "productIds");
    let category_ids = object_id_list(document, "categoryIds");
    let operator_ids = object_id_list(document, "operatorIds");
    // Empty scope = global voucher.
    if product_ids.is_empty() && category_ids.is_empty() && operator_ids.is_empty() {
        return true;
    }
    if let Some(product_id) = ctx.product_id {
        if product_ids.iter().any(|id| *id == product_id) {
            return true;
        }
    }
    if let Some(category_id) = ctx.category_id {
        if category_ids.iter().any(|id| *id == category_id) {
            return true;
        }
    }
    if let Some(operator_id) = ctx.operator_id {
        if operator_ids.iter().any(|id| *id == operator_id) {
            return true;
        }
    }
    false
}

pub async fn validate_discount_code(
    vouchers: &mongodb::Collection<Document>,
    code: &str,
    base_amount: i64,
    user_id: Option<ObjectId>,
    product_ctx: &DiscountProductContext,
) -> Result<DiscountValidateResponse, Response> {
    let now = DateTime::now();
    let Some(document) = vouchers
        .find_one(doc! {
            "code": code,
            "kind": "discount",
            "isArchived": false,
        })
        .await
        .ok()
        .flatten()
    else {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kode voucher diskon tidak ditemukan",
        ));
    };
    if !is_active_window(&document, now) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Voucher diskon belum aktif atau sudah kedaluwarsa",
        ));
    }
    if !scope_allows(&document, product_ctx) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Voucher diskon tidak berlaku untuk produk ini",
        ));
    }
    let max_uses = read_i64(&document, "maxUses").max(1);
    let used_count = read_i64(&document, "usedCount").max(0);
    if used_count >= max_uses {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kuota voucher diskon sudah habis",
        ));
    }
    let one_per_user = document.get_bool("onePerUser").unwrap_or(true);
    if one_per_user {
        if let Some(user_id) = user_id {
            let already = document
                .get_array("redeemedByUsers")
                .ok()
                .map(|values| {
                    values.iter().any(|value| match value {
                        Bson::ObjectId(id) => *id == user_id,
                        Bson::String(text) => ObjectId::parse_str(text).ok() == Some(user_id),
                        _ => false,
                    })
                })
                .unwrap_or(false);
            if already {
                return Err(status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Anda sudah memakai voucher ini",
                ));
            }
        }
    }
    let discount_type = read_string(&document, "discountType");
    let discount_value = read_i64(&document, "discountValue");
    let max_discount = read_i64(&document, "maxDiscount");
    let min_purchase = read_i64(&document, "minPurchase");
    let discount_amount = compute_discount_amount(
        base_amount,
        &discount_type,
        discount_value,
        max_discount,
        min_purchase,
    )
    .map_err(|message| status_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    Ok(DiscountValidateResponse {
        valid: true,
        code: code.to_string(),
        discount_type,
        discount_value,
        discount_amount,
        base_amount,
        final_amount: (base_amount - discount_amount).max(0),
        remaining_uses: (max_uses - used_count).max(0),
        message: "Voucher diskon valid".to_string(),
    })
}

/// Atomically consume one discount slot and return the applied amounts.
pub async fn consume_discount_voucher(
    vouchers: &mongodb::Collection<Document>,
    code: &str,
    base_amount: i64,
    user_id: Option<ObjectId>,
    product_ctx: &DiscountProductContext,
) -> Result<AppliedDiscount, Response> {
    let preview = validate_discount_code(vouchers, code, base_amount, user_id, product_ctx).await?;
    let now = DateTime::now();
    let mut filter = doc! {
        "code": code,
        "kind": "discount",
        "isArchived": false,
        "$expr": { "$lt": ["$usedCount", "$maxUses"] },
    };
    if let Some(user_id) = user_id {
        // onePerUser default true — reject if already in redeemedByUsers
        filter.insert(
            "$or",
            vec![
                doc! { "onePerUser": false },
                doc! { "redeemedByUsers": { "$nin": [user_id] } },
                doc! { "redeemedByUsers": { "$exists": false } },
            ],
        );
    }
    let mut update = doc! {
        "$inc": { "usedCount": 1 },
        "$set": { "updatedAt": now },
    };
    if let Some(user_id) = user_id {
        update.insert("$addToSet", doc! { "redeemedByUsers": user_id });
    }
    let claimed = vouchers
        .find_one_and_update(filter, update)
        .return_document(mongodb::options::ReturnDocument::After)
        .await;
    let Ok(Some(document)) = claimed else {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Voucher diskon tidak bisa dipakai (kuota habis atau sudah dipakai)",
        ));
    };
    let voucher_id = object_id_from_bson(document.get("_id")).ok_or_else(|| {
        status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        )
    })?;
    let max_uses = read_i64(&document, "maxUses").max(1);
    let used_count = read_i64(&document, "usedCount");
    if used_count >= max_uses {
        let _ = vouchers
            .update_one(
                doc! { "_id": voucher_id },
                doc! { "$set": { "isRedeemed": true, "updatedAt": DateTime::now() } },
            )
            .await;
    }
    Ok(AppliedDiscount {
        voucher_id,
        code: code.to_string(),
        discount_type: preview.discount_type,
        discount_value: preview.discount_value,
        discount_amount: preview.discount_amount,
        final_price: preview.final_amount,
    })
}

pub async fn release_discount_slot(
    vouchers: &mongodb::Collection<Document>,
    applied: &AppliedDiscount,
    user_id: Option<ObjectId>,
) {
    let mut update = doc! {
        "$inc": { "usedCount": -1 },
        "$set": { "isRedeemed": false, "updatedAt": DateTime::now() },
    };
    if let Some(user_id) = user_id {
        update.insert("$pull", doc! { "redeemedByUsers": user_id });
    }
    let _ = vouchers
        .update_one(doc! { "_id": applied.voucher_id }, update)
        .await;
}
