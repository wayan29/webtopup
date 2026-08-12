use axum::{response::IntoResponse, response::Response, Json};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, DateTime, Document};

use crate::{security::ErrorResponse, utils::bson::escape_regex};

use super::{ManualTransactionsQuery, REPORT_OFFSET};

pub(super) fn build_transactions_pipeline(
    query: &ManualTransactionsQuery,
    page: i64,
    limit: i64,
    default_actionable: bool,
) -> Result<Vec<Document>, Response> {
    let status = normalized_text(query.status.as_deref());
    let source = normalized_text(query.source.as_deref());
    let scope = normalized_text(query.scope.as_deref());
    if !status.is_empty()
        && !matches!(
            status.as_str(),
            "pending" | "processing" | "success" | "failed"
        )
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Status transaksi tidak valid",
            }),
        )
            .into_response());
    }
    if !source.is_empty() && !matches!(source.as_str(), "web" | "api") {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Sumber transaksi tidak valid",
            }),
        )
            .into_response());
    }

    let start = parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (&start, &end) {
        if start > end {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Rentang tanggal transaksi tidak valid",
                }),
            )
                .into_response());
        }
    }

    let mut base_match = Document::new();
    if !status.is_empty() {
        base_match.insert("status", status);
    } else if default_actionable && scope != "all" {
        base_match.insert(
            "status",
            doc! { "$in": ["pending", "processing", "failed"] },
        );
    }
    if !source.is_empty() {
        base_match.insert("source", source);
    }
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(start) = start {
            created_at.insert("$gte", start);
        }
        if let Some(end) = end {
            created_at.insert("$lte", end);
        }
        base_match.insert("createdAt", created_at);
    }

    let mut pipeline = Vec::new();
    if !base_match.is_empty() {
        pipeline.push(doc! { "$match": base_match });
    }
    pipeline.extend([
        lookup_stage("users", "user", "user"),
        unwind_stage("$user"),
        lookup_stage("products", "product", "product"),
        unwind_stage("$product"),
        lookup_stage("users", "statusUpdatedBy", "statusUpdatedByUser"),
        unwind_stage("$statusUpdatedByUser"),
        doc! { "$addFields": { "idString": { "$toString": "$_id" }, "sourceValue": { "$ifNull": ["$source", "web"] } } },
    ]);

    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        pipeline.push(doc! { "$match": { "$or": [
            { "idString": regex.clone() },
            { "vendorTrxId": regex.clone() },
            { "customerRefId": regex.clone() },
            { "target": regex.clone() },
            { "user.name": regex.clone() },
            { "user.email": regex.clone() },
            { "product.name": regex.clone() },
            { "product.code": regex }
        ] } });
    }

    let mut product_filters = Vec::new();
    if let Some(category) = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        product_filters.push(
            doc! { "product.category": { "$regex": escape_regex(category), "$options": "i" } },
        );
    }
    if let Some(brand) = query
        .brand
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        product_filters
            .push(doc! { "product.brand": { "$regex": escape_regex(brand), "$options": "i" } });
    }
    if let Some(vendor) = query
        .vendor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        product_filters.push(
            doc! { "product.vendor.name": { "$regex": escape_regex(vendor), "$options": "i" } },
        );
    }
    if !product_filters.is_empty() {
        pipeline.push(doc! { "$match": { "$and": product_filters } });
    }

    pipeline.extend([
        doc! { "$sort": { "createdAt": -1 } },
        doc! { "$facet": {
            "items": [
                { "$skip": (page - 1) * limit },
                { "$limit": limit },
                { "$project": {
                    "_id": 1, "target": 1, "amount": 1, "status": 1,
                    "referenceId": { "$ifNull": ["$referenceId", ""] },
                    "vendorTrxId": { "$ifNull": ["$vendorTrxId", ""] },
                    "customerRefId": { "$ifNull": ["$customerRefId", ""] },
                    "sn": { "$ifNull": ["$sn", ""] },
                    "message": { "$ifNull": ["$message", ""] },
                    "refunded": { "$ifNull": ["$refunded", false] },
                    "refundedAt": 1,
                    "refundReason": { "$ifNull": ["$refundReason", ""] },
                    "source": "$sourceValue", "createdAt": 1, "updatedAt": 1,
                    "statusUpdatedAt": 1,
                    "statusUpdateNote": { "$ifNull": ["$statusUpdateNote", ""] },
                    "user": { "_id": "$user._id", "name": "$user.name", "email": "$user.email" },
                    "product": { "_id": "$product._id", "name": "$product.name", "code": "$product.code", "category": "$product.category", "brand": "$product.brand", "vendorName": "$product.vendor.name" },
                    "statusUpdatedBy": { "_id": "$statusUpdatedByUser._id", "name": "$statusUpdatedByUser.name", "email": "$statusUpdatedByUser.email", "role": "$statusUpdatedByUser.role" }
                } }
            ],
            "meta": [{ "$count": "total" }],
            "summary": [{ "$group": { "_id": null, "total": { "$sum": 1 }, "pending": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, 1, 0] } }, "processing": { "$sum": { "$cond": [{ "$eq": ["$status", "processing"] }, 1, 0] } }, "success": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, 1, 0] } }, "failed": { "$sum": { "$cond": [{ "$eq": ["$status", "failed"] }, 1, 0] } }, "amountTotal": { "$sum": "$amount" } } }]
        } },
    ]);

    Ok(pipeline)
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, Response> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !is_date_text(value) {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Format tanggal transaksi tidak valid",
            }),
        )
            .into_response());
    }
    let time = if end_of_day {
        "23:59:59.999"
    } else {
        "00:00:00.000"
    };
    DateTime::parse_rfc3339_str(format!("{value}T{time}{REPORT_OFFSET}"))
        .map(Some)
        .map_err(|_| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Format tanggal transaksi tidak valid",
                }),
            )
                .into_response()
        })
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

pub(super) fn lookup_stage(from: &str, local_field: &str, as_field: &str) -> Document {
    doc! { "$lookup": { "from": from, "localField": local_field, "foreignField": "_id", "as": as_field } }
}

pub(super) fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}
