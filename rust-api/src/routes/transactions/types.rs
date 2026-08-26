use mongodb::bson::{oid::ObjectId, DateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct ManualTransactionsQuery {
    pub(super) page: Option<String>,
    pub(super) limit: Option<String>,
    pub(super) search: Option<String>,
    pub(super) status: Option<String>,
    pub(super) source: Option<String>,
    pub(super) category: Option<String>,
    pub(super) brand: Option<String>,
    pub(super) vendor: Option<String>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<String>,
    pub(super) scope: Option<String>,
}

#[derive(Serialize)]
pub(super) struct ManualTransactionsResponse {
    pub(super) items: Vec<ManualTransactionItem>,
    pub(super) meta: ManualTransactionsMeta,
    pub(super) summary: ManualTransactionsSummary,
}

#[derive(Serialize)]
pub(super) struct ManualTransactionsMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Default, Serialize)]
pub(super) struct ManualTransactionsSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    pub(super) processing: i64,
    pub(super) success: i64,
    pub(super) failed: i64,
    #[serde(rename = "amountTotal")]
    pub(super) amount_total: i64,
}

#[derive(Serialize)]
pub(super) struct ManualTransactionItem {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) amount: i64,
    pub(crate) status: String,
    #[serde(rename = "referenceId")]
    pub(crate) reference_id: String,
    #[serde(rename = "vendorTrxId")]
    pub(crate) vendor_trx_id: String,
    #[serde(rename = "customerRefId")]
    pub(crate) customer_ref_id: String,
    pub(crate) sn: String,
    pub(crate) message: String,
    pub(crate) refunded: bool,
    #[serde(rename = "refundedAt")]
    pub(crate) refunded_at: Option<String>,
    #[serde(rename = "refundReason")]
    pub(crate) refund_reason: String,
    pub(crate) source: String,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: String,
    #[serde(rename = "statusUpdatedAt")]
    pub(crate) status_updated_at: Option<String>,
    #[serde(rename = "statusUpdateNote")]
    pub(crate) status_update_note: String,
    pub(crate) user: UserBrief,
    pub(crate) product: ProductBrief,
    #[serde(rename = "statusUpdatedBy")]
    pub(crate) status_updated_by: UserBrief,
    #[serde(rename = "discountVoucherCode", skip_serializing_if = "Option::is_none")]
    pub(crate) discount_voucher_code: Option<String>,
    #[serde(rename = "discountAmount", skip_serializing_if = "Option::is_none")]
    pub(crate) discount_amount: Option<i64>,
    #[serde(rename = "baseAmount", skip_serializing_if = "Option::is_none")]
    pub(crate) base_amount: Option<i64>,
    #[serde(rename = "flashSale", skip_serializing_if = "Option::is_none")]
    pub(crate) flash_sale: Option<String>,
}

#[derive(Default, Serialize)]
pub(crate) struct UserBrief {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
}

#[derive(Default, Serialize)]
pub(crate) struct ProductBrief {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) code: String,
    pub(crate) category: String,
    pub(crate) brand: String,
    #[serde(rename = "vendorName")]
    pub(crate) vendor_name: String,
}

#[derive(Deserialize)]
pub struct RefundPayload {
    pub(super) reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdatePayload {
    pub(super) status: Option<String>,
    pub(super) vendor_trx_id: Option<String>,
    pub(super) sn: Option<String>,
    pub(super) note: Option<String>,
    pub(super) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTransactionPayload {
    pub(super) product_id: Option<String>,
    pub(super) product_code: Option<String>,
    pub(super) target: Option<String>,
    pub(super) server_id: Option<String>,
    pub(super) use_flash_sale: Option<bool>,
    /// Optional checkout discount voucher code (kind=discount).
    pub(super) voucher_code: Option<String>,
    pub(super) turnstile_token: Option<String>,
}

#[derive(Serialize)]
pub(super) struct RefundResponse {
    pub(super) message: &'static str,
    pub(super) transaction: ManualTransactionItem,
}

#[derive(Serialize)]
pub(super) struct StatusUpdateResponse {
    pub(super) message: &'static str,
    pub(super) transaction: ManualTransactionItem,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateTransactionResponse {
    pub(super) message: &'static str,
    pub(super) transaction: Value,
    pub(super) remaining_balance: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecheckResponse {
    pub(super) changed: bool,
    pub(super) status: String,
    pub(super) message: String,
    pub(super) vendor_message: String,
    pub(super) transaction: Option<ManualTransactionItem>,
}

pub(super) struct VendorStatusResult {
    pub(super) status: String,
    pub(super) message: String,
    pub(super) sn: Option<String>,
}

pub(crate) struct VendorTopUpResult {
    pub(crate) status: String,
    pub(crate) vendor_trx_id: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) sn: Option<String>,
}

pub(crate) struct RecheckProduct {
    pub(crate) code: String,
    pub(crate) vendor_name: String,
    pub(crate) vendor_sku: String,
}

pub(super) struct FlashSaleReservation {
    pub(super) flash_sale_id: ObjectId,
    pub(super) product_id: ObjectId,
    pub(super) price: i64,
}

pub(super) struct TransactionRefundSnapshot {
    pub(super) status: String,
    pub(super) updated_at: DateTime,
    pub(super) refunded: bool,
    pub(super) refunded_by: Option<ObjectId>,
    pub(super) refunded_at: Option<DateTime>,
    pub(super) refund_reason: Option<String>,
    pub(super) status_updated_by: Option<ObjectId>,
    pub(super) status_updated_at: Option<DateTime>,
    pub(super) status_update_note: Option<String>,
}

pub(super) struct StatusPayload {
    pub(super) status: String,
    pub(super) vendor_trx_id: Option<String>,
    pub(super) sn: Option<String>,
    pub(super) note: String,
}

pub(super) struct TransitionPlan {
    pub(super) balance_delta: i64,
    pub(super) should_award_points: bool,
    pub(super) should_revoke_points: bool,
    pub(super) next_refunded: bool,
}

pub(super) struct TransactionStatusSnapshot {
    pub(super) status: String,
    pub(super) updated_at: DateTime,
    pub(super) refunded: bool,
    pub(super) vendor_trx_id: Option<String>,
    pub(super) sn: Option<String>,
    pub(super) status_updated_by: Option<ObjectId>,
    pub(super) status_updated_at: Option<DateTime>,
    pub(super) status_update_note: Option<String>,
}

#[derive(Deserialize)]
pub struct StuckTransactionsQuery {
    #[serde(rename = "thresholdMinutes")]
    pub(super) threshold_minutes: Option<String>,
    pub(super) limit: Option<String>,
}

#[derive(Serialize)]
pub(super) struct StuckTransactionsResponse {
    #[serde(rename = "thresholdMinutes")]
    pub(super) threshold_minutes: i64,
    pub(super) total: u64,
    pub(super) items: Vec<StuckTransactionItem>,
}

#[derive(Serialize)]
pub(crate) struct StuckTransactionItem {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) target: String,
    pub(crate) amount: i64,
    pub(crate) status: String,
    #[serde(rename = "referenceId")]
    pub(crate) reference_id: String,
    #[serde(rename = "vendorTrxId")]
    pub(crate) vendor_trx_id: String,
    #[serde(rename = "customerRefId")]
    pub(crate) customer_ref_id: String,
    pub(crate) source: String,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: String,
    #[serde(rename = "ageMinutes")]
    pub(crate) age_minutes: i64,
    pub(crate) user: Option<StuckTransactionUser>,
    pub(crate) product: Option<StuckTransactionProduct>,
}

#[derive(Serialize)]
pub(crate) struct StuckTransactionUser {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) email: String,
}

#[derive(Serialize)]
pub(crate) struct StuckTransactionProduct {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) code: String,
    pub(crate) category: String,
    pub(crate) brand: String,
    pub(crate) vendor: String,
}
