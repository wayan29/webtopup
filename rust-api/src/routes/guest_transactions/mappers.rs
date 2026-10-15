use sqlx::Row;

use super::{GuestTransactionItem, PaymentMethodBrief, ProductBrief, UserBrief};

pub(super) fn guest_transaction_item_from_row(row: sqlx::postgres::PgRow) -> GuestTransactionItem {
    GuestTransactionItem {
        id: row.get::<uuid::Uuid, _>("id").to_string(), invoice_number: row.get("invoice_number"),
        target: row.get("target"), whatsapp: row.get("whatsapp"), email: row.get("email"),
        amount: row.get("amount"), admin_fee: row.get("admin_fee"), unique_code: row.get("unique_code"), total_amount: row.get("total_amount"),
        payment_status: row.get("payment_status"), transaction_status: row.get("transaction_status"), vendor_trx_id: row.get("vendor_trx_id"), sn: row.get("sn"),
        paid_at: row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("paid_at").map(|v| v.to_rfc3339()),
        expired_at: row.get::<chrono::DateTime<chrono::Utc>, _>("expired_at").to_rfc3339(),
        created_at: row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(), updated_at: row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at").to_rfc3339(),
        status_updated_at: row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at").map(|v| v.to_rfc3339()), status_update_note: row.get("status_update_note"),
        product: Some(ProductBrief { id:row.get::<uuid::Uuid,_>("product_id").to_string(), name:row.get("product_name"), code:row.get("product_code"), category:row.get("product_category"), brand:row.get("product_brand"), vendor_name:row.get("vendor_name") }),
        user: row.get::<Option<uuid::Uuid>,_>("user_id").map(|id| UserBrief { id:id.to_string(), name:row.get::<Option<String>,_>("user_name").unwrap_or_default(), email:row.get::<Option<String>,_>("user_email").unwrap_or_default(), role:None }),
        payment_method: Some(PaymentMethodBrief { id:row.get::<uuid::Uuid,_>("payment_method_id").to_string(), name:row.get("payment_method_name"), category_name:row.get("payment_category_name"), account_name:row.get("account_name"), account_number:row.get("account_number") }),
        status_updated_by: None,
    }
}

