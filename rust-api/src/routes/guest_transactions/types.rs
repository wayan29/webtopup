use mongodb::bson::oid::ObjectId;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct GuestTransactionsQuery {
    pub(super) page: Option<String>,
    pub(super) limit: Option<String>,
    pub(super) search: Option<String>,
    #[serde(rename = "paymentStatus")]
    pub(super) payment_status: Option<String>,
    #[serde(rename = "transactionStatus")]
    pub(super) transaction_status: Option<String>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<String>,
    pub(super) scope: Option<String>,
}

#[derive(Deserialize)]
pub struct CheckGuestTransactionQuery {
    pub(super) whatsapp: Option<String>,
}

#[derive(Deserialize)]
pub struct GuestCancelPayload {
    pub(super) note: Option<String>,
}

#[derive(Deserialize)]
pub struct GuestConfirmPayload {
    pub(super) note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestCreatePayload {
    pub(super) product_code: Option<String>,
    pub(super) target: Option<String>,
    pub(super) server_id: Option<String>,
    pub(super) whatsapp: Option<String>,
    pub(super) email: Option<String>,
    pub(super) payment_method_id: Option<String>,
    pub(super) use_flash_sale: Option<bool>,
    pub(super) voucher_code: Option<String>,
}

#[derive(Deserialize)]
pub struct GuestStatusPayload {
    #[serde(rename = "transactionStatus")]
    pub(super) transaction_status: String,
    pub(super) note: Option<String>,
    #[serde(rename = "vendorTrxId")]
    pub(super) vendor_trx_id: Option<String>,
    pub(super) sn: Option<String>,
}

#[derive(Serialize)]
pub(super) struct GuestTransactionsResponse {
    pub(super) items: Vec<GuestTransactionItem>,
    pub(super) meta: GuestTransactionsMeta,
    pub(super) summary: GuestTransactionsSummary,
}

#[derive(Serialize)]
pub(super) struct GuestMutationResponse {
    pub(super) message: &'static str,
    pub(super) transaction: GuestTransactionItem,
}

#[derive(Serialize)]
pub(super) struct GuestTransactionsMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Default, Serialize)]
pub(super) struct GuestTransactionsSummary {
    pub(super) total: i64,
    #[serde(rename = "amountTotal")]
    pub(super) amount_total: i64,
    #[serde(rename = "waitingPayment")]
    pub(super) waiting_payment: i64,
    pub(super) paid: i64,
    pub(super) expired: i64,
    pub(super) cancelled: i64,
    pub(super) processing: i64,
    pub(super) success: i64,
    pub(super) failed: i64,
}

#[derive(Serialize)]
pub(super) struct GuestTransactionItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "invoiceNumber")]
    pub(super) invoice_number: String,
    pub(super) target: String,
    pub(super) whatsapp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
    pub(super) amount: i64,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: i64,
    #[serde(rename = "uniqueCode")]
    pub(super) unique_code: i64,
    #[serde(rename = "totalAmount")]
    pub(super) total_amount: i64,
    #[serde(rename = "paymentStatus")]
    pub(super) payment_status: String,
    #[serde(rename = "transactionStatus")]
    pub(super) transaction_status: String,
    #[serde(rename = "vendorTrxId", skip_serializing_if = "Option::is_none")]
    pub(super) vendor_trx_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) sn: Option<String>,
    #[serde(rename = "paidAt", skip_serializing_if = "Option::is_none")]
    pub(super) paid_at: Option<String>,
    #[serde(rename = "expiredAt")]
    pub(super) expired_at: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "statusUpdatedAt", skip_serializing_if = "Option::is_none")]
    pub(super) status_updated_at: Option<String>,
    #[serde(rename = "statusUpdateNote", skip_serializing_if = "Option::is_none")]
    pub(super) status_update_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) product: Option<ProductBrief>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user: Option<UserBrief>,
    #[serde(rename = "paymentMethod", skip_serializing_if = "Option::is_none")]
    pub(super) payment_method: Option<PaymentMethodBrief>,
    #[serde(rename = "statusUpdatedBy", skip_serializing_if = "Option::is_none")]
    pub(super) status_updated_by: Option<UserBrief>,
}

#[derive(Serialize)]
pub(super) struct ProductBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) category: String,
    pub(super) brand: String,
    #[serde(rename = "vendorName", skip_serializing_if = "Option::is_none")]
    pub(super) vendor_name: Option<String>,
}

#[derive(Serialize)]
pub(super) struct UserBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) role: Option<String>,
}

#[derive(Serialize)]
pub(super) struct PaymentMethodBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    #[serde(rename = "categoryName", skip_serializing_if = "Option::is_none")]
    pub(super) category_name: Option<String>,
    #[serde(rename = "accountName", skip_serializing_if = "Option::is_none")]
    pub(super) account_name: Option<String>,
    #[serde(rename = "accountNumber", skip_serializing_if = "Option::is_none")]
    pub(super) account_number: Option<String>,
}

#[derive(Serialize, serde::Deserialize)]
pub(super) struct GuestTransactionCheckItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "invoiceNumber")]
    pub(super) invoice_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user: Option<String>,
    pub(super) product: ProductCheckBrief,
    pub(super) target: String,
    #[serde(rename = "serverId", skip_serializing_if = "Option::is_none")]
    pub(super) server_id: Option<String>,
    pub(super) whatsapp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
    pub(super) amount: i64,
    #[serde(rename = "adminFee")]
    pub(super) admin_fee: i64,
    #[serde(rename = "uniqueCode")]
    pub(super) unique_code: i64,
    #[serde(rename = "totalAmount")]
    pub(super) total_amount: i64,
    #[serde(rename = "paymentMethod")]
    pub(super) payment_method: PaymentMethodCheckBrief,
    #[serde(rename = "paymentStatus")]
    pub(super) payment_status: String,
    #[serde(rename = "transactionStatus")]
    pub(super) transaction_status: String,
    #[serde(rename = "expiredAt")]
    pub(super) expired_at: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "__v", skip_serializing_if = "Option::is_none")]
    pub(super) version: Option<i64>,
    #[serde(rename = "paidAt", skip_serializing_if = "Option::is_none")]
    pub(super) paid_at: Option<String>,
    #[serde(rename = "vendorTrxId", skip_serializing_if = "Option::is_none")]
    pub(super) vendor_trx_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) sn: Option<String>,
    #[serde(rename = "statusUpdateNote", skip_serializing_if = "Option::is_none")]
    pub(super) status_update_note: Option<String>,
    #[serde(rename = "statusUpdatedAt", skip_serializing_if = "Option::is_none")]
    pub(super) status_updated_at: Option<String>,
    #[serde(rename = "statusUpdatedBy", skip_serializing_if = "Option::is_none")]
    pub(super) status_updated_by: Option<String>,
}

#[derive(Serialize, serde::Deserialize)]
pub(super) struct ProductCheckBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) code: String,
    pub(super) name: String,
}

#[derive(Serialize, serde::Deserialize)]
pub(super) struct PaymentMethodCheckBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) category: Option<String>,
    #[serde(rename = "accountNumber", skip_serializing_if = "Option::is_none")]
    pub(super) account_number: Option<String>,
    #[serde(rename = "accountName", skip_serializing_if = "Option::is_none")]
    pub(super) account_name: Option<String>,
}

pub(super) struct FlashSaleReservation {
    pub(super) flash_sale_id: ObjectId,
    pub(super) product_id: ObjectId,
    pub(super) price: i64,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GuestCreateResponse {
    pub(super) message: &'static str,
    pub(super) transaction: GuestTransactionCheckItem,
    pub(super) payment_info: GuestPaymentInfo,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GuestPaymentInfo {
    pub(super) bank_name: String,
    pub(super) account_number: String,
    pub(super) account_name: String,
    pub(super) amount: i64,
    pub(super) admin_fee: i64,
    pub(super) unique_code: i64,
    pub(super) total_amount: i64,
    pub(super) expired_at: String,
}

#[derive(Serialize)]
pub(super) struct OwnedErrorResponse {
    pub(super) message: String,
}
