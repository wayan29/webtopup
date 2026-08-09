use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, DateTime, Document};
use serde::Serialize;
use std::sync::Arc;

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::read_i64,
};

use super::types::SalesSummaryQuery;
use super::dates::build_date_match;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromoReportResponse {
    ok: bool,
    range: PromoRange,
    balance_vouchers_redeemed: PromoCountAmount,
    discount_vouchers_applied: PromoCountAmount,
    giveaways: PromoCountAmount,
    flash_sales_live: i64,
    idle_balance_vouchers: i64,
    open_discount_vouchers: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromoRange {
    start: Option<String>,
    end: Option<String>,
}

#[derive(Default, Serialize)]
struct PromoCountAmount {
    count: i64,
    amount: i64,
}

pub async fn promo_summary(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SalesSummaryQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };
    let db = client.database(&state.mongo_db);
    let date_match = match build_date_match(&query) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let mut balance_redeemed_filter = doc! {
        "isRedeemed": true,
        "$or": [
            { "kind": "balance" },
            { "kind": { "$exists": false } },
        ],
    };
    let mut discount_applied_filter = doc! {
        "kind": "discount",
        "usedCount": { "$gt": 0 },
    };
    let mut giveaway_filter = Document::new();
    if !date_match.is_empty() {
        // date_match is typically { createdAt: { $gte, $lte } }
        if let Some(created) = date_match.get("createdAt") {
            balance_redeemed_filter.insert("redeemedAt", created.clone());
            discount_applied_filter.insert("updatedAt", created.clone());
            giveaway_filter.insert("createdAt", created.clone());
        }
    }

    let vouchers = db.collection::<Document>("vouchers");
    let balance_vouchers_redeemed = sum_count_amount(
        &vouchers,
        balance_redeemed_filter,
        "amount",
    )
    .await;
    // For discount vouchers, approximate promo cost as usedCount * discountValue for fixed type only;
    // percentage costs are tracked on transactions via discountAmount.
    let discount_from_vouchers = sum_discount_used(&vouchers, discount_applied_filter.clone()).await;
    let discount_from_tx = sum_transaction_discounts(&db, &date_match).await;
    let discount_vouchers_applied = PromoCountAmount {
        count: discount_from_vouchers.count.max(discount_from_tx.count),
        amount: discount_from_tx.amount.max(discount_from_vouchers.amount),
    };

    let giveaways = sum_count_amount(
        &db.collection::<Document>("balancegiveaways"),
        giveaway_filter,
        "allocatedTotal",
    )
    .await;

    let now = DateTime::now();
    let flash_sales_live = db
        .collection::<Document>("flashsales")
        .count_documents(doc! {
            "isActive": true,
            "startDate": { "$lte": now },
            "endDate": { "$gte": now },
        })
        .await
        .unwrap_or(0) as i64;

    let idle_cutoff =
        DateTime::from_millis(now.timestamp_millis() - 30 * 24 * 60 * 60 * 1000);
    let idle_balance_vouchers = vouchers
        .count_documents(doc! {
            "isRedeemed": false,
            "isArchived": false,
            "$or": [
                { "kind": "balance" },
                { "kind": { "$exists": false } },
            ],
            "createdAt": { "$lte": idle_cutoff },
        })
        .await
        .unwrap_or(0) as i64;
    let open_discount_vouchers = vouchers
        .count_documents(doc! {
            "kind": "discount",
            "isArchived": false,
            "$expr": { "$lt": ["$usedCount", "$maxUses"] },
        })
        .await
        .unwrap_or(0) as i64;

    Json(PromoReportResponse {
        ok: true,
        range: PromoRange {
            start: query.start_date.clone(),
            end: query.end_date.clone(),
        },
        balance_vouchers_redeemed,
        discount_vouchers_applied,
        giveaways,
        flash_sales_live,
        idle_balance_vouchers,
        open_discount_vouchers,
    })
    .into_response()
}


pub async fn promo_export(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SalesSummaryQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                message: "MONGO_URI is not configured",
            }),
        )
            .into_response();
    };
    let db = client.database(&state.mongo_db);
    let date_match = match build_date_match(&query) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let mut balance_redeemed_filter = doc! {
        "isRedeemed": true,
        "$or": [
            { "kind": "balance" },
            { "kind": { "$exists": false } },
        ],
    };
    let mut discount_applied_filter = doc! {
        "kind": "discount",
        "usedCount": { "$gt": 0 },
    };
    let mut giveaway_filter = Document::new();
    if let Some(created) = date_match.get("createdAt") {
        balance_redeemed_filter.insert("redeemedAt", created.clone());
        discount_applied_filter.insert("updatedAt", created.clone());
        giveaway_filter.insert("createdAt", created.clone());
    }

    let vouchers = db.collection::<Document>("vouchers");
    let balance = sum_count_amount(&vouchers, balance_redeemed_filter, "amount").await;
    let discount_from_vouchers = sum_discount_used(&vouchers, discount_applied_filter).await;
    let discount_from_tx = sum_transaction_discounts(&db, &date_match).await;
    let discount = PromoCountAmount {
        count: discount_from_vouchers.count.max(discount_from_tx.count),
        amount: discount_from_tx.amount.max(discount_from_vouchers.amount),
    };
    let giveaways = sum_count_amount(
        &db.collection::<Document>("balancegiveaways"),
        giveaway_filter,
        "allocatedTotal",
    )
    .await;
    let now = DateTime::now();
    let flash_sales_live = db
        .collection::<Document>("flashsales")
        .count_documents(doc! {
            "isActive": true,
            "startDate": { "$lte": now },
            "endDate": { "$gte": now },
        })
        .await
        .unwrap_or(0) as i64;
    let idle_cutoff =
        DateTime::from_millis(now.timestamp_millis() - 30 * 24 * 60 * 60 * 1000);
    let idle_balance_vouchers = vouchers
        .count_documents(doc! {
            "isRedeemed": false,
            "isArchived": false,
            "$or": [
                { "kind": "balance" },
                { "kind": { "$exists": false } },
            ],
            "createdAt": { "$lte": idle_cutoff },
        })
        .await
        .unwrap_or(0) as i64;
    let open_discount_vouchers = vouchers
        .count_documents(doc! {
            "kind": "discount",
            "isArchived": false,
            "$expr": { "$lt": ["$usedCount", "$maxUses"] },
        })
        .await
        .unwrap_or(0) as i64;

    let start = query.start_date.clone().unwrap_or_default();
    let end = query.end_date.clone().unwrap_or_default();
    let mut lines = Vec::new();
    lines.push("\"Metrik\",\"Jumlah\",\"Nominal\",\"Dari\",\"Sampai\"".to_string());
    let push = |lines: &mut Vec<String>, metric: &str, count: i64, amount: i64| {
        lines.push(format!(
            "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"",
            metric.replace('"', "\"\""),
            count,
            amount,
            start.replace('"', "\"\""),
            end.replace('"', "\"\"")
        ));
    };
    push(&mut lines, "Voucher saldo ditukar", balance.count, balance.amount);
    push(&mut lines, "Diskon checkout", discount.count, discount.amount);
    push(&mut lines, "Giveaway dikredit", giveaways.count, giveaways.amount);
    push(&mut lines, "Flash sale live", flash_sales_live, 0);
    push(&mut lines, "Voucher saldo idle >30 hari", idle_balance_vouchers, 0);
    push(&mut lines, "Diskon masih ada slot", open_discount_vouchers, 0);
    let csv = lines.join("\n");

    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str("attachment; filename=\"promo-report.csv\"") {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }
    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

async fn sum_count_amount(
    collection: &mongodb::Collection<Document>,
    filter: Document,
    amount_field: &str,
) -> PromoCountAmount {
    let pipeline = vec![
        doc! { "$match": filter },
        doc! {
            "$group": {
                "_id": null,
                "count": { "$sum": 1 },
                "amount": { "$sum": format!("${amount_field}") },
            }
        },
    ];
    match collection.aggregate(pipeline).await {
        Ok(cursor) => {
            let docs = cursor.try_collect::<Vec<_>>().await.unwrap_or_default();
            docs.first()
                .map(|doc| PromoCountAmount {
                    count: read_i64(doc, "count"),
                    amount: read_i64(doc, "amount"),
                })
                .unwrap_or_default()
        }
        Err(_) => PromoCountAmount::default(),
    }
}

async fn sum_discount_used(
    collection: &mongodb::Collection<Document>,
    filter: Document,
) -> PromoCountAmount {
    let pipeline = vec![
        doc! { "$match": filter },
        doc! {
            "$group": {
                "_id": null,
                "count": { "$sum": "$usedCount" },
                "amount": {
                    "$sum": {
                        "$cond": [
                            { "$eq": ["$discountType", "fixed"] },
                            { "$multiply": ["$usedCount", "$discountValue"] },
                            0
                        ]
                    }
                }
            }
        },
    ];
    match collection.aggregate(pipeline).await {
        Ok(cursor) => {
            let docs = cursor.try_collect::<Vec<_>>().await.unwrap_or_default();
            docs.first()
                .map(|doc| PromoCountAmount {
                    count: read_i64(doc, "count"),
                    amount: read_i64(doc, "amount"),
                })
                .unwrap_or_default()
        }
        Err(_) => PromoCountAmount::default(),
    }
}

async fn sum_transaction_discounts(
    db: &mongodb::Database,
    date_match: &Document,
) -> PromoCountAmount {
    let mut filter = doc! {
        "discountAmount": { "$gt": 0 },
    };
    if let Some(created) = date_match.get("createdAt") {
        filter.insert("createdAt", created.clone());
    }
    let pipeline = vec![
        doc! { "$match": filter },
        doc! {
            "$group": {
                "_id": null,
                "count": { "$sum": 1 },
                "amount": { "$sum": "$discountAmount" },
            }
        },
    ];
    match db
        .collection::<Document>("transactions")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => {
            let docs = cursor.try_collect::<Vec<_>>().await.unwrap_or_default();
            docs.first()
                .map(|doc| PromoCountAmount {
                    count: read_i64(doc, "count"),
                    amount: read_i64(doc, "amount"),
                })
                .unwrap_or_default()
        }
        Err(_) => PromoCountAmount::default(),
    }
}
