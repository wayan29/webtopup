mod queries;
mod types;

use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};

use crate::{
    security::require_proxy_context,
    state::AppState,
    utils::dates::timestamp_now,
};

use queries::ops_snapshot_queries;
use types::OpsSnapshotResponse;

pub async fn ops_snapshot(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let (transactions_today, deposits, vendors, stuck, promo) =
        ops_snapshot_queries(&state.pg_pool).await;
    Json(OpsSnapshotResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        source: "postgresql-snapshot",
        user: proxy_context.into_response(),
        transactions_today,
        deposits,
        vendors,
        stuck,
        promo,
    }).into_response()
}

