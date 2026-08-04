use futures_util::TryStreamExt;
use mongodb::bson::{doc, DateTime, Document};

use crate::utils::{bson::read_i64, dates::start_of_today_utc};

use super::types::{DepositOpsSummary, StuckOpsSummary, TransactionTodaySummary, VendorOpsSummary};

pub async fn transaction_today_summary(db: &mongodb::Database) -> TransactionTodaySummary {
    let pipeline = vec![
        doc! { "$match": { "createdAt": { "$gte": start_of_today_utc() } } },
        doc! {
            "$group": {
                "_id": null,
                "total": { "$sum": 1 },
                "success": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, 1, 0] } },
                "pending": { "$sum": { "$cond": [{ "$in": ["$status", ["pending", "processing"]] }, 1, 0] } },
                "failed": { "$sum": { "$cond": [{ "$eq": ["$status", "failed"] }, 1, 0] } },
                "omset": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, "$amount", 0] } }
            }
        },
    ];

    first_document(
        db.collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    .map(|item| {
        let total = read_i64(&item, "total");
        let success = read_i64(&item, "success");
        TransactionTodaySummary {
            total,
            success,
            pending: read_i64(&item, "pending"),
            failed: read_i64(&item, "failed"),
            omset: read_i64(&item, "omset"),
            success_rate: if total > 0 {
                ((success as f64 / total as f64) * 100.0).round() as i64
            } else {
                0
            },
        }
    })
    .unwrap_or_default()
}

pub async fn deposit_ops_summary(db: &mongodb::Database) -> DepositOpsSummary {
    let pipeline = vec![
        doc! { "$match": { "status": "pending" } },
        doc! {
            "$group": {
                "_id": null,
                "pending": { "$sum": 1 },
                "pendingAmountTotal": { "$sum": "$amount" },
                "pendingTransferTotal": { "$sum": { "$ifNull": ["$totalAmount", "$amount"] } }
            }
        },
    ];

    first_document(
        db.collection::<Document>("deposits")
            .aggregate(pipeline)
            .await,
    )
    .await
    .map(|item| DepositOpsSummary {
        pending: read_i64(&item, "pending"),
        pending_amount_total: read_i64(&item, "pendingAmountTotal"),
        pending_transfer_total: read_i64(&item, "pendingTransferTotal"),
    })
    .unwrap_or_default()
}

pub async fn vendor_ops_summary(db: &mongodb::Database) -> VendorOpsSummary {
    let pipeline = vec![doc! {
        "$group": {
            "_id": null,
            "total": { "$sum": 1 },
            "active": { "$sum": { "$cond": [{ "$eq": ["$status", true] }, 1, 0] } },
            "inactive": { "$sum": { "$cond": [{ "$eq": ["$status", false] }, 1, 0] } },
            "lowBalanceConfigured": { "$sum": { "$cond": [{ "$gt": [{ "$ifNull": ["$lowBalanceThreshold", 0] }, 0] }, 1, 0] } }
        }
    }];

    first_document(
        db.collection::<Document>("vendors")
            .aggregate(pipeline)
            .await,
    )
    .await
    .map(|item| VendorOpsSummary {
        total: read_i64(&item, "total"),
        active: read_i64(&item, "active"),
        inactive: read_i64(&item, "inactive"),
        low_balance_configured: read_i64(&item, "lowBalanceConfigured"),
    })
    .unwrap_or_default()
}

pub async fn stuck_ops_summary(db: &mongodb::Database, threshold_minutes: i64) -> StuckOpsSummary {
    let cutoff =
        DateTime::from_millis(DateTime::now().timestamp_millis() - threshold_minutes * 60 * 1000);
    let total = db
        .collection::<Document>("transactions")
        .count_documents(doc! {
            "status": { "$in": ["pending", "processing"] },
            "updatedAt": { "$lte": cutoff }
        })
        .await
        .unwrap_or(0) as i64;

    StuckOpsSummary {
        threshold_minutes,
        total,
    }
}

async fn first_document(
    cursor_result: mongodb::error::Result<mongodb::Cursor<Document>>,
) -> Option<Document> {
    let mut cursor = cursor_result.ok()?;
    cursor.try_next().await.ok().flatten()
}
