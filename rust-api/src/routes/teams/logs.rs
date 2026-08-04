use std::collections::HashMap;

use axum::{response::IntoResponse, Json};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};

use super::{mappers::login_log_from_doc, types::LoginLogsResponse};

pub(super) async fn login_logs_response(
    db: &mongodb::Database,
    filter: Document,
    query: &HashMap<String, String>,
    scope: Option<String>,
) -> axum::response::Response {
    let page = parse_positive_i64(query.get("page"), 1, i64::MAX);
    let limit = parse_positive_i64(query.get("limit"), 20, 100);
    let skip = u64::try_from((page - 1) * limit).unwrap_or(0);
    let collection = db.collection::<Document>("loginlogs");
    let docs = match collection
        .find(filter.clone())
        .sort(doc! { "createdAt": -1 })
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let total_logs = collection.count_documents(filter).await.unwrap_or(0) as i64;

    Json(LoginLogsResponse {
        logs: docs.into_iter().map(login_log_from_doc).collect(),
        current_page: page,
        total_pages: std::cmp::max(1, ((total_logs as f64) / (limit as f64)).ceil() as i64),
        total_logs,
        page_size: limit,
        scope,
    })
    .into_response()
}

pub(super) fn parse_positive_i64(value: Option<&String>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| std::cmp::min(value, max))
        .unwrap_or(fallback)
}
