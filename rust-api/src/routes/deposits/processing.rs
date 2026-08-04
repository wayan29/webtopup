use axum::response::Response;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::utils::bson::read_i64;

use super::responses::status_message;

pub(super) fn assignment_access_filter(
    deposit_id: ObjectId,
    actor_id: ObjectId,
    is_owner: bool,
) -> Document {
    let mut filter = doc! { "_id": deposit_id, "status": "pending" };
    if !is_owner {
        filter.insert(
            "$or",
            vec![
                doc! { "assignedTo": { "$exists": false } },
                doc! { "assignedTo": Bson::Null },
                doc! { "assignedTo": actor_id },
            ],
        );
    }
    filter
}

pub(super) fn processing_update(status: &'static str, actor_id: ObjectId, note: &str) -> Document {
    let now = DateTime::now();
    let mut update = doc! {
        "$set": {
            "status": status,
            "processedBy": actor_id,
            "processedAt": now,
            "updatedAt": now,
        },
    };
    if note.is_empty() {
        update.insert("$unset", doc! { "processingNote": "" });
    } else if let Ok(set_doc) = update.get_document_mut("$set") {
        set_doc.insert("processingNote", note.to_string());
    }
    update
}

pub(super) fn net_deposit_value(deposit: &Document) -> Result<(i64, i64), Response> {
    let admin_fee = read_i64(deposit, "adminFee").max(0);
    let net_amount = read_i64(deposit, "amount") - admin_fee;
    if net_amount <= 0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nominal bersih deposit tidak valid. Periksa biaya admin metode pembayaran ini.",
        ));
    }
    Ok((admin_fee, net_amount))
}

pub(super) async fn rollback_deposit_processing(
    deposits: &mongodb::Collection<Document>,
    deposit_id: ObjectId,
) {
    if let Err(error) = deposits
        .update_one(
            doc! { "_id": deposit_id },
            doc! {
                "$set": { "status": "pending", "updatedAt": DateTime::now() },
                "$unset": {
                    "processedBy": "",
                    "processedAt": "",
                    "processingNote": "",
                    "assignedTo": "",
                    "assignedAt": "",
                },
            },
        )
        .await
    {
        eprintln!("Failed to roll back claimed deposit approval: {error}");
    }
}

pub(super) fn normalize_processing_note(
    value: Option<String>,
    required: bool,
) -> Result<String, Response> {
    let note = value.unwrap_or_default().trim().to_string();
    if required && note.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan penolakan wajib diisi",
        ));
    }
    if note.chars().count() > 500 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Catatan proses maksimal 500 karakter",
        ));
    }
    Ok(note)
}
