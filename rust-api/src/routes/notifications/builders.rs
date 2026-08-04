use mongodb::bson::{doc, DateTime};

use crate::{utils::bson::read_string, utils::dates::start_of_today_utc};

use super::{
    queries::{callback_due_retry_filter, callback_high_attempt_count, count},
    types::{
        AdminNotificationItem, NotificationCategoryCounts, NotificationStats, NotificationTemplate,
        HIGH_CALLBACK_ATTEMPT_THRESHOLD, STUCK_TRANSACTION_MINUTES,
    },
};

pub async fn build_notifications(db: &mongodb::Database) -> Vec<AdminNotificationItem> {
    let now = DateTime::now();
    let stuck_cutoff =
        DateTime::from_millis(now.timestamp_millis() - STUCK_TRANSACTION_MINUTES * 60 * 1000);
    let orders = db.collection::<mongodb::bson::Document>("digiflazzsellerorders");

    let stuck_transactions = count(
        db,
        "transactions",
        doc! {
            "status": { "$in": ["pending", "processing"] },
            "updatedAt": { "$lte": stuck_cutoff }
        },
    )
    .await;
    let failed_transactions_today = count(
        db,
        "transactions",
        doc! { "status": "failed", "createdAt": { "$gte": start_of_today_utc() } },
    )
    .await;
    let pending_deposits = count(db, "deposits", doc! { "status": "pending" }).await;
    let callback_pending = count(
        db,
        "digiflazzsellerorders",
        doc! { "callbackRequired": true },
    )
    .await;
    let callback_due_retry = orders
        .count_documents(callback_due_retry_filter(now))
        .await
        .unwrap_or(0) as i64;
    let callback_high_attempt = callback_high_attempt_count(db).await;
    let callback_failed_today = count(
        db,
        "digiflazzsellerorders",
        doc! { "status": "failed", "createdAt": { "$gte": start_of_today_utc() } },
    )
    .await;
    let scheduler_last_error = retry_queue_scheduler_error(db).await;
    let vendor_health_alerts = vendor_health_snapshot_alerts(db).await;
    let low_balance_configured = if vendor_health_alerts.is_empty() {
        count(db, "vendors", doc! { "lowBalanceThreshold": { "$gt": 0 } }).await
    } else {
        0
    };

    let mut notifications = Vec::new();
    push_if_count(
        &mut notifications,
        stuck_transactions,
        NotificationTemplate {
            id: "transactions-stuck",
            severity: "critical",
            category: "transactions",
            title: "Transaksi macet perlu dicek",
            action_label: "Buka transaksi",
            action_path: "/admin/transactions?status=pending,processing",
            message: format!(
                "{stuck_transactions} transaksi pending/proses tidak berubah lebih dari {STUCK_TRANSACTION_MINUTES} menit."
            ),
        },
    );
    push_if_count(
        &mut notifications,
        pending_deposits,
        NotificationTemplate {
            id: "deposits-pending",
            severity: if pending_deposits > 10 {
                "warning"
            } else {
                "info"
            },
            category: "deposits",
            title: "Deposit menunggu approval",
            action_label: "Buka deposits",
            action_path: "/admin/deposits?status=pending",
            message: format!(
                "{pending_deposits} deposit masih pending dan perlu diverifikasi admin."
            ),
        },
    );
    push_if_count(
        &mut notifications,
        failed_transactions_today,
        NotificationTemplate {
            id: "transactions-failed-today",
            severity: if failed_transactions_today > 10 {
                "warning"
            } else {
                "info"
            },
            category: "transactions",
            title: "Transaksi gagal hari ini",
            action_label: "Review transaksi",
            action_path: "/admin/transactions?status=failed",
            message: format!("{failed_transactions_today} transaksi gagal sejak awal hari ini."),
        },
    );
    push_if_count(
        &mut notifications,
        callback_pending,
        NotificationTemplate {
            id: "seller-callback-pending",
            severity: "warning",
            category: "callbacks",
            title: "Callback seller pending",
            action_label: "Buka seller center",
            action_path: "/admin/addons/digiflazz-seller",
            message: format!(
                "{callback_pending} callback Digiflazz Seller masih perlu dikirim ulang. {callback_due_retry} sudah jatuh tempo retry."
            ),
        },
    );
    push_if_count(
        &mut notifications,
        callback_high_attempt,
        NotificationTemplate {
            id: "seller-callback-high-attempt",
            severity: "critical",
            category: "callbacks",
            title: "Callback seller gagal berulang",
            action_label: "Buka retry due",
            action_path: "/admin/transactions?mode=seller&callback=due",
            message: format!(
                "{callback_high_attempt} callback Digiflazz Seller sudah gagal minimal {HIGH_CALLBACK_ATTEMPT_THRESHOLD} kali."
            ),
        },
    );
    if let Some(last_error) = scheduler_last_error {
        notifications.push(build_notification(
            1,
            NotificationTemplate {
                id: "seller-callback-scheduler-failed",
                severity: "warning",
                category: "callbacks",
                title: "Scheduler callback bermasalah",
                action_label: "Buka seller center",
                action_path: "/admin/addons/digiflazz-seller",
                message: if last_error.is_empty() {
                    "Scheduler retry callback terakhir gagal diproses.".to_string()
                } else {
                    last_error
                },
            },
        ));
    }

    push_if_count(
        &mut notifications,
        callback_failed_today,
        NotificationTemplate {
            id: "seller-order-failed-today",
            severity: if callback_failed_today > 5 {
                "warning"
            } else {
                "info"
            },
            category: "callbacks",
            title: "Order seller gagal hari ini",
            action_label: "Review seller order",
            action_path: "/admin/addons/digiflazz-seller",
            message: format!(
                "{callback_failed_today} order Digiflazz Seller gagal sejak awal hari ini."
            ),
        },
    );
    notifications.extend(vendor_health_alerts);

    push_if_count(
        &mut notifications,
        low_balance_configured,
        NotificationTemplate {
            id: "vendor-low-balance-monitoring",
            severity: "info",
            category: "vendors",
            title: "Monitoring saldo vendor aktif",
            action_label: "Buka vendor health",
            action_path: "/admin/vendor-health",
            message: format!(
                "{low_balance_configured} vendor memiliki threshold saldo rendah yang dipantau."
            ),
        },
    );

    notifications.sort_by(|left, right| {
        severity_rank(left.severity)
            .cmp(&severity_rank(right.severity))
            .then(right.count.cmp(&left.count))
    });
    notifications
}

pub fn category_counts(notifications: &[AdminNotificationItem]) -> NotificationCategoryCounts {
    notifications
        .iter()
        .fold(NotificationCategoryCounts::default(), |mut counts, item| {
            match item.category {
                "transactions" => counts.transactions += 1,
                "deposits" => counts.deposits += 1,
                "vendors" => counts.vendors += 1,
                "callbacks" => counts.callbacks += 1,
                _ => {}
            }
            counts
        })
}

pub fn notification_stats(notifications: &[AdminNotificationItem]) -> NotificationStats {
    NotificationStats {
        total: notifications.len() as i64,
        unread: notifications.iter().filter(|item| item.unread).count() as i64,
        critical: notifications
            .iter()
            .filter(|item| item.severity == "critical")
            .count() as i64,
        warning: notifications
            .iter()
            .filter(|item| item.severity == "warning")
            .count() as i64,
        info: notifications
            .iter()
            .filter(|item| item.severity == "info")
            .count() as i64,
    }
}

fn push_if_count(
    notifications: &mut Vec<AdminNotificationItem>,
    count: i64,
    template: NotificationTemplate,
) {
    if count <= 0 {
        return;
    }
    notifications.push(build_notification(count, template));
}

fn build_notification(count: i64, template: NotificationTemplate) -> AdminNotificationItem {
    let fingerprint = format!("{}:{}:{}", template.id, count, template.message);
    AdminNotificationItem {
        id: template.id,
        severity: template.severity,
        category: template.category,
        title: template.title,
        message: template.message,
        count,
        action_label: template.action_label,
        action_path: template.action_path,
        fingerprint,
        read_at: None,
        dismissed_at: None,
        unread: true,
    }
}

async fn vendor_health_snapshot_alerts(db: &mongodb::Database) -> Vec<AdminNotificationItem> {
    let snapshot = db
        .collection::<mongodb::bson::Document>("settings")
        .find_one(doc! { "key": "vendorHealthSnapshot" })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned());
    let Some(snapshot) = snapshot else {
        return Vec::new();
    };
    let Ok(vendors) = snapshot.get_array("vendors") else {
        return Vec::new();
    };

    let mut alerts = Vec::new();
    for vendor in vendors {
        let Some(vendor_doc) = vendor.as_document() else {
            continue;
        };
        let key = read_string(vendor_doc, "key");
        let label = read_string(vendor_doc, "label");
        let balance_ok = vendor_doc.get_bool("balanceOk").unwrap_or(true);
        let low_balance = vendor_doc.get_bool("lowBalance").unwrap_or(false);
        let balance_message = read_string(vendor_doc, "balanceMessage");
        let balance = vendor_doc
            .get("balance")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        let threshold = vendor_doc
            .get("lowBalanceThreshold")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());

        if low_balance {
            alerts.push(build_notification(
                1,
                NotificationTemplate {
                    id: match key.as_str() {
                        "digiflazz" => "vendor-low-balance-digiflazz",
                        "tokovoucher" => "vendor-low-balance-tokovoucher",
                        _ => "vendor-low-balance-other",
                    },
                    severity: "warning",
                    category: "vendors",
                    title: match key.as_str() {
                        "digiflazz" => "Digiflazz saldo rendah",
                        "tokovoucher" => "Tokovoucher saldo rendah",
                        _ => "Vendor saldo rendah",
                    },
                    action_label: "Buka vendor health",
                    action_path: "/admin/vendor-health",
                    message: format!(
                        "Saldo {label} {balance} berada di bawah threshold {threshold}."
                    ),
                },
            ));
        } else if !balance_ok {
            alerts.push(build_notification(
                1,
                NotificationTemplate {
                    id: match key.as_str() {
                        "digiflazz" => "vendor-balance-check-failed-digiflazz",
                        "tokovoucher" => "vendor-balance-check-failed-tokovoucher",
                        _ => "vendor-balance-check-failed-other",
                    },
                    severity: "warning",
                    category: "vendors",
                    title: match key.as_str() {
                        "digiflazz" => "Digiflazz gagal cek saldo",
                        "tokovoucher" => "Tokovoucher gagal cek saldo",
                        _ => "Vendor gagal cek saldo",
                    },
                    action_label: "Buka vendor health",
                    action_path: "/admin/vendor-health",
                    message: if balance_message.is_empty() {
                        format!("Sistem tidak berhasil mengambil saldo {label}.")
                    } else {
                        balance_message
                    },
                },
            ));
        }
    }

    alerts
}

async fn retry_queue_scheduler_error(db: &mongodb::Database) -> Option<String> {
    let document = db
        .collection::<mongodb::bson::Document>("settings")
        .find_one(doc! { "key": "digiflazzSellerRetryQueueHealth" })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned())
        .unwrap_or_default();

    if read_string(&document, "status") == "failed" {
        Some(read_string(&document, "lastError"))
    } else {
        None
    }
}

fn severity_rank(severity: &str) -> i32 {
    match severity {
        "critical" => 0,
        "warning" => 1,
        _ => 2,
    }
}
