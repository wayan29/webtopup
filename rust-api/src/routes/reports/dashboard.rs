use mongodb::bson::{doc, Bson, DateTime, Document};

use crate::utils::bson::{read_i64, read_string};

use super::{
    first_document, format_date_key, format_month_key, jakarta_date_from_epoch_days,
    jakarta_epoch_days, previous_month, shift_date, tracked_profit_expression, QuickStats,
    RetryQueueHealth, RevenueBreakdown, RevenuePoint, SellerCallbackQueue,
};

const HIGH_CALLBACK_ATTEMPT_THRESHOLD: i64 = 5;

pub(super) async fn quick_dashboard_stats(
    db: &mongodb::Database,
) -> (QuickStats, RevenueBreakdown) {
    let today =
        jakarta_date_from_epoch_days(jakarta_epoch_days(DateTime::now().timestamp_millis()));
    let yesterday = shift_date(&today, -1);
    let last_month = previous_month(&today);
    let today_key = format_date_key(&today);
    let yesterday_key = format_date_key(&yesterday);
    let this_month_key = format_month_key(&today);
    let last_month_key = format_month_key(&last_month);
    let pipeline = vec![
        doc! {
            "$lookup": {
                "from": "products",
                "localField": "product",
                "foreignField": "_id",
                "as": "product"
            }
        },
        doc! { "$unwind": { "path": "$product", "preserveNullAndEmptyArrays": true } },
        doc! { "$addFields": { "trackedProfit": tracked_profit_expression() } },
        doc! { "$group": {
            "_id": Bson::Null,
            "today": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &today_key), 1, 0] } },
            "yesterday": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &yesterday_key), 1, 0] } },
            "thisMonth": { "$sum": { "$cond": [status_date_condition("%Y-%m", &this_month_key), 1, 0] } },
            "lastMonth": { "$sum": { "$cond": [status_date_condition("%Y-%m", &last_month_key), 1, 0] } },
            "todayOmset": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &today_key), "$amount", 0] } },
            "todayProfit": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &today_key), "$trackedProfit", 0] } },
            "yesterdayOmset": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &yesterday_key), "$amount", 0] } },
            "yesterdayProfit": { "$sum": { "$cond": [status_date_condition("%Y-%m-%d", &yesterday_key), "$trackedProfit", 0] } },
            "thisMonthOmset": { "$sum": { "$cond": [status_date_condition("%Y-%m", &this_month_key), "$amount", 0] } },
            "thisMonthProfit": { "$sum": { "$cond": [status_date_condition("%Y-%m", &this_month_key), "$trackedProfit", 0] } },
            "lastMonthOmset": { "$sum": { "$cond": [status_date_condition("%Y-%m", &last_month_key), "$amount", 0] } },
            "lastMonthProfit": { "$sum": { "$cond": [status_date_condition("%Y-%m", &last_month_key), "$trackedProfit", 0] } }
        } },
    ];
    let Some(document) = first_document(
        db.collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    else {
        return (QuickStats::default(), RevenueBreakdown::default());
    };

    (
        QuickStats {
            today: read_i64(&document, "today"),
            yesterday: read_i64(&document, "yesterday"),
            this_month: read_i64(&document, "thisMonth"),
            last_month: read_i64(&document, "lastMonth"),
        },
        RevenueBreakdown {
            today: RevenuePoint {
                omset: read_i64(&document, "todayOmset"),
                profit: read_i64(&document, "todayProfit"),
            },
            yesterday: RevenuePoint {
                omset: read_i64(&document, "yesterdayOmset"),
                profit: read_i64(&document, "yesterdayProfit"),
            },
            this_month: RevenuePoint {
                omset: read_i64(&document, "thisMonthOmset"),
                profit: read_i64(&document, "thisMonthProfit"),
            },
            last_month: RevenuePoint {
                omset: read_i64(&document, "lastMonthOmset"),
                profit: read_i64(&document, "lastMonthProfit"),
            },
        },
    )
}

pub(super) async fn seller_callback_queue(db: &mongodb::Database) -> SellerCallbackQueue {
    let orders = db.collection::<Document>("digiflazzsellerorders");
    let now = DateTime::now();
    let pending = orders
        .count_documents(doc! { "callbackRequired": true })
        .await
        .unwrap_or_default() as i64;
    let due = orders
        .count_documents(due_retry_filter(now))
        .await
        .unwrap_or_default() as i64;
    let high_attempt = orders
        .count_documents(doc! {
            "callbackRequired": true,
            "callbackAttemptCount": { "$gte": HIGH_CALLBACK_ATTEMPT_THRESHOLD }
        })
        .await
        .unwrap_or_default() as i64;

    SellerCallbackQueue {
        pending,
        due,
        high_attempt,
        high_attempt_threshold: HIGH_CALLBACK_ATTEMPT_THRESHOLD,
        scheduler_health: retry_queue_health(db).await,
    }
}

fn status_date_condition(format: &str, value: &str) -> Bson {
    Bson::Document(doc! { "$and": [
        { "$eq": ["$status", "success"] },
        { "$eq": [
            { "$dateToString": { "format": format, "date": "$createdAt", "timezone": "Asia/Jakarta" } },
            value
        ] }
    ] })
}

fn due_retry_filter(now: DateTime) -> Document {
    doc! {
        "status": { "$ne": "pending" },
        "callbackRequired": true,
        "$or": [
            { "callbackNextRetryAt": { "$exists": false } },
            { "callbackNextRetryAt": Bson::Null },
            { "callbackNextRetryAt": { "$lte": now } }
        ]
    }
}

async fn retry_queue_health(db: &mongodb::Database) -> RetryQueueHealth {
    let document = db
        .collection::<Document>("settings")
        .find_one(doc! { "key": "digiflazzSellerRetryQueueHealth" })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned())
        .unwrap_or_default();
    RetryQueueHealth {
        status: read_string(&document, "status").if_empty("never"),
        source: read_string(&document, "source").if_empty("unknown"),
        last_run_at: optional_date_or_string(&document, "lastRunAt"),
        processed: read_i64(&document, "processed"),
        success_count: read_i64(&document, "successCount"),
        failed_count: read_i64(&document, "failedCount"),
        remaining_due: read_i64(&document, "remainingDue"),
        last_error: read_string(&document, "lastError"),
    }
}

fn optional_date_or_string(document: &Document, key: &str) -> Option<String> {
    match document.get(key) {
        Some(Bson::DateTime(value)) => Some(
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string()),
        ),
        Some(Bson::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}
