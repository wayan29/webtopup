mod queries;
mod types;

use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};

use crate::{
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::dates::timestamp_now,
};

use queries::{
    deposit_ops_summary, stuck_ops_summary, transaction_today_summary, vendor_ops_summary,
};
use types::OpsSnapshotResponse;

pub async fn ops_snapshot(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };

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
    let transactions_today = transaction_today_summary(&db).await;
    let deposits = deposit_ops_summary(&db).await;
    let vendors = vendor_ops_summary(&db).await;
    let stuck = stuck_ops_summary(&db, 15).await;

    Json(OpsSnapshotResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        source: "mongodb-snapshot",
        user: proxy_context.into_response(),
        transactions_today,
        deposits,
        vendors,
        stuck,
    })
    .into_response()
}
