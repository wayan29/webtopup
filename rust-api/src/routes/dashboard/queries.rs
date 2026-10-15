use sqlx::{PgPool, Row};

use super::types::{
    DepositOpsSummary, PromoOpsSummary, StuckOpsSummary, TransactionTodaySummary, VendorOpsSummary,
};

pub async fn ops_snapshot_queries(
    pool: &PgPool,
) -> (
    TransactionTodaySummary,
    DepositOpsSummary,
    VendorOpsSummary,
    StuckOpsSummary,
    PromoOpsSummary,
) {
    let transactions_today = match sqlx::query(
        "SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE status='success')::bigint AS success, COUNT(*) FILTER (WHERE status IN ('pending','processing'))::bigint AS pending, COUNT(*) FILTER (WHERE status='failed')::bigint AS failed, COALESCE(SUM(amount) FILTER (WHERE status='success'),0)::bigint AS omset FROM financial_transactions WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    ).fetch_one(pool).await {
        Ok(row) => {
            let total: i64 = row.get("total");
            let success: i64 = row.get("success");
            TransactionTodaySummary { total, success, pending: row.get("pending"), failed: row.get("failed"), omset: row.get("omset"), success_rate: if total > 0 { ((success as f64 / total as f64) * 100.0).round() as i64 } else { 0 } }
        }
        Err(_) => TransactionTodaySummary::default(),
    };
    let deposits = sqlx::query("SELECT COUNT(*)::bigint AS pending, COALESCE(SUM(amount),0)::bigint AS amount, COALESCE(SUM(COALESCE(total_amount,amount)),0)::bigint AS total FROM deposits WHERE status='pending'")
        .fetch_one(pool).await.map(|row| DepositOpsSummary { pending: row.get("pending"), pending_amount_total: row.get("amount"), pending_transfer_total: row.get("total") }).unwrap_or_default();
    let vendors = sqlx::query("SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE status)::bigint AS active, COUNT(*) FILTER (WHERE NOT status)::bigint AS inactive, COUNT(*) FILTER (WHERE low_balance_threshold>0)::bigint AS low_balance FROM vendors")
        .fetch_one(pool).await.map(|row| VendorOpsSummary { total: row.get("total"), active: row.get("active"), inactive: row.get("inactive"), low_balance_configured: row.get("low_balance") }).unwrap_or_default();
    let stuck = sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM financial_transactions WHERE status IN ('pending','processing') AND updated_at <= now()-interval '15 minutes'")
        .fetch_one(pool).await.unwrap_or(0);
    // Giveaway aggregates remain None until SQL has an authoritative giveaway entity and credit-event table.
    let promo = sqlx::query("SELECT COUNT(*) FILTER(WHERE kind='balance' AND NOT is_redeemed AND NOT is_archived AND created_at<=now()-interval '30 days')::bigint idle,COUNT(*) FILTER(WHERE kind='discount' AND NOT is_archived AND used_count<max_uses)::bigint discount_open,(SELECT COUNT(*)::bigint FROM content_flash_sales WHERE is_active AND start_date<=now() AND end_date>=now()) flash_live FROM vouchers")
        .fetch_one(pool).await.map(|row| PromoOpsSummary { idle_vouchers: row.get("idle"), discount_vouchers_open: row.get("discount_open"), flash_sales_live: row.get("flash_live"), ..PromoOpsSummary::default() }).unwrap_or_default();
    (transactions_today, deposits, vendors, StuckOpsSummary { threshold_minutes: 15, total: stuck }, promo)
}
