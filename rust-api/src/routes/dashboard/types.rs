use serde::Serialize;

use crate::security::ProxyContextResponse;

#[derive(Serialize)]
pub struct OpsSnapshotResponse {
    pub ok: bool,
    pub service: &'static str,
    pub api_prefix: &'static str,
    pub generated_at: String,
    pub source: &'static str,
    pub user: Option<ProxyContextResponse>,
    pub transactions_today: TransactionTodaySummary,
    pub deposits: DepositOpsSummary,
    pub vendors: VendorOpsSummary,
    pub stuck: StuckOpsSummary,
}

#[derive(Default, Serialize)]
pub struct TransactionTodaySummary {
    pub total: i64,
    pub success: i64,
    pub pending: i64,
    pub failed: i64,
    pub omset: i64,
    pub success_rate: i64,
}

#[derive(Default, Serialize)]
pub struct DepositOpsSummary {
    pub pending: i64,
    pub pending_amount_total: i64,
    pub pending_transfer_total: i64,
}

#[derive(Default, Serialize)]
pub struct VendorOpsSummary {
    pub total: i64,
    pub active: i64,
    pub inactive: i64,
    pub low_balance_configured: i64,
}

#[derive(Default, Serialize)]
pub struct StuckOpsSummary {
    pub threshold_minutes: i64,
    pub total: i64,
}
