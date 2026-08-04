use axum::{http::StatusCode, response::IntoResponse, Json};
use mongodb::bson::{doc, DateTime, Document};

use crate::{security::ErrorResponse, utils::bson::escape_regex};

use super::{lookup_stage, GuestTransactionsQuery, REPORT_OFFSET};

pub(super) fn build_pipeline(
    query: &GuestTransactionsQuery,
    page: i64,
    limit: i64,
) -> Result<Vec<Document>, axum::response::Response> {
    let payment_status = normalized_text(query.payment_status.as_deref());
    let transaction_status = normalized_text(query.transaction_status.as_deref());
    let scope = normalized_text(query.scope.as_deref());

    if !payment_status.is_empty()
        && !matches!(
            payment_status.as_str(),
            "waiting_payment" | "paid" | "expired" | "cancelled"
        )
    {
        return Err(status_message("Status pembayaran guest tidak valid"));
    }
    if !transaction_status.is_empty()
        && !matches!(
            transaction_status.as_str(),
            "pending" | "processing" | "success" | "failed"
        )
    {
        return Err(status_message("Status transaksi guest tidak valid"));
    }

    let start = parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (&start, &end) {
        if start > end {
            return Err(status_message(
                "Rentang tanggal guest transaction tidak valid",
            ));
        }
    }

    let mut clauses = Vec::new();
    if scope != "all" {
        clauses.push(doc! { "$or": [
            { "paymentStatus": "waiting_payment" },
            { "paymentStatus": "paid", "transactionStatus": { "$ne": "success" } }
        ] });
    }
    if !payment_status.is_empty() {
        clauses.push(doc! { "paymentStatus": payment_status });
    }
    if !transaction_status.is_empty() {
        clauses.push(doc! { "transactionStatus": transaction_status });
    }
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(start) = start {
            created_at.insert("$gte", start);
        }
        if let Some(end) = end {
            created_at.insert("$lte", end);
        }
        clauses.push(doc! { "createdAt": created_at });
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        clauses.push(doc! { "$or": [
            { "invoiceNumber": regex.clone() },
            { "target": regex.clone() },
            { "whatsapp": regex.clone() },
            { "email": regex.clone() },
            { "vendorTrxId": regex.clone() },
            { "sn": regex }
        ] });
    }

    let base_match = if clauses.is_empty() {
        Document::new()
    } else if clauses.len() == 1 {
        clauses.remove(0)
    } else {
        doc! { "$and": clauses }
    };

    let mut pipeline = Vec::new();
    if !base_match.is_empty() {
        pipeline.push(doc! { "$match": base_match });
    }
    pipeline.extend([
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
        doc! { "$sort": { "createdAt": -1 } },
        doc! { "$facet": {
            "items": [
                { "$skip": (page - 1) * limit },
                { "$limit": limit },
                { "$project": {
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
                } }
            ],
            "meta": [{ "$count": "total" }],
            "summary": [{ "$group": { "_id": null, "total": { "$sum": 1 }, "amountTotal": { "$sum": "$totalAmount" }, "waitingPayment": { "$sum": { "$cond": [{ "$eq": ["$paymentStatus", "waiting_payment"] }, 1, 0] } }, "paid": { "$sum": { "$cond": [{ "$eq": ["$paymentStatus", "paid"] }, 1, 0] } }, "expired": { "$sum": { "$cond": [{ "$eq": ["$paymentStatus", "expired"] }, 1, 0] } }, "cancelled": { "$sum": { "$cond": [{ "$eq": ["$paymentStatus", "cancelled"] }, 1, 0] } }, "processing": { "$sum": { "$cond": [{ "$eq": ["$transactionStatus", "processing"] }, 1, 0] } }, "success": { "$sum": { "$cond": [{ "$eq": ["$transactionStatus", "success"] }, 1, 0] } }, "failed": { "$sum": { "$cond": [{ "$eq": ["$transactionStatus", "failed"] }, 1, 0] } } } }]
        } },
    ]);

    Ok(pipeline)
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, axum::response::Response> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_date_text(value) {
        return Err(status_message(
            "Format tanggal guest transaction tidak valid",
        ));
    }
    let time = if end_of_day {
        "23:59:59.999"
    } else {
        "00:00:00.000"
    };
    DateTime::parse_rfc3339_str(format!("{value}T{time}{REPORT_OFFSET}"))
        .map(Some)
        .map_err(|_| status_message("Format tanggal guest transaction tidak valid"))
}

fn is_date_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, value)| index == 4 || index == 7 || value.is_ascii_digit())
}

fn normalized_text(value: Option<&str>) -> String {
    value.map(str::trim).unwrap_or_default().to_lowercase()
}

fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}

fn status_message(message: &'static str) -> axum::response::Response {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { message })).into_response()
}
