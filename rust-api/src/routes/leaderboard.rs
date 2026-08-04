mod queries;
mod types;

use std::sync::Arc;

use axum::{extract::Query, response::IntoResponse, response::Response, Json};
use mongodb::bson::DateTime;

use crate::state::AppState;

use queries::{
    base_pipeline, current_user, leaderboard_item_from_doc, period_from_query, read_i64_field,
    resolve_current_member, top_docs, totals,
};
use types::{LeaderboardMeta, LeaderboardQuery, LeaderboardResponse};

pub async fn get_leaderboard(
    headers: axum::http::HeaderMap,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Query(query): Query<LeaderboardQuery>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let period = period_from_query(query.period.as_deref());
    let current_member = resolve_current_member(&headers, &db).await;
    let base_pipeline = base_pipeline(period);
    let top_docs = top_docs(&db, &base_pipeline).await;
    let totals = totals(&db, &base_pipeline).await;

    let items = top_docs
        .into_iter()
        .enumerate()
        .map(|(index, doc)| {
            leaderboard_item_from_doc(doc, index as i64 + 1, current_member.as_ref())
        })
        .collect::<Vec<_>>();
    let current_user =
        current_user(&db, period, current_member.as_ref(), &items, &base_pipeline).await;
    let summary = totals.first();

    Json(LeaderboardResponse {
        items,
        current_user,
        meta: LeaderboardMeta {
            period: period.to_string(),
            participant_count: summary
                .map(|doc| read_i64_field(doc, "participantCount"))
                .unwrap_or(0),
            total_transactions: summary
                .map(|doc| read_i64_field(doc, "totalTransactions"))
                .unwrap_or(0),
            total_amount: summary
                .map(|doc| read_i64_field(doc, "totalAmount"))
                .unwrap_or(0),
            generated_at: DateTime::now()
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| DateTime::now().to_string()),
        },
    })
    .into_response()
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "MONGO_URI is not configured",
    )
}
