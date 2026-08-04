use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};

use crate::utils::bson::read_i64;

use super::types::{DepositStats, GuestStats, MethodStats};

pub(super) async fn find_sorted(
    db: &mongodb::Database,
    collection: &str,
    sort: Document,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .find(Document::new())
        .sort(sort)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) async fn aggregate_documents(
    db: &mongodb::Database,
    collection: &str,
    pipeline: Vec<Document>,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) async fn method_stats_by_category(
    db: &mongodb::Database,
) -> HashMap<String, MethodStats> {
    let pipeline = vec![
        doc! { "$match": { "category": { "$type": "objectId" } } },
        doc! { "$group": { "_id": "$category", "methodCount": { "$sum": 1 }, "activeMethodCount": { "$sum": { "$cond": [{ "$eq": ["$status", "active"] }, 1, 0] } }, "inactiveMethodCount": { "$sum": { "$cond": [{ "$eq": ["$status", "inactive"] }, 1, 0] } } } },
    ];
    aggregate_documents(db, "paymentmethods", pipeline)
        .await
        .into_iter()
        .filter_map(|d| {
            Some((
                d.get_object_id("_id").ok()?.to_hex(),
                MethodStats {
                    method_count: read_i64(&d, "methodCount"),
                    active_method_count: read_i64(&d, "activeMethodCount"),
                    inactive_method_count: read_i64(&d, "inactiveMethodCount"),
                },
            ))
        })
        .collect()
}

pub(super) async fn deposit_stats_by_method(
    db: &mongodb::Database,
) -> HashMap<String, DepositStats> {
    let pipeline = vec![
        doc! { "$match": { "paymentMethod": { "$type": "objectId" } } },
        doc! { "$group": { "_id": "$paymentMethod", "depositCount": { "$sum": 1 }, "pendingDepositCount": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, 1, 0] } } } },
    ];
    aggregate_documents(db, "deposits", pipeline)
        .await
        .into_iter()
        .filter_map(|d| {
            Some((
                d.get_object_id("_id").ok()?.to_hex(),
                DepositStats {
                    deposit_count: read_i64(&d, "depositCount"),
                    pending_deposit_count: read_i64(&d, "pendingDepositCount"),
                },
            ))
        })
        .collect()
}

pub(super) async fn guest_stats_by_method(db: &mongodb::Database) -> HashMap<String, GuestStats> {
    let pipeline = vec![
        doc! { "$group": { "_id": "$paymentMethod", "guestTransactionCount": { "$sum": 1 }, "waitingPaymentCount": { "$sum": { "$cond": [{ "$eq": ["$paymentStatus", "waiting_payment"] }, 1, 0] } } } },
    ];
    aggregate_documents(db, "guesttransactions", pipeline)
        .await
        .into_iter()
        .filter_map(|d| {
            Some((
                d.get_object_id("_id").ok()?.to_hex(),
                GuestStats {
                    guest_transaction_count: read_i64(&d, "guestTransactionCount"),
                    waiting_payment_count: read_i64(&d, "waitingPaymentCount"),
                },
            ))
        })
        .collect()
}
