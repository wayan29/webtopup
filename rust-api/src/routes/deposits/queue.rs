use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::types::{DepositQueueItem, DepositQueueSummary};

pub(super) async fn build_deposit_queue_summary(
    pool: &PgPool,
    actor_id: Option<Uuid>,
) -> DepositQueueSummary {
    let summary = sqlx::query(
        "SELECT COUNT(*)::bigint AS total, \
         COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending, \
         COUNT(*) FILTER (WHERE status = 'approved')::bigint AS approved, \
         COUNT(*) FILTER (WHERE status = 'rejected')::bigint AS rejected, \
         COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::bigint AS pending_amount_total, \
         COALESCE(SUM(COALESCE(total_amount, amount)) FILTER (WHERE status = 'pending'), 0)::bigint AS pending_transfer_total, \
         COUNT(*) FILTER (WHERE status = 'pending' AND assigned_to IS NULL)::bigint AS unassigned, \
         COUNT(*) FILTER (WHERE status = 'pending' AND assigned_to = $1)::bigint AS mine, \
         COUNT(*) FILTER (WHERE status = 'pending' AND assigned_to IS NOT NULL AND ($1::uuid IS NULL OR assigned_to <> $1))::bigint AS locked \
         FROM deposits",
    )
    .bind(actor_id)
    .fetch_one(pool)
    .await;

    match summary {
        Ok(row) => DepositQueueSummary {
            total: row.get("total"),
            pending: row.get("pending"),
            approved: row.get("approved"),
            rejected: row.get("rejected"),
            unassigned: row.get("unassigned"),
            mine: row.get("mine"),
            locked: row.get("locked"),
            pending_amount_total: row.get("pending_amount_total"),
            pending_transfer_total: row.get("pending_transfer_total"),
        },
        Err(_) => DepositQueueSummary::default(),
    }
}

pub(super) async fn latest_pending_deposits(pool: &PgPool) -> Vec<DepositQueueItem> {
    let rows = sqlx::query(
        "SELECT id, invoice_code, status, amount, admin_fee, total_amount, assigned_to, assigned_at, created_at \
         FROM deposits WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5",
    )
    .fetch_all(pool)
    .await;

    rows.unwrap_or_default()
        .into_iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            let id = id.to_string();
            let amount: i64 = row.get("amount");
            let total_amount: Option<i64> = row.get("total_amount");
            let invoice_code: Option<String> = row.get("invoice_code");
            let assigned_to: Option<Uuid> = row.get("assigned_to");
            let assigned_at: Option<chrono::DateTime<chrono::Utc>> = row.get("assigned_at");
            let created_at: chrono::DateTime<chrono::Utc> = row.get("created_at");

            DepositQueueItem {
                invoice: invoice_code.unwrap_or_else(|| format_invoice_code(&id)),
                id,
                status: row.get("status"),
                amount,
                admin_fee: row.get("admin_fee"),
                total_amount: total_amount.filter(|value| *value > 0).unwrap_or(amount),
                assigned_to: assigned_to.map(|value| value.to_string()),
                assigned_at: assigned_at.map(|value| value.to_string()),
                created_at: created_at.to_string(),
            }
        })
        .collect()
}

fn format_invoice_code(id: &str) -> String {
    let compact_id: String = id.chars().filter(|character| *character != '-').collect();
    let suffix = compact_id.get(16..24).unwrap_or(&compact_id).to_uppercase();
    format!("INV{suffix}")
}
