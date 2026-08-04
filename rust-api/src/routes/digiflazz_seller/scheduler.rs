use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};

use crate::{security::require_proxy_context, state::AppState};

use super::SchedulerConfigResponse;

pub async fn scheduler_config(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost:9005");
    let protocol = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("http");
    let path = "/api/v2/digiflazz-seller/orders/process-callback-retries/scheduler";

    Json(SchedulerConfigResponse {
        token_configured: std::env::var("DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        endpoint_path: path,
        endpoint_url: format!("{}://{}{}", protocol, host, path),
        token_header: "X-Scheduler-Token",
        recommended_interval_minutes: 1,
        max_limit: 50,
        example_limit: 20,
    })
    .into_response()
}
