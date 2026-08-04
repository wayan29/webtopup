use serde::{ser::SerializeStruct, Deserialize, Serialize};

#[derive(Clone, Copy)]
pub(super) struct SimpleDate {
    pub(super) year: i32,
    pub(super) month: u32,
    pub(super) day: u32,
}

#[derive(Deserialize)]
pub struct SalesSummaryQuery {
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<String>,
}

#[derive(Serialize)]
pub(super) struct SalesSummaryResponse {
    pub(super) summary: SalesSummary,
    #[serde(rename = "categoryData")]
    pub(super) category_data: Vec<CategorySummary>,
    #[serde(rename = "dailyData")]
    pub(super) daily_data: Vec<DailySummary>,
    #[serde(rename = "recentTransactions")]
    pub(super) recent_transactions: Vec<RecentTransaction>,
}

#[derive(Serialize)]
pub(super) struct DashboardOverviewResponse {
    pub(super) summary: SalesSummary,
    #[serde(rename = "categoryData")]
    pub(super) category_data: Vec<CategorySummary>,
    #[serde(rename = "dailyData")]
    pub(super) daily_data: Vec<DailySummary>,
    #[serde(rename = "recentTransactions")]
    pub(super) recent_transactions: Vec<RecentTransaction>,
    #[serde(rename = "quickStats")]
    pub(super) quick_stats: QuickStats,
    #[serde(rename = "revenueBreakdown")]
    pub(super) revenue_breakdown: RevenueBreakdown,
    #[serde(rename = "sellerCallbackQueue")]
    pub(super) seller_callback_queue: SellerCallbackQueue,
    #[serde(rename = "lastUpdatedAt")]
    pub(super) last_updated_at: String,
}

#[derive(Default, Serialize)]
pub(super) struct QuickStats {
    pub(super) today: i64,
    pub(super) yesterday: i64,
    #[serde(rename = "thisMonth")]
    pub(super) this_month: i64,
    #[serde(rename = "lastMonth")]
    pub(super) last_month: i64,
}

#[derive(Default, Serialize)]
pub(super) struct RevenueBreakdown {
    pub(super) today: RevenuePoint,
    pub(super) yesterday: RevenuePoint,
    #[serde(rename = "thisMonth")]
    pub(super) this_month: RevenuePoint,
    #[serde(rename = "lastMonth")]
    pub(super) last_month: RevenuePoint,
}

#[derive(Default, Serialize)]
pub(super) struct RevenuePoint {
    pub(super) omset: i64,
    pub(super) profit: i64,
}

#[derive(Serialize)]
pub(super) struct SellerCallbackQueue {
    pub(super) pending: i64,
    pub(super) due: i64,
    #[serde(rename = "highAttempt")]
    pub(super) high_attempt: i64,
    #[serde(rename = "highAttemptThreshold")]
    pub(super) high_attempt_threshold: i64,
    #[serde(rename = "schedulerHealth")]
    pub(super) scheduler_health: RetryQueueHealth,
}

#[derive(Serialize)]
pub(super) struct RetryQueueHealth {
    pub(super) status: String,
    pub(super) source: String,
    #[serde(rename = "lastRunAt")]
    pub(super) last_run_at: Option<String>,
    pub(super) processed: i64,
    #[serde(rename = "successCount")]
    pub(super) success_count: i64,
    #[serde(rename = "failedCount")]
    pub(super) failed_count: i64,
    #[serde(rename = "remainingDue")]
    pub(super) remaining_due: i64,
    #[serde(rename = "lastError")]
    pub(super) last_error: String,
}

#[derive(Default, Serialize)]
pub(super) struct SalesSummary {
    #[serde(rename = "totalTransactions")]
    pub(super) total_transactions: i64,
    #[serde(rename = "successTransactions")]
    pub(super) success_transactions: i64,
    #[serde(rename = "pendingTransactions")]
    pub(super) pending_transactions: i64,
    #[serde(rename = "failedTransactions")]
    pub(super) failed_transactions: i64,
    #[serde(rename = "totalOmset")]
    pub(super) total_omset: i64,
    #[serde(rename = "totalProfit")]
    pub(super) total_profit: i64,
    #[serde(rename = "averageTransaction")]
    pub(super) average_transaction: f64,
}

pub(super) struct CategorySummary {
    pub(super) category: String,
    pub(super) count: i64,
    pub(super) omset: i64,
    pub(super) profit: i64,
}

impl Serialize for CategorySummary {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("CategorySummary", 4)?;
        state.serialize_field("count", &self.count)?;
        state.serialize_field("omset", &self.omset)?;
        state.serialize_field("profit", &self.profit)?;
        state.serialize_field("category", &self.category)?;
        state.end()
    }
}

pub(super) struct DailySummary {
    pub(super) date: String,
    pub(super) count: i64,
    pub(super) omset: i64,
    pub(super) profit: i64,
}

impl Serialize for DailySummary {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("DailySummary", 4)?;
        state.serialize_field("count", &self.count)?;
        state.serialize_field("omset", &self.omset)?;
        state.serialize_field("profit", &self.profit)?;
        state.serialize_field("date", &self.date)?;
        state.end()
    }
}

pub(super) struct RecentTransaction {
    pub(super) id: String,
    pub(super) product: String,
    pub(super) category: String,
    pub(super) user: String,
    pub(super) target: String,
    pub(super) amount: i64,
    pub(super) status: String,
    pub(super) created_at: String,
}

impl Serialize for RecentTransaction {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("RecentTransaction", 8)?;
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("target", &self.target)?;
        state.serialize_field("amount", &self.amount)?;
        state.serialize_field("status", &self.status)?;
        state.serialize_field("createdAt", &self.created_at)?;
        state.serialize_field("product", &self.product)?;
        state.serialize_field("category", &self.category)?;
        state.serialize_field("user", &self.user)?;
        state.end()
    }
}
