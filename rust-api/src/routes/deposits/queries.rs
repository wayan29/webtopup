use axum::{
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use crate::{security::ErrorResponse, utils::bson::escape_regex};

use super::{
    mappers::admin_deposit_item_from_doc,
    types::{AdminDepositItem, AdminDepositsQuery},
};

pub(super) fn build_admin_deposits_pipeline(
    query: &AdminDepositsQuery,
    actor_id: Option<ObjectId>,
    page: i64,
    limit: i64,
) -> Result<Vec<Document>, Response> {
    let status = query.status.as_deref().map(str::trim).unwrap_or_default();
    let assignment = query
        .assignment
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if !status.is_empty() && !matches!(status, "pending" | "approved" | "rejected") {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Status deposit tidak valid",
            }),
        )
            .into_response());
    }
    if !assignment.is_empty() && !matches!(assignment, "unassigned" | "mine" | "locked") {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Filter claim deposit tidak valid",
            }),
        )
            .into_response());
    }
    if !assignment.is_empty() && actor_id.is_none() {
        return Err((
            axum::http::StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                message: "Unauthorized",
            }),
        )
            .into_response());
    }

    let mut base_match = Document::new();
    if !status.is_empty() {
        base_match.insert("status", status);
    }
    if assignment == "unassigned" {
        base_match.insert("status", "pending");
        base_match.insert(
            "$or",
            vec![
                doc! { "assignedTo": { "$exists": false } },
                doc! { "assignedTo": Bson::Null },
            ],
        );
    } else if assignment == "mine" {
        base_match.insert("status", "pending");
        base_match.insert("assignedTo", actor_id.expect("actor_id checked"));
    } else if assignment == "locked" {
        base_match.insert("status", "pending");
        base_match.insert(
            "assignedTo",
            doc! { "$nin": [Bson::Null, Bson::ObjectId(actor_id.expect("actor_id checked"))] },
        );
    }

    let mut pipeline = Vec::new();
    if !base_match.is_empty() {
        pipeline.push(doc! { "$match": base_match });
    }
    pipeline.extend([
        lookup_stage("users", "user", "user"),
        unwind_stage("$user"),
        lookup_stage("paymentmethods", "paymentMethod", "paymentMethod"),
        unwind_stage("$paymentMethod"),
        lookup_stage("users", "assignedTo", "assignedToUser"),
        unwind_stage("$assignedToUser"),
        lookup_stage("users", "processedBy", "processedByUser"),
        unwind_stage("$processedByUser"),
        doc! {
            "$addFields": {
                "idString": { "$toString": "$_id" },
                "invoiceCode": { "$concat": ["INV", { "$toUpper": { "$substrBytes": [{ "$toString": "$_id" }, 16, 8] } }] },
                "effectiveTotalAmount": { "$ifNull": ["$totalAmount", "$amount"] },
                "effectiveTotalAmountString": { "$toString": { "$ifNull": ["$totalAmount", "$amount"] } },
                "netAmount": { "$subtract": ["$amount", { "$ifNull": ["$adminFee", 0] }] }
            }
        },
    ]);

    let mut search_filters = Vec::new();
    if let Some(invoice_id) = query
        .invoice_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(invoice_id), "$options": "i" };
        search_filters
            .push(doc! { "$or": [{ "idString": regex.clone() }, { "invoiceCode": regex }] });
    }
    if let Some(user_query) = query
        .user_query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(user_query), "$options": "i" };
        search_filters
            .push(doc! { "$or": [{ "user.name": regex.clone() }, { "user.email": regex }] });
    }
    if let Some(total_transfer) = query
        .total_transfer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        search_filters.push(
            doc! { "effectiveTotalAmountString": { "$regex": escape_regex(total_transfer) } },
        );
    }
    if !search_filters.is_empty() {
        pipeline.push(doc! { "$match": { "$and": search_filters } });
    }

    pipeline.extend([
        doc! { "$sort": { "createdAt": -1 } },
        doc! {
            "$facet": {
                "items": [
                    { "$skip": (page - 1) * limit },
                    { "$limit": limit },
                    { "$project": {
                        "_id": 1,
                        "amount": 1,
                        "uniqueCode": { "$ifNull": ["$uniqueCode", 0] },
                        "adminFee": { "$ifNull": ["$adminFee", 0] },
                        "totalAmount": "$effectiveTotalAmount",
                        "netAmount": 1,
                        "status": 1,
                        "createdAt": 1,
                        "updatedAt": 1,
                        "assignedAt": 1,
                        "processedAt": 1,
                        "processingNote": { "$ifNull": ["$processingNote", ""] },
                        "invoiceCode": 1,
                        "user": { "_id": "$user._id", "name": "$user.name", "email": "$user.email" },
                        "paymentMethod": { "_id": "$paymentMethod._id", "name": "$paymentMethod.name", "accountNumber": "$paymentMethod.accountNumber", "accountName": "$paymentMethod.accountName" },
                        "assignedTo": { "_id": "$assignedToUser._id", "name": "$assignedToUser.name", "email": "$assignedToUser.email", "role": "$assignedToUser.role" },
                        "processedBy": { "_id": "$processedByUser._id", "name": "$processedByUser.name", "email": "$processedByUser.email", "role": "$processedByUser.role" }
                    } }
                ],
                "meta": [{ "$count": "total" }],
                "summary": [{ "$group": { "_id": null, "total": { "$sum": 1 }, "pending": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, 1, 0] } }, "approved": { "$sum": { "$cond": [{ "$eq": ["$status", "approved"] }, 1, 0] } }, "rejected": { "$sum": { "$cond": [{ "$eq": ["$status", "rejected"] }, 1, 0] } } } }]
            }
        },
    ]);

    Ok(pipeline)
}

fn lookup_stage(from: &str, local_field: &str, as_field: &str) -> Document {
    doc! { "$lookup": { "from": from, "localField": local_field, "foreignField": "_id", "as": as_field } }
}

fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}

pub(super) fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}

pub(super) async fn first_document(
    cursor_result: mongodb::error::Result<mongodb::Cursor<Document>>,
) -> Option<Document> {
    let mut cursor = cursor_result.ok()?;
    cursor.try_next().await.ok().flatten()
}

pub(super) fn first_array_item(document: &Document, key: &str) -> Option<Document> {
    document
        .get_array(key)
        .ok()
        .and_then(|items| items.first())
        .and_then(|item| item.as_document())
        .cloned()
}

pub(super) fn document_array(document: &Document, key: &str) -> Vec<Document> {
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

pub(super) async fn populated_admin_deposit_by_id(
    db: &mongodb::Database,
    deposit_id: ObjectId,
) -> Option<AdminDepositItem> {
    let mut docs = db
        .collection::<Document>("deposits")
        .aggregate(vec![
            doc! { "$match": { "_id": deposit_id } },
            lookup_stage("users", "user", "user"),
            unwind_stage("$user"),
            lookup_stage("paymentmethods", "paymentMethod", "paymentMethod"),
            unwind_stage("$paymentMethod"),
            lookup_stage("users", "assignedTo", "assignedToUser"),
            unwind_stage("$assignedToUser"),
            lookup_stage("users", "processedBy", "processedByUser"),
            unwind_stage("$processedByUser"),
            doc! {
                "$addFields": {
                    "invoiceCode": { "$concat": ["INV", { "$toUpper": { "$substrBytes": [{ "$toString": "$_id" }, 16, 8] } }] },
                    "effectiveTotalAmount": { "$ifNull": ["$totalAmount", "$amount"] },
                    "netAmount": { "$subtract": ["$amount", { "$ifNull": ["$adminFee", 0] }] }
                }
            },
            doc! {
                "$project": {
                    "_id": 1,
                    "amount": 1,
                    "uniqueCode": { "$ifNull": ["$uniqueCode", 0] },
                    "adminFee": { "$ifNull": ["$adminFee", 0] },
                    "totalAmount": "$effectiveTotalAmount",
                    "netAmount": 1,
                    "status": 1,
                    "createdAt": 1,
                    "updatedAt": 1,
                    "assignedAt": 1,
                    "processedAt": 1,
                    "processingNote": { "$ifNull": ["$processingNote", ""] },
                    "invoiceCode": 1,
                    "user": { "_id": "$user._id", "name": "$user.name", "email": "$user.email" },
                    "paymentMethod": { "_id": "$paymentMethod._id", "name": "$paymentMethod.name", "accountNumber": "$paymentMethod.accountNumber", "accountName": "$paymentMethod.accountName" },
                    "assignedTo": { "_id": "$assignedToUser._id", "name": "$assignedToUser.name", "email": "$assignedToUser.email", "role": "$assignedToUser.role" },
                    "processedBy": { "_id": "$processedByUser._id", "name": "$processedByUser.name", "email": "$processedByUser.email", "role": "$processedByUser.role" }
                }
            },
        ])
        .await
        .ok()?;
    docs.try_next()
        .await
        .ok()
        .flatten()
        .map(admin_deposit_item_from_doc)
}
