use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use crate::utils::bson::{read_i64, read_string};

use super::types::{DepositQueueItem, DepositQueueSummary};

pub(super) async fn build_deposit_queue_summary(
    collection: &mongodb::Collection<Document>,
    actor_id: Option<ObjectId>,
) -> DepositQueueSummary {
    let pending_filter = doc! { "status": "pending" };
    let unassigned_filter = doc! {
        "status": "pending",
        "$or": [
            { "assignedTo": { "$exists": false } },
            { "assignedTo": Bson::Null }
        ]
    };
    let mine_filter = actor_id
        .map(|id| doc! { "status": "pending", "assignedTo": id })
        .unwrap_or_else(|| doc! { "status": "pending", "_id": { "$exists": false } });
    let locked_filter = actor_id
        .map(|id| doc! { "status": "pending", "assignedTo": { "$nin": [Bson::Null, Bson::ObjectId(id)] } })
        .unwrap_or_else(|| doc! { "status": "pending", "assignedTo": { "$ne": Bson::Null } });

    let pipeline = vec![doc! {
        "$group": {
            "_id": null,
            "total": { "$sum": 1 },
            "pending": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, 1, 0] } },
            "approved": { "$sum": { "$cond": [{ "$eq": ["$status", "approved"] }, 1, 0] } },
            "rejected": { "$sum": { "$cond": [{ "$eq": ["$status", "rejected"] }, 1, 0] } },
            "pendingAmountTotal": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, "$amount", 0] } },
            "pendingTransferTotal": { "$sum": { "$cond": [{ "$eq": ["$status", "pending"] }, { "$ifNull": ["$totalAmount", "$amount"] }, 0] } }
        }
    }];

    let mut base_summary = match collection.aggregate(pipeline).await {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .ok()
            .and_then(|mut items| items.pop())
            .map(|item| DepositQueueSummary {
                total: read_i64(&item, "total"),
                pending: read_i64(&item, "pending"),
                approved: read_i64(&item, "approved"),
                rejected: read_i64(&item, "rejected"),
                pending_amount_total: read_i64(&item, "pendingAmountTotal"),
                pending_transfer_total: read_i64(&item, "pendingTransferTotal"),
                ..DepositQueueSummary::default()
            })
            .unwrap_or_default(),
        Err(_) => DepositQueueSummary::default(),
    };

    base_summary.unassigned = collection
        .count_documents(unassigned_filter)
        .await
        .unwrap_or(0) as i64;
    base_summary.mine = collection.count_documents(mine_filter).await.unwrap_or(0) as i64;
    base_summary.locked = collection.count_documents(locked_filter).await.unwrap_or(0) as i64;
    let pending_count = collection
        .count_documents(pending_filter)
        .await
        .unwrap_or(0) as i64;
    if base_summary.pending == 0 && pending_count > 0 {
        base_summary.pending = pending_count;
    }

    base_summary
}

pub(super) async fn latest_pending_deposits(
    collection: &mongodb::Collection<Document>,
) -> Vec<DepositQueueItem> {
    match collection
        .find(doc! { "status": "pending" })
        .sort(doc! { "createdAt": -1 })
        .limit(5)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(deposit_queue_item_from_doc)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn deposit_queue_item_from_doc(mut document: Document) -> DepositQueueItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let total_amount = read_i64(&document, "totalAmount");
    let amount = read_i64(&document, "amount");

    DepositQueueItem {
        invoice: format_invoice_code(&id),
        id,
        status: read_string(&document, "status"),
        amount,
        admin_fee: read_i64(&document, "adminFee"),
        total_amount: if total_amount > 0 {
            total_amount
        } else {
            amount
        },
        assigned_to: document
            .get_object_id("assignedTo")
            .map(|id| id.to_hex())
            .ok(),
        assigned_at: document
            .get_datetime("assignedAt")
            .map(|value| value.to_string())
            .ok(),
        created_at: document
            .get_datetime("createdAt")
            .map(|value| value.to_string())
            .unwrap_or_default(),
    }
}

fn format_invoice_code(id: &str) -> String {
    let suffix = id.get(16..24).unwrap_or(id).to_uppercase();
    format!("INV{suffix}")
}
