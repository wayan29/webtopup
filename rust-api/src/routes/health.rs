use axum::{response::IntoResponse, Json};
use serde::Serialize;

use crate::utils::dates::timestamp_now;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    timestamp: String,
}

#[derive(Serialize)]
struct PingResponse {
    ok: bool,
    service: &'static str,
    runtime: &'static str,
    api_prefix: &'static str,
}

pub async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok",
        service: "webtopup-api-v2",
        version: env!("CARGO_PKG_VERSION"),
        timestamp: timestamp_now(),
    })
}

pub async fn ping() -> impl IntoResponse {
    Json(PingResponse {
        ok: true,
        service: "webtopup-api-v2",
        runtime: "api-v2",
        api_prefix: "/v2",
    })
}
