use mongodb::bson::{DateTime, Document};

use crate::utils::bson::{read_i64, read_string};

use super::{StuckTransactionItem, StuckTransactionProduct, StuckTransactionUser};

pub(super) fn stuck_transaction_item_from_doc(
    mut document: Document,
    cutoff_ms: i64,
    threshold_minutes: i64,
) -> StuckTransactionItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let created_at = document
        .get_datetime("createdAt")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let updated_at = document
        .get_datetime("updatedAt")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let age_minutes = document
        .get_datetime("updatedAt")
        .map(|value| {
            ((DateTime::now().timestamp_millis() - value.timestamp_millis()) / 60_000).max(0)
        })
        .unwrap_or_else(|_| {
            threshold_minutes.max((DateTime::now().timestamp_millis() - cutoff_ms) / 60_000)
        });

    StuckTransactionItem {
        id,
        target: read_string(&document, "target"),
        amount: read_i64(&document, "amount"),
        status: read_string(&document, "status"),
        reference_id: read_string(&document, "referenceId"),
        vendor_trx_id: read_string(&document, "vendorTrxId"),
        customer_ref_id: read_string(&document, "customerRefId"),
        source: read_string(&document, "source").if_empty_then(|| "web".to_string()),
        created_at,
        updated_at,
        age_minutes,
        user: document.get_document("user").ok().map(user_from_doc),
        product: document.get_document("product").ok().map(product_from_doc),
    }
}

fn user_from_doc(document: &Document) -> StuckTransactionUser {
    StuckTransactionUser {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(document, "name"),
        email: read_string(document, "email"),
    }
}

fn product_from_doc(document: &Document) -> StuckTransactionProduct {
    StuckTransactionProduct {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(document, "name"),
        code: read_string(document, "code"),
        category: read_string(document, "category"),
        brand: read_string(document, "brand"),
        vendor: read_string(document, "vendor"),
    }
}

trait EmptyStringFallback {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}
