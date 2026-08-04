use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Datelike, Local};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};
use rand::{distributions::Alphanumeric, Rng};

use crate::{
    security::ErrorResponse,
    utils::bson::{read_i64, read_string},
};

const MAX_LIMIT: i64 = 100;
const REPORT_OFFSET: &str = "+07:00";

mod actions;
mod admin;
mod checkout;
mod idempotency;
mod list;
mod mappers;
mod provider;
mod public;
mod types;
mod utils;

use actions::*;
pub use admin::{admin_list, cancel_admin, confirm_admin, update_status_admin};
use checkout::*;
use list::*;
use mappers::*;
use provider::*;
pub use public::{check_public, create_public};
use types::*;
use utils::*;

fn generate_guest_ref_id() -> String {
    let now = Local::now();
    let random = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(4)
        .map(char::from)
        .collect::<String>()
        .to_uppercase();
    format!(
        "GUEST{:02}{:02}{}{random}",
        now.day(),
        now.month(),
        now.year()
    )
}

async fn populated_guest_transaction_check(
    db: &mongodb::Database,
    transaction_id: ObjectId,
) -> Option<GuestTransactionCheckItem> {
    let document = db
        .collection::<Document>("guesttransactions")
        .aggregate(vec![
            doc! { "$match": { "_id": transaction_id } },
            lookup_stage("products", "product", "product"),
            unwind_stage("$product"),
            lookup_stage("paymentmethods", "paymentMethod", "paymentMethod"),
            unwind_stage("$paymentMethod"),
            doc! { "$limit": 1 },
        ])
        .await
        .ok()?
        .try_collect::<Vec<_>>()
        .await
        .ok()?
        .into_iter()
        .next()?;
    guest_transaction_check_from_doc(&document)
}

fn apply_optional_string_payload(
    set_fields: &mut Document,
    unset_fields: &mut Document,
    key: &str,
    value: Option<Option<String>>,
) {
    match value {
        Some(Some(value)) => {
            set_fields.insert(key, value);
        }
        Some(None) => {
            unset_fields.insert(key, 1);
        }
        None => {}
    }
}

fn build_action_note(fallback_note: &str, note: Option<&str>) -> String {
    note.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_note)
        .to_string()
}

fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}

async fn first_document(
    cursor_result: mongodb::error::Result<mongodb::Cursor<Document>>,
) -> Option<Document> {
    let mut cursor = cursor_result.ok()?;
    cursor.try_next().await.ok().flatten()
}

fn first_array_item(document: &Document, key: &str) -> Option<Document> {
    document
        .get_array(key)
        .ok()
        .and_then(|items| items.first())
        .and_then(|item| item.as_document())
        .cloned()
}

fn document_array(document: &Document, key: &str) -> Vec<Document> {
    document
        .get_array(key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_document().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn lookup_stage(from: &str, local_field: &str, as_field: &str) -> Document {
    doc! { "$lookup": { "from": from, "localField": local_field, "foreignField": "_id", "as": as_field } }
}

fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}

fn guest_transaction_check_from_doc(document: &Document) -> Option<GuestTransactionCheckItem> {
    let product = document
        .get_document("product")
        .ok()
        .and_then(product_check_from_doc)?;
    let payment_method = document
        .get_document("paymentMethod")
        .ok()
        .and_then(payment_method_check_from_doc)?;

    Some(GuestTransactionCheckItem {
        id: document.get_object_id("_id").map(|id| id.to_hex()).ok()?,
        invoice_number: read_string(document, "invoiceNumber"),
        user: object_id_string(document, "user"),
        product,
        target: read_string(document, "target"),
        server_id: optional_string(document, "serverId"),
        whatsapp: read_string(document, "whatsapp"),
        email: optional_string(document, "email"),
        amount: read_i64(document, "amount"),
        admin_fee: read_i64(document, "adminFee"),
        unique_code: read_i64(document, "uniqueCode"),
        total_amount: read_i64(document, "totalAmount"),
        payment_method,
        payment_status: read_string(document, "paymentStatus"),
        transaction_status: read_string(document, "transactionStatus"),
        expired_at: date_string(document, "expiredAt").unwrap_or_default(),
        created_at: date_string(document, "createdAt").unwrap_or_default(),
        updated_at: date_string(document, "updatedAt").unwrap_or_default(),
        version: Some(read_i64(document, "__v")),
        paid_at: date_string(document, "paidAt"),
        vendor_trx_id: optional_string(document, "vendorTrxId"),
        sn: optional_string(document, "sn"),
        status_update_note: optional_string(document, "statusUpdateNote"),
        status_updated_at: date_string(document, "statusUpdatedAt"),
        status_updated_by: object_id_string(document, "statusUpdatedBy"),
    })
}

fn product_check_from_doc(document: &Document) -> Option<ProductCheckBrief> {
    Some(ProductCheckBrief {
        id: document.get_object_id("_id").map(|id| id.to_hex()).ok()?,
        code: read_string(document, "code"),
        name: read_string(document, "name"),
    })
}

fn payment_method_check_from_doc(document: &Document) -> Option<PaymentMethodCheckBrief> {
    Some(PaymentMethodCheckBrief {
        id: document.get_object_id("_id").map(|id| id.to_hex()).ok()?,
        name: read_string(document, "name"),
        category: object_id_string(document, "category"),
        account_number: optional_string(document, "accountNumber"),
        account_name: optional_string(document, "accountName"),
    })
}

fn transaction_not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            message: "Transaction not found",
        }),
    )
        .into_response()
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}

fn internal_error() -> Response {
    status_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn status_message(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn status_message_owned(status: StatusCode, message: String) -> Response {
    (status, Json(OwnedErrorResponse { message })).into_response()
}
