use sqlx::postgres::PgRow;
use sqlx::Row;

use super::types::{
    PointTransactionItem, PointsHistoryItem, ProductBrief, RelatedTransactionBrief, RewardBrief,
    UserBrief,
};

pub(super) fn point_transaction_from_row(row: &PgRow) -> PointTransactionItem {
    let created_at = rfc3339(row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"));
    PointTransactionItem {
        id: row.get::<i64, _>("id").to_string(),
        user: row.get::<Option<uuid::Uuid>, _>("ledger_user_id").map(|id| UserBrief {
            id: id.to_string(),
            name: row.get::<Option<String>, _>("user_name").unwrap_or_default(),
            email: row.get::<Option<String>, _>("user_email").unwrap_or_default(),
        }),
        transaction_type: row.get("transaction_type"),
        points: row.get("points"),
        description: row.get("description"),
        related_reward: row
            .get::<Option<i64>, _>("reward_id")
            .map(|id| RewardBrief {
                id: id.to_string(),
                name: row.get::<Option<String>, _>("reward_name").unwrap_or_default(),
            }),
        created_at: created_at.clone(),
        // The ledger is append-only; created_at is the last mutation timestamp.
        updated_at: created_at,
    }
}

pub(super) fn points_history_item_from_row(row: &PgRow) -> PointsHistoryItem {
    let created_at = rfc3339(row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"));
    PointsHistoryItem {
        id: row.get::<i64, _>("id").to_string(),
        user: row.get("user_ref"),
        transaction_type: row.get("transaction_type"),
        points: row.get("points"),
        description: row.get("description"),
        related_reward: row
            .get::<Option<i64>, _>("reward_id")
            .map(|id| RewardBrief {
                id: id.to_string(),
                name: row.get::<Option<String>, _>("reward_name").unwrap_or_default(),
            }),
        related_transaction: row
            .get::<Option<uuid::Uuid>, _>("related_tx_id")
            .map(|id| RelatedTransactionBrief {
                id: id.to_string(),
                amount: row.get::<Option<i64>, _>("related_tx_amount").unwrap_or_default(),
                target: row.get::<Option<String>, _>("related_tx_target").unwrap_or_default(),
                status: row.get::<Option<String>, _>("related_tx_status").unwrap_or_default(),
                product: row.get::<Option<uuid::Uuid>, _>("product_id").map(|product_id| {
                    ProductBrief {
                        id: product_id.to_string(),
                        name: row.get::<Option<String>, _>("product_name").unwrap_or_default(),
                    }
                }),
            }),
        created_at: created_at.clone(),
        // The ledger is append-only; created_at is the last mutation timestamp.
        updated_at: created_at,
    }
}

fn rfc3339(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339()
}
