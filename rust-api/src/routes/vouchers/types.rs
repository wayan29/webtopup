use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct VoucherQuery {
    pub(super) page: Option<i64>,
    pub(super) limit: Option<i64>,
    pub(super) search: Option<String>,
    pub(super) status: Option<String>,
    /// balance (default) | discount | all
    pub(super) kind: Option<String>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<String>,
    #[serde(rename = "minAmount")]
    pub(super) min_amount: Option<i64>,
    #[serde(rename = "maxAmount")]
    pub(super) max_amount: Option<i64>,
}

#[derive(Deserialize)]
pub struct VoucherCreatePayload {
    pub(super) amount: Option<Value>,
    pub(super) code: Option<Value>,
    pub(super) quantity: Option<Value>,
    /// Optional campaign prefix for auto-generated codes (e.g. "PROMO-").
    pub(super) prefix: Option<Value>,
    /// "balance" (default) or "discount".
    pub(super) kind: Option<Value>,
    #[serde(rename = "discountType")]
    pub(super) discount_type: Option<Value>,
    #[serde(rename = "discountValue")]
    pub(super) discount_value: Option<Value>,
    #[serde(rename = "maxUses")]
    pub(super) max_uses: Option<Value>,
    #[serde(rename = "minPurchase")]
    pub(super) min_purchase: Option<Value>,
    #[serde(rename = "maxDiscount")]
    pub(super) max_discount: Option<Value>,
    #[serde(rename = "onePerUser")]
    pub(super) one_per_user: Option<bool>,
    #[serde(rename = "startsAt")]
    pub(super) starts_at: Option<Value>,
    #[serde(rename = "expiresAt")]
    pub(super) expires_at: Option<Value>,
    /// Optional product ObjectId list (discount scope).
    #[serde(rename = "productIds")]
    pub(super) product_ids: Option<Vec<String>>,
    /// Optional category ObjectId list (discount scope).
    #[serde(rename = "categoryIds")]
    pub(super) category_ids: Option<Vec<String>>,
    /// Optional operator ObjectId list (discount scope).
    #[serde(rename = "operatorIds")]
    pub(super) operator_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountValidatePayload {
    pub code: Option<String>,
    pub amount: Option<i64>,
    pub product_id: Option<String>,
    pub category_id: Option<String>,
    pub operator_id: Option<String>,
}

#[derive(Deserialize)]
pub struct VoucherArchivePayload {
    pub(super) reason: Option<Value>,
}

#[derive(Deserialize)]
pub struct VoucherRedeemPayload {
    pub(super) code: Option<Value>,
}

#[derive(Clone, Serialize)]
pub(super) struct UserBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) email: String,
    pub(super) name: String,
    pub(super) role: String,
}

#[derive(Serialize)]
pub(super) struct VoucherItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) code: String,
    /// balance top-up amount, or 0 for discount vouchers.
    pub(super) amount: i64,
    pub(super) kind: String,
    #[serde(rename = "discountType", skip_serializing_if = "Option::is_none")]
    pub(super) discount_type: Option<String>,
    #[serde(rename = "discountValue", skip_serializing_if = "Option::is_none")]
    pub(super) discount_value: Option<i64>,
    #[serde(rename = "maxUses", skip_serializing_if = "Option::is_none")]
    pub(super) max_uses: Option<i64>,
    #[serde(rename = "usedCount", skip_serializing_if = "Option::is_none")]
    pub(super) used_count: Option<i64>,
    #[serde(rename = "minPurchase", skip_serializing_if = "Option::is_none")]
    pub(super) min_purchase: Option<i64>,
    #[serde(rename = "maxDiscount", skip_serializing_if = "Option::is_none")]
    pub(super) max_discount: Option<i64>,
    #[serde(rename = "onePerUser", skip_serializing_if = "Option::is_none")]
    pub(super) one_per_user: Option<bool>,
    #[serde(rename = "productIds", skip_serializing_if = "Option::is_none")]
    pub(super) product_ids: Option<Vec<String>>,
    #[serde(rename = "categoryIds", skip_serializing_if = "Option::is_none")]
    pub(super) category_ids: Option<Vec<String>>,
    #[serde(rename = "operatorIds", skip_serializing_if = "Option::is_none")]
    pub(super) operator_ids: Option<Vec<String>>,
    #[serde(rename = "startsAt", skip_serializing_if = "Option::is_none")]
    pub(super) starts_at: Option<String>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub(super) expires_at: Option<String>,
    #[serde(rename = "isRedeemed")]
    pub(super) is_redeemed: bool,
    #[serde(rename = "isArchived")]
    pub(super) is_archived: bool,
    #[serde(rename = "redeemedAt", skip_serializing_if = "Option::is_none")]
    pub(super) redeemed_at: Option<String>,
    #[serde(
        rename = "redeemedBalanceBefore",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) redeemed_balance_before: Option<i64>,
    #[serde(
        rename = "redeemedBalanceAfter",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) redeemed_balance_after: Option<i64>,
    #[serde(rename = "archiveReason", skip_serializing_if = "Option::is_none")]
    pub(super) archive_reason: Option<String>,
    #[serde(rename = "archivedAt", skip_serializing_if = "Option::is_none")]
    pub(super) archived_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub(super) updated_at: Option<String>,
    #[serde(rename = "__v", skip_serializing_if = "Option::is_none")]
    pub(super) version: Option<i64>,
    #[serde(rename = "redeemedBy", skip_serializing_if = "Option::is_none")]
    pub(super) redeemed_by: Option<UserBrief>,
    #[serde(rename = "createdBy", skip_serializing_if = "Option::is_none")]
    pub(super) created_by: Option<UserBrief>,
    #[serde(rename = "archivedBy", skip_serializing_if = "Option::is_none")]
    pub(super) archived_by: Option<UserBrief>,
}

#[derive(Serialize)]
pub(super) struct VoucherMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Default, Serialize)]
pub(super) struct VoucherSummary {
    pub(super) total: i64,
    #[serde(rename = "totalAmount")]
    pub(super) total_amount: i64,
    pub(super) available: i64,
    pub(super) redeemed: i64,
    pub(super) archived: i64,
}

#[derive(Serialize)]
pub(super) struct VoucherResponse {
    pub(super) items: Vec<VoucherItem>,
    pub(super) meta: VoucherMeta,
    pub(super) summary: VoucherSummary,
}

#[derive(Serialize)]
pub(super) struct VoucherCreateResponse {
    pub(super) message: String,
    pub(super) items: Vec<VoucherItem>,
    #[serde(rename = "createdCount")]
    pub(super) created_count: i64,
}

#[derive(Serialize)]
pub(super) struct VoucherActionResponse {
    pub(super) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) archived: Option<bool>,
}

#[derive(Serialize)]
pub(super) struct VoucherRedeemResponse {
    pub(super) message: &'static str,
    pub(super) code: String,
    pub(super) amount: i64,
    #[serde(rename = "newBalance")]
    pub(super) new_balance: i64,
}
