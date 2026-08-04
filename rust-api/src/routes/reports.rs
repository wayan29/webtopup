use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{DateTime, Document};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
};

mod dashboard;
mod dates;
mod export;
mod mappers;
mod pipelines;
mod types;
use dashboard::*;
use dates::*;
use export::*;
use mappers::*;
use pipelines::*;
pub use types::SalesSummaryQuery;
use types::*;

pub async fn sales_summary(
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
    let date_match = match build_date_match(&query) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let db = client.database(&state.mongo_db);
    let payload = sales_report_payload(&db, date_match).await;
    Json(payload).into_response()
}

async fn sales_report_payload(
    db: &mongodb::Database,
    date_match: Document,
) -> SalesSummaryResponse {
    let pipeline = build_sales_pipeline(date_match);
    let result = first_document(
        db.collection::<Document>("transactions")
            .aggregate(pipeline)
            .await,
    )
    .await
    .unwrap_or_default();

    SalesSummaryResponse {
        summary: sales_summary_from_doc(first_array_item(&result, "summary")),
        category_data: document_array(&result, "categoryData")
            .into_iter()
            .map(category_summary_from_doc)
            .collect(),
        daily_data: document_array(&result, "dailyData")
            .into_iter()
            .map(daily_summary_from_doc)
            .collect(),
        recent_transactions: document_array(&result, "recentTransactions")
            .into_iter()
            .map(recent_transaction_from_doc)
            .collect(),
    }
}

pub async fn dashboard_overview(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SalesSummaryQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let date_match = match build_date_match(&query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let db = client.database(&state.mongo_db);
    let report = sales_report_payload(&db, date_match).await;
    let quick = quick_dashboard_stats(&db).await;
    let seller_callback_queue = seller_callback_queue(&db).await;

    Json(DashboardOverviewResponse {
        summary: report.summary,
        category_data: report.category_data,
        daily_data: report.daily_data,
        recent_transactions: report.recent_transactions,
        quick_stats: quick.0,
        revenue_breakdown: quick.1,
        seller_callback_queue,
        last_updated_at: DateTime::now()
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| DateTime::now().to_string()),
    })
    .into_response()
}

pub async fn export_sales_report(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<SalesSummaryQuery>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let date_match = match build_date_match(&query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let db = client.database(&state.mongo_db);
    let items = match db
        .collection::<Document>("transactions")
        .aggregate(build_sales_export_pipeline(date_match))
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let csv = build_sales_export_csv(&items);
    let filename = format!("sales-report-{}.csv", jakarta_today_key());
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
