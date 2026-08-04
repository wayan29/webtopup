use serde::{ser::SerializeStruct, Deserialize, Serialize};
use serde_json::Value;

use crate::security::ProxyContextResponse;

#[derive(Deserialize)]
pub struct AdminDepositsQuery {
    pub(super) page: Option<String>,
    pub(super) limit: Option<String>,
    #[serde(rename = "invoiceId")]
    pub(super) invoice_id: Option<String>,
    #[serde(rename = "userQuery")]
    pub(super) user_query: Option<String>,
    #[serde(rename = "totalTransfer")]
    pub(super) total_transfer: Option<String>,
    pub(super) status: Option<String>,
    pub(super) assignment: Option<String>,
}

#[derive(Deserialize)]
pub struct RequestDepositPayload {
    pub(super) amount: Option<Value>,
    #[serde(rename = "paymentMethodId")]
    pub(super) payment_method_id: Option<String>,
}

#[derive(Serialize)]
pub(super) struct AdminDepositsResponse {
    pub(super) items: Vec<AdminDepositItem>,
    pub(super) meta: AdminDepositsMeta,
    pub(super) summary: AdminDepositsSummary,
}

#[derive(Serialize)]
pub(super) struct DepositAssignmentResponse {
    pub(super) message: &'static str,
    pub(super) deposit: AdminDepositItem,
}

#[derive(Serialize)]
pub(super) struct DepositApprovalResponse {
    pub(super) message: &'static str,
    pub(super) deposit: AdminDepositItem,
    #[serde(rename = "adminFeeDeducted")]
    pub(super) admin_fee_deducted: i64,
    #[serde(rename = "netAmountAdded")]
    pub(super) net_amount_added: i64,
    #[serde(rename = "newBalance")]
    pub(super) new_balance: i64,
}

#[derive(Serialize)]
pub(super) struct DepositRequestResponse {
    pub(super) message: &'static str,
    pub(super) deposit: MemberDepositItem,
    #[serde(rename = "paymentInfo")]
    pub(super) payment_info: DepositPaymentInfo,
}

#[derive(Serialize)]
pub(super) struct DepositPaymentInfo {
    #[serde(rename = "bankName")]
    pub(super) bank_name: String,
    #[serde(rename = "accountNumber")]
    pub(super) account_number: String,
    #[serde(rename = "accountName")]
    pub(super) account_name: String,
    pub(super) amount: i64,
    #[serde(rename = "uniqueCode")]
    pub(super) unique_code: i64,
    #[serde(rename = "totalAmount")]
    pub(super) total_amount: i64,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: i64,
    #[serde(rename = "netAmount")]
    pub(super) net_amount: i64,
    #[serde(rename = "adminFeeBreakdown")]
    pub(super) admin_fee_breakdown: DepositFeeBreakdown,
}

#[derive(Serialize)]
pub(super) struct DepositFeeBreakdown {
    #[serde(rename = "paymentMethodFee")]
    pub(super) payment_method_fee: i64,
    #[serde(rename = "globalFee")]
    pub(super) global_fee: i64,
}

#[derive(Deserialize)]
pub struct DepositProcessingPayload {
    pub(super) note: Option<String>,
}

#[derive(Serialize)]
pub(super) struct AdminDepositsMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Default, Serialize)]
pub(super) struct AdminDepositsSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    pub(super) approved: i64,
    pub(super) rejected: i64,
}

pub(super) struct AdminDepositItem {
    pub(super) id: String,
    pub(super) amount: i64,
    pub(super) unique_code: i64,
    pub(super) admin_fee: i64,
    pub(super) total_amount: i64,
    pub(super) net_amount: i64,
    pub(super) status: String,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) assigned_at: Option<String>,
    pub(super) processed_at: Option<String>,
    pub(super) processing_note: String,
    pub(super) invoice_code: String,
    pub(super) user: UserBrief,
    pub(super) payment_method: PaymentMethodBrief,
    pub(super) assigned_to: UserBrief,
    pub(super) processed_by: UserBrief,
}

impl Serialize for AdminDepositItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("AdminDepositItem", 15)?;
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("user", &self.user)?;
        state.serialize_field("amount", &self.amount)?;
        state.serialize_field("paymentMethod", &self.payment_method)?;
        state.serialize_field("status", &self.status)?;
        state.serialize_field("createdAt", &self.created_at)?;
        state.serialize_field("updatedAt", &self.updated_at)?;
        if let Some(assigned_at) = &self.assigned_at {
            state.serialize_field("assignedAt", assigned_at)?;
        }
        if let Some(processed_at) = &self.processed_at {
            state.serialize_field("processedAt", processed_at)?;
        }
        state.serialize_field("invoiceCode", &self.invoice_code)?;
        state.serialize_field("netAmount", &self.net_amount)?;
        state.serialize_field("uniqueCode", &self.unique_code)?;
        state.serialize_field("adminFee", &self.admin_fee)?;
        state.serialize_field("totalAmount", &self.total_amount)?;
        state.serialize_field("processingNote", &self.processing_note)?;
        state.serialize_field("assignedTo", &self.assigned_to)?;
        state.serialize_field("processedBy", &self.processed_by)?;
        state.end()
    }
}

#[derive(Default)]
pub(super) struct UserBrief {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) role: Option<String>,
}

impl Serialize for UserBrief {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if self.id.is_empty() {
            return serializer.serialize_struct("UserBrief", 0)?.end();
        }

        let mut len = 3;
        if self.role.is_some() {
            len += 1;
        }
        let mut state = serializer.serialize_struct("UserBrief", len)?;
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("email", &self.email)?;
        if let Some(role) = &self.role {
            state.serialize_field("role", role)?;
        }
        state.end()
    }
}

#[derive(Clone, Default, Serialize)]
pub(super) struct PaymentMethodBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    #[serde(rename = "accountNumber")]
    pub(super) account_number: String,
    #[serde(rename = "accountName")]
    pub(super) account_name: String,
}

#[derive(Serialize)]
pub(super) struct DepositQueueSnapshotResponse {
    pub(super) ok: bool,
    pub(super) service: &'static str,
    pub(super) api_prefix: &'static str,
    pub(super) generated_at: String,
    pub(super) user: Option<ProxyContextResponse>,
    pub(super) summary: DepositQueueSummary,
    pub(super) latest: Vec<DepositQueueItem>,
}

#[derive(Default, Serialize)]
pub(super) struct DepositQueueSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    pub(super) approved: i64,
    pub(super) rejected: i64,
    pub(super) unassigned: i64,
    pub(super) mine: i64,
    pub(super) locked: i64,
    pub(super) pending_amount_total: i64,
    pub(super) pending_transfer_total: i64,
}

#[derive(Serialize)]
pub(super) struct DepositQueueItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) invoice: String,
    pub(super) status: String,
    pub(super) amount: i64,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: i64,
    #[serde(rename = "totalAmount")]
    pub(super) total_amount: i64,
    #[serde(rename = "assignedTo")]
    pub(super) assigned_to: Option<String>,
    #[serde(rename = "assignedAt")]
    pub(super) assigned_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
}

pub(super) struct MemberDepositItem {
    pub(super) admin_fee_before_id: Option<i64>,
    pub(super) id: String,
    pub(super) user: MemberUserBrief,
    pub(super) amount: i64,
    pub(super) unique_code: i64,
    pub(super) admin_fee_before_total: Option<i64>,
    pub(super) admin_fee_after_version: Option<i64>,
    pub(super) total_amount: i64,
    pub(super) payment_method: PaymentMethodBrief,
    pub(super) status: String,
    pub(super) proof: Option<String>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) version: i64,
}

impl Serialize for MemberDepositItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut len = 10;
        if self.admin_fee_before_total.is_some() || self.admin_fee_after_version.is_some() {
            len += 1;
        }
        if self.admin_fee_before_id.is_some() {
            len += 1;
        }
        if self.proof.is_some() {
            len += 1;
        }
        let mut state = serializer.serialize_struct("MemberDepositItem", len)?;
        if let Some(admin_fee) = self.admin_fee_before_id {
            state.serialize_field("adminFee", &admin_fee)?;
        }
        state.serialize_field("_id", &self.id)?;
        state.serialize_field("user", &self.user)?;
        state.serialize_field("amount", &self.amount)?;
        state.serialize_field("uniqueCode", &self.unique_code)?;
        if let Some(admin_fee) = self.admin_fee_before_total {
            state.serialize_field("adminFee", &admin_fee)?;
        }
        state.serialize_field("totalAmount", &self.total_amount)?;
        state.serialize_field("paymentMethod", &self.payment_method)?;
        state.serialize_field("status", &self.status)?;
        if let Some(proof) = &self.proof {
            state.serialize_field("proof", proof)?;
        }
        state.serialize_field("createdAt", &self.created_at)?;
        state.serialize_field("updatedAt", &self.updated_at)?;
        state.serialize_field("__v", &self.version)?;
        if let Some(admin_fee) = self.admin_fee_after_version {
            state.serialize_field("adminFee", &admin_fee)?;
        }
        state.end()
    }
}

#[derive(Clone, Default, Serialize)]
pub(super) struct MemberUserBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) email: String,
    pub(super) name: String,
}
