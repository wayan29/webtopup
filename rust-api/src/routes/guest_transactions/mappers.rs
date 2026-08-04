use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::utils::bson::{read_i64, read_string};

use super::{
    date_string, lookup_stage, optional_string, GuestTransactionItem, PaymentMethodBrief,
    ProductBrief, UserBrief,
};

pub(super) async fn populated_guest_transaction_item(
    db: &mongodb::Database,
    transaction_id: ObjectId,
) -> Option<GuestTransactionItem> {
    let document = db
        .collection::<Document>("guesttransactions")
        .aggregate(vec![
            doc! { "$match": { "_id": transaction_id } },
            lookup_stage("products", "product", "product"),
            unwind_stage("$product"),
            lookup_stage("users", "user", "user"),
            unwind_stage("$user"),
            lookup_stage("paymentmethods", "paymentMethod", "paymentMethod"),
            unwind_stage("$paymentMethod"),
            lookup_stage("paymentcategories", "paymentMethod.category", "paymentCategory"),
            unwind_stage("$paymentCategory"),
            lookup_stage("users", "statusUpdatedBy", "statusUpdatedByUser"),
            unwind_stage("$statusUpdatedByUser"),
            doc! { "$project": {
                "_id": 1,
                "invoiceNumber": 1,
                "target": 1,
                "whatsapp": 1,
                "email": 1,
                "amount": 1,
                "adminFee": { "$ifNull": ["$adminFee", 0] },
                "uniqueCode": { "$ifNull": ["$uniqueCode", 0] },
                "totalAmount": 1,
                "paymentStatus": 1,
                "transactionStatus": 1,
                "vendorTrxId": 1,
                "sn": 1,
                "paidAt": 1,
                "expiredAt": 1,
                "createdAt": 1,
                "updatedAt": 1,
                "statusUpdatedAt": 1,
                "statusUpdateNote": 1,
                "product": { "_id": "$product._id", "name": "$product.name", "code": "$product.code", "category": "$product.category", "brand": "$product.brand", "vendorName": "$product.vendor.name" },
                "user": { "_id": "$user._id", "name": "$user.name", "email": "$user.email" },
                "paymentMethod": { "_id": "$paymentMethod._id", "name": "$paymentMethod.name", "categoryName": "$paymentCategory.name", "accountName": "$paymentMethod.accountName", "accountNumber": "$paymentMethod.accountNumber" },
                "statusUpdatedBy": { "_id": "$statusUpdatedByUser._id", "name": "$statusUpdatedByUser.name", "email": "$statusUpdatedByUser.email", "role": "$statusUpdatedByUser.role" }
            } },
            doc! { "$limit": 1 },
        ])
        .await
        .ok()?
        .try_collect::<Vec<_>>()
        .await
        .ok()?
        .into_iter()
        .next()?;
    Some(guest_transaction_item_from_doc(document))
}

pub(super) fn guest_transaction_item_from_doc(mut document: Document) -> GuestTransactionItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();

    GuestTransactionItem {
        id,
        invoice_number: read_string(&document, "invoiceNumber"),
        target: read_string(&document, "target"),
        whatsapp: read_string(&document, "whatsapp"),
        email: optional_string(&document, "email"),
        amount: read_i64(&document, "amount"),
        admin_fee: read_i64(&document, "adminFee"),
        unique_code: read_i64(&document, "uniqueCode"),
        total_amount: read_i64(&document, "totalAmount"),
        payment_status: read_string(&document, "paymentStatus"),
        transaction_status: read_string(&document, "transactionStatus"),
        vendor_trx_id: optional_string(&document, "vendorTrxId"),
        sn: optional_string(&document, "sn"),
        paid_at: date_string(&document, "paidAt"),
        expired_at: date_string(&document, "expiredAt").unwrap_or_default(),
        created_at: date_string(&document, "createdAt").unwrap_or_default(),
        updated_at: date_string(&document, "updatedAt").unwrap_or_default(),
        status_updated_at: date_string(&document, "statusUpdatedAt"),
        status_update_note: optional_string(&document, "statusUpdateNote"),
        product: document
            .get_document("product")
            .ok()
            .and_then(product_brief_from_doc),
        user: document
            .get_document("user")
            .ok()
            .and_then(user_brief_from_doc),
        payment_method: document
            .get_document("paymentMethod")
            .ok()
            .and_then(payment_method_from_doc),
        status_updated_by: document
            .get_document("statusUpdatedBy")
            .ok()
            .and_then(user_brief_from_doc),
    }
}

fn product_brief_from_doc(document: &Document) -> Option<ProductBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(ProductBrief {
        id,
        name: read_string(document, "name"),
        code: read_string(document, "code"),
        category: read_string(document, "category"),
        brand: read_string(document, "brand"),
        vendor_name: optional_string(document, "vendorName"),
    })
}

fn user_brief_from_doc(document: &Document) -> Option<UserBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(UserBrief {
        id,
        name: read_string(document, "name"),
        email: read_string(document, "email"),
        role: optional_string(document, "role"),
    })
}

fn payment_method_from_doc(document: &Document) -> Option<PaymentMethodBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(PaymentMethodBrief {
        id,
        name: read_string(document, "name"),
        category_name: optional_string(document, "categoryName"),
        account_name: optional_string(document, "accountName"),
        account_number: optional_string(document, "accountNumber"),
    })
}

fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}
