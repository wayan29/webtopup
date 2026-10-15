use chrono::Utc;
use sqlx::PgPool;

use super::types::{
    AdminNotificationItem, NotificationCategoryCounts, NotificationStats, NotificationTemplate,
    HIGH_CALLBACK_ATTEMPT_THRESHOLD, STUCK_TRANSACTION_MINUTES,
};

pub async fn build_notifications(
    pool: &PgPool,
) -> Result<Vec<AdminNotificationItem>, sqlx::Error> {
    let now = Utc::now();
    let stuck_cutoff = now - chrono::Duration::minutes(STUCK_TRANSACTION_MINUTES);
    let day_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let stuck: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM financial_transactions WHERE status IN ('pending','processing') AND updated_at <= $1")
        .bind(stuck_cutoff).fetch_one(pool).await?;
    let failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM financial_transactions WHERE status='failed' AND created_at >= $1")
        .bind(day_start).fetch_one(pool).await?;
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deposits WHERE status='pending'")
        .fetch_one(pool).await?;
    let callbacks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seller_callbacks WHERE status <> 'success'")
        .fetch_one(pool).await?;
    let callback_due: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seller_callbacks WHERE status <> 'success' AND (next_retry_at IS NULL OR next_retry_at <= $1)")
        .bind(now).fetch_one(pool).await?;
    let high_attempt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seller_callbacks WHERE status <> 'success' AND attempt_count >= $1")
        .bind(HIGH_CALLBACK_ATTEMPT_THRESHOLD).fetch_one(pool).await?;
    let callback_failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seller_orders WHERE status='failed' AND created_at >= $1")
        .bind(day_start).fetch_one(pool).await?;
    let low_balance: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vendors WHERE low_balance_threshold > 0")
        .fetch_one(pool).await?;

    let mut notifications = Vec::new();
    push_if_count(&mut notifications, stuck, NotificationTemplate { id:"transactions-stuck", severity:"critical", category:"transactions", title:"Transaksi macet perlu dicek", action_label:"Buka transaksi", action_path:"/admin/transactions?status=pending,processing", message:format!("{stuck} transaksi pending/proses tidak berubah lebih dari {STUCK_TRANSACTION_MINUTES} menit.") });
    push_if_count(&mut notifications, pending, NotificationTemplate { id:"deposits-pending", severity:if pending > 10 {"warning"} else {"info"}, category:"deposits", title:"Deposit menunggu approval", action_label:"Buka deposits", action_path:"/admin/deposits?status=pending", message:format!("{pending} deposit masih pending dan perlu diverifikasi admin.") });
    push_if_count(&mut notifications, failed, NotificationTemplate { id:"transactions-failed-today", severity:if failed > 10 {"warning"} else {"info"}, category:"transactions", title:"Transaksi gagal hari ini", action_label:"Review transaksi", action_path:"/admin/transactions?status=failed", message:format!("{failed} transaksi gagal sejak awal hari ini.") });
    push_if_count(&mut notifications, callbacks, NotificationTemplate { id:"seller-callback-pending", severity:"warning", category:"callbacks", title:"Callback seller pending", action_label:"Buka seller center", action_path:"/admin/addons/digiflazz-seller", message:format!("{callbacks} callback seller masih perlu dikirim ulang. {callback_due} sudah jatuh tempo retry.") });
    push_if_count(&mut notifications, high_attempt, NotificationTemplate { id:"seller-callback-high-attempt", severity:"critical", category:"callbacks", title:"Callback seller gagal berulang", action_label:"Buka retry due", action_path:"/admin/transactions?mode=seller&callback=due", message:format!("{high_attempt} callback seller sudah gagal minimal {HIGH_CALLBACK_ATTEMPT_THRESHOLD} kali.") });
    push_if_count(&mut notifications, callback_failed, NotificationTemplate { id:"seller-order-failed-today", severity:if callback_failed > 5 {"warning"} else {"info"}, category:"callbacks", title:"Order seller gagal hari ini", action_label:"Review seller order", action_path:"/admin/addons/digiflazz-seller", message:format!("{callback_failed} order seller gagal sejak awal hari ini.") });
    push_if_count(&mut notifications, low_balance, NotificationTemplate { id:"vendor-low-balance-monitoring", severity:"info", category:"vendors", title:"Monitoring saldo vendor aktif", action_label:"Buka vendor health", action_path:"/admin/vendor-health", message:format!("{low_balance} vendor memiliki threshold saldo rendah yang dipantau.") });
    notifications.sort_by(|a, b| severity_rank(a.severity).cmp(&severity_rank(b.severity)).then(b.count.cmp(&a.count)));
    Ok(notifications)
}

pub fn category_counts(notifications: &[AdminNotificationItem]) -> NotificationCategoryCounts {
    notifications.iter().fold(NotificationCategoryCounts::default(), |mut counts, item| {
        match item.category { "transactions" => counts.transactions += 1, "deposits" => counts.deposits += 1, "callbacks" => counts.callbacks += 1, "vendors" => counts.vendors += 1, _ => {} }
        counts
    })
}

pub fn notification_stats(notifications: &[AdminNotificationItem]) -> NotificationStats {
    NotificationStats { total: notifications.len() as i64, unread: notifications.iter().filter(|item| item.unread).count() as i64, critical: notifications.iter().filter(|item| item.severity == "critical").count() as i64, warning: notifications.iter().filter(|item| item.severity == "warning").count() as i64, info: notifications.iter().filter(|item| item.severity == "info").count() as i64 }
}

fn push_if_count(items: &mut Vec<AdminNotificationItem>, count: i64, template: NotificationTemplate) {
    if count > 0 { items.push(build_notification(count, template)); }
}

fn build_notification(count: i64, template: NotificationTemplate) -> AdminNotificationItem {
    let fingerprint = format!("{}:{}:{}", template.id, count, template.message);
    AdminNotificationItem { id: template.id, severity: template.severity, category: template.category, title: template.title, message: template.message, count, action_label: template.action_label, action_path: template.action_path, fingerprint, read_at: None, dismissed_at: None, unread: true }
}

fn severity_rank(severity: &str) -> i32 { match severity { "critical" => 0, "warning" => 1, _ => 2 } }
