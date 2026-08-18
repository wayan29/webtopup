use serde::{ser::SerializeStruct, Deserialize, Serialize};
use serde_json::Value;

use crate::security::ProxyContextResponse;

#[derive(Serialize)]
pub(super) struct DigiflazzSettingsResponse {
    pub(super) configured: bool,
    #[serde(rename = "vendorId")]
    pub(super) vendor_id: Option<String>,
    pub(super) username: String,
    #[serde(rename = "apiKey")]
    pub(super) api_key: String,
    pub(super) status: bool,
}

#[derive(Deserialize)]
pub struct DigiflazzSettingsPayload {
    pub(super) username: Option<String>,
    #[serde(rename = "apiKey")]
    pub(super) api_key: Option<String>,
}

#[derive(Serialize)]
pub(super) struct TokovoucherSettingsResponse {
    pub(super) configured: bool,
    #[serde(rename = "vendorId")]
    pub(super) vendor_id: Option<String>,
    #[serde(rename = "memberCode")]
    pub(super) member_code: String,
    pub(super) secret: String,
    pub(super) status: bool,
}

#[derive(Deserialize)]
pub struct TokovoucherSettingsPayload {
    #[serde(rename = "memberCode")]
    pub(super) member_code: Option<String>,
    pub(super) secret: Option<String>,
}

pub(super) struct VendorBalanceResponse {
    pub(super) provider_field: &'static str,
    pub(super) provider_value: String,
    pub(super) balance: Value,
}

impl Serialize for VendorBalanceResponse {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("VendorBalanceResponse", 3)?;
        state.serialize_field("success", &true)?;
        state.serialize_field("balance", &self.balance)?;
        state.serialize_field(self.provider_field, &self.provider_value)?;
        state.end()
    }
}

pub(super) struct VendorBalanceErrorResponse {
    pub(super) message: String,
    pub(super) balance: i64,
}

impl Serialize for VendorBalanceErrorResponse {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("VendorBalanceErrorResponse", 2)?;
        state.serialize_field("message", &self.message)?;
        state.serialize_field("balance", &self.balance)?;
        state.end()
    }
}

pub(super) struct VendorItem {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) api_base_url: String,
    pub(super) config: serde_json::Value,
    pub(super) low_balance_threshold: i64,
    pub(super) status: bool,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) version: i64,
    pub(super) slug: Option<String>,
}

#[derive(Deserialize)]
pub struct VendorPayload {
    pub(super) name: Option<String>,
    #[serde(rename = "apiBaseUrl")]
    pub(super) api_base_url: Option<String>,
    pub(super) config: Option<Value>,
    #[serde(rename = "lowBalanceThreshold")]
    pub(super) low_balance_threshold: Option<Value>,
    pub(super) status: Option<bool>,
}

impl Serialize for VendorItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut len = 9;
        if self.slug.is_some() {
            len += 1;
        }

        let mut state = serializer.serialize_struct("VendorItem", len)?;
        state.serialize_field("lowBalanceThreshold", &self.low_balance_threshold)?;
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("apiBaseUrl", &self.api_base_url)?;
        state.serialize_field("config", &self.config)?;
        state.serialize_field("status", &self.status)?;
        state.serialize_field("createdAt", &self.created_at)?;
        state.serialize_field("updatedAt", &self.updated_at)?;
        state.serialize_field("__v", &self.version)?;
        if let Some(slug) = &self.slug {
            state.serialize_field("slug", slug)?;
        }
        state.end()
    }
}

#[derive(Clone, Serialize)]
pub(super) struct VendorHealthIssue {
    pub(super) code: &'static str,
    pub(super) source: &'static str,
}

impl VendorHealthIssue {
    pub(super) const fn new(code: &'static str, source: &'static str) -> Self {
        Self { code, source }
    }
}

#[derive(Serialize)]
pub(super) struct VendorHealthSnapshotResponse {
    pub(super) ok: bool,
    pub(super) partial: bool,
    pub(super) issues: Vec<VendorHealthIssue>,
    pub(super) service: &'static str,
    pub(super) api_prefix: &'static str,
    pub(super) generated_at: String,
    pub(super) source: &'static str,
    pub(super) user: Option<ProxyContextResponse>,
    pub(super) vendors: Vec<VendorSnapshot>,
    pub(super) totals: VendorSnapshotTotals,
}

#[derive(Serialize)]
pub(super) struct VendorStatsResponse {
    #[serde(rename = "vendorName")]
    pub(super) vendor_name: String,
    #[serde(rename = "totalProducts")]
    pub(super) total_products: i64,
    #[serde(rename = "activeProducts")]
    pub(super) active_products: i64,
    pub(super) categories: Vec<String>,
    pub(super) status: bool,
}

#[derive(Serialize)]
pub(super) struct VendorSnapshot {
    pub(super) key: String,
    pub(super) label: String,
    pub(super) configured: bool,
    pub(super) active: bool,
    pub(super) low_balance_threshold: i64,
    pub(super) health: &'static str,
    pub(super) health_reason: String,
    pub(super) transactions_today: TransactionStats,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct TransactionStats {
    pub(super) total: i64,
    pub(super) success: i64,
    pub(super) failed: i64,
    pub(super) pending: i64,
    #[serde(rename = "successRate")]
    pub(super) success_rate: i64,
    #[serde(rename = "amountTotal")]
    pub(super) amount_total: i64,
}

#[derive(Default, Serialize)]
pub(super) struct VendorSnapshotTotals {
    pub(super) vendors: usize,
    pub(super) healthy: i64,
    pub(super) warning: i64,
    pub(super) critical: i64,
    pub(super) transactions_today: i64,
}

#[derive(Clone, Serialize)]
pub(super) struct VendorRealtimeHealthItem {
    pub(super) key: String,
    pub(super) label: String,
    pub(super) configured: bool,
    pub(super) active: bool,
    pub(super) balance: Value,
    #[serde(rename = "balanceOk")]
    pub(super) balance_ok: bool,
    #[serde(rename = "lowBalanceThreshold")]
    pub(super) low_balance_threshold: i64,
    #[serde(rename = "lowBalance")]
    pub(super) low_balance: bool,
    #[serde(rename = "balanceMessage")]
    pub(super) balance_message: String,
    pub(super) health: &'static str,
    #[serde(rename = "transactionsToday")]
    pub(super) transactions_today: TransactionStats,
    #[serde(rename = "webhookToday")]
    pub(super) webhook_today: WebhookStats,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct WebhookStats {
    pub(super) total: i64,
    pub(super) rejected: i64,
    pub(super) failed: i64,
    pub(super) delivered: i64,
    #[serde(rename = "lastAt")]
    pub(super) last_at: Option<String>,
    #[serde(rename = "lastStatus")]
    pub(super) last_status: String,
    #[serde(rename = "lastMessage")]
    pub(super) last_message: String,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct SellerHealthSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    pub(super) failed: i64,
    #[serde(rename = "callbackPending")]
    pub(super) callback_pending: i64,
    #[serde(rename = "callbackDelivered")]
    pub(super) callback_delivered: i64,
    pub(super) health: &'static str,
}

pub(super) struct VendorCredentials {
    pub(super) username: String,
    pub(super) secret: String,
}

pub(super) struct TokovoucherAccess {
    pub(super) credentials: VendorCredentials,
    pub(super) base_url: String,
}
