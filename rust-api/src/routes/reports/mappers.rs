use futures_util::TryStreamExt;
use mongodb::bson::Document;

use crate::utils::bson::{read_i64, read_string};

use super::types::{CategorySummary, DailySummary, RecentTransaction, SalesSummary};

pub(super) async fn first_document(
    cursor_result: mongodb::error::Result<mongodb::Cursor<Document>>,
) -> Option<Document> {
    let mut cursor = cursor_result.ok()?;
    cursor.try_next().await.ok().flatten()
}

pub(super) fn first_array_item(document: &Document, key: &str) -> Document {
    document
        .get_array(key)
        .ok()
        .and_then(|items| items.first())
        .and_then(|item| item.as_document())
        .cloned()
        .unwrap_or_default()
}

pub(super) fn document_array(document: &Document, key: &str) -> Vec<Document> {
    document
        .get_array(key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_document().cloned())
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn sales_summary_from_doc(document: Document) -> SalesSummary {
    let total_transactions = read_i64(&document, "totalTransactions");
    let success_transactions = read_i64(&document, "successTransactions");
    let total_omset = read_i64(&document, "totalOmset");

    SalesSummary {
        total_transactions,
        success_transactions,
        pending_transactions: read_i64(&document, "pendingTransactions"),
        failed_transactions: read_i64(&document, "failedTransactions"),
        total_omset,
        total_profit: read_i64(&document, "totalProfit"),
        average_transaction: if success_transactions > 0 {
            total_omset as f64 / success_transactions as f64
        } else {
            0.0
        },
    }
}

pub(super) fn category_summary_from_doc(document: Document) -> CategorySummary {
    CategorySummary {
        category: read_string(&document, "category"),
        count: read_i64(&document, "count"),
        omset: read_i64(&document, "omset"),
        profit: read_i64(&document, "profit"),
    }
}

pub(super) fn daily_summary_from_doc(document: Document) -> DailySummary {
    DailySummary {
        date: read_string(&document, "date"),
        count: read_i64(&document, "count"),
        omset: read_i64(&document, "omset"),
        profit: read_i64(&document, "profit"),
    }
}

pub(super) fn recent_transaction_from_doc(mut document: Document) -> RecentTransaction {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();

    RecentTransaction {
        id,
        product: read_string(&document, "product"),
        category: read_string(&document, "category"),
        user: read_string(&document, "user"),
        target: read_string(&document, "target"),
        amount: read_i64(&document, "amount"),
        status: read_string(&document, "status"),
        created_at: document
            .get_datetime("createdAt")
            .map(|value| {
                value
                    .try_to_rfc3339_string()
                    .unwrap_or_else(|_| value.to_string())
            })
            .unwrap_or_default(),
    }
}
