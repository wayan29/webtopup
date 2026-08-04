use mongodb::bson::oid::ObjectId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct PaymentCategoryBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) icon: String,
    pub(super) status: String,
}

#[derive(Serialize)]
pub(super) struct PaymentCategoryItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) icon: String,
    pub(super) order: i64,
    pub(super) status: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "methodCount")]
    pub(super) method_count: i64,
    #[serde(rename = "activeMethodCount")]
    pub(super) active_method_count: i64,
    #[serde(rename = "inactiveMethodCount")]
    pub(super) inactive_method_count: i64,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
    #[serde(rename = "deleteBlockedReason")]
    pub(super) delete_blocked_reason: String,
}

#[derive(Serialize)]
pub(super) struct PaymentMethodDependency {
    #[serde(rename = "depositCount")]
    pub(super) deposit_count: i64,
    #[serde(rename = "pendingDepositCount")]
    pub(super) pending_deposit_count: i64,
    #[serde(rename = "guestTransactionCount")]
    pub(super) guest_transaction_count: i64,
    #[serde(rename = "waitingPaymentCount")]
    pub(super) waiting_payment_count: i64,
    #[serde(rename = "totalUsageCount")]
    pub(super) total_usage_count: i64,
}

#[derive(Serialize)]
pub(super) struct PaymentMethodItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) category: Option<PaymentCategoryBrief>,
    #[serde(rename = "accountNumber")]
    pub(super) account_number: String,
    #[serde(rename = "accountName")]
    pub(super) account_name: String,
    pub(super) icon: String,
    #[serde(rename = "minAmount")]
    pub(super) min_amount: f64,
    #[serde(rename = "maxAmount")]
    pub(super) max_amount: f64,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: f64,
    #[serde(rename = "adminPercent")]
    pub(super) admin_percent: f64,
    #[serde(rename = "operationalStart")]
    pub(super) operational_start: String,
    #[serde(rename = "operationalEnd")]
    pub(super) operational_end: String,
    #[serde(rename = "useUniqueCode")]
    pub(super) use_unique_code: bool,
    pub(super) status: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    pub(super) dependency: PaymentMethodDependency,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
    #[serde(rename = "deleteBlockedReason")]
    pub(super) delete_blocked_reason: String,
    #[serde(rename = "isOperationalNow")]
    pub(super) is_operational_now: bool,
    #[serde(rename = "isVisibleToUsers")]
    pub(super) is_visible_to_users: bool,
    #[serde(rename = "visibilityIssues")]
    pub(super) visibility_issues: Vec<String>,
}

#[derive(Deserialize)]
pub struct ReorderPaymentCategoriesPayload {
    pub(super) orders: Option<Vec<ReorderPaymentCategoryItem>>,
}

#[derive(Deserialize)]
pub(super) struct ReorderPaymentCategoryItem {
    pub(super) id: String,
    pub(super) order: i64,
}

#[derive(Deserialize)]
pub struct PaymentCategoryPayload {
    pub(super) name: Option<String>,
    pub(super) slug: Option<String>,
    pub(super) icon: Option<String>,
    pub(super) order: Option<f64>,
    pub(super) status: Option<String>,
}

#[derive(Deserialize)]
pub struct PaymentMethodPayload {
    pub(super) name: Option<Value>,
    pub(super) category: Option<Value>,
    #[serde(rename = "accountNumber")]
    pub(super) account_number: Option<Value>,
    #[serde(rename = "accountName")]
    pub(super) account_name: Option<Value>,
    pub(super) icon: Option<Value>,
    #[serde(rename = "minAmount")]
    pub(super) min_amount: Option<Value>,
    #[serde(rename = "maxAmount")]
    pub(super) max_amount: Option<Value>,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: Option<Value>,
    #[serde(rename = "adminPercent")]
    pub(super) admin_percent: Option<Value>,
    #[serde(rename = "operationalStart")]
    pub(super) operational_start: Option<Value>,
    #[serde(rename = "operationalEnd")]
    pub(super) operational_end: Option<Value>,
    #[serde(rename = "useUniqueCode")]
    pub(super) use_unique_code: Option<Value>,
    pub(super) status: Option<Value>,
}

#[derive(Serialize)]
pub(super) struct MessageResponse {
    pub(super) message: &'static str,
}

#[derive(Serialize)]
pub(super) struct PaymentCategoryResponse {
    pub(super) message: &'static str,
    pub(super) category: Value,
}

#[derive(Serialize)]
pub(super) struct PaymentMethodResponse {
    pub(super) message: &'static str,
    pub(super) method: Value,
}

pub(super) struct ValidPaymentMethodPayload {
    pub(super) name: String,
    pub(super) category: ObjectId,
    pub(super) account_number: String,
    pub(super) account_name: String,
    pub(super) icon: String,
    pub(super) min_amount: f64,
    pub(super) max_amount: f64,
    pub(super) admin_fee: f64,
    pub(super) admin_percent: f64,
    pub(super) operational_start: String,
    pub(super) operational_end: String,
    pub(super) use_unique_code: bool,
    pub(super) status: String,
}

#[derive(Default)]
pub(super) struct MethodStats {
    pub(super) method_count: i64,
    pub(super) active_method_count: i64,
    pub(super) inactive_method_count: i64,
}

#[derive(Default)]
pub(super) struct DepositStats {
    pub(super) deposit_count: i64,
    pub(super) pending_deposit_count: i64,
}

#[derive(Default)]
pub(super) struct GuestStats {
    pub(super) guest_transaction_count: i64,
    pub(super) waiting_payment_count: i64,
}
