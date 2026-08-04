use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};
use mongodb::bson::doc;
use serde::Serialize;

use crate::{
    security::{require_proxy_context, ProxyContextResponse},
    state::AppState,
    utils::dates::timestamp_now,
};

#[derive(Serialize)]
struct SystemStatusResponse {
    ok: bool,
    service: &'static str,
    version: &'static str,
    api_prefix: &'static str,
    timestamp: String,
    database: DatabaseStatus,
    user: Option<ProxyContextResponse>,
}

#[derive(Serialize)]
struct DatabaseStatus {
    configured: bool,
    ok: bool,
    name: String,
    message: String,
}

pub async fn system_status(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };

    let database = match &state.mongo_client {
        Some(client) => match client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
        {
            Ok(_) => DatabaseStatus {
                configured: true,
                ok: true,
                name: state.mongo_db.clone(),
                message: "MongoDB ping ok".to_string(),
            },
            Err(error) => DatabaseStatus {
                configured: true,
                ok: false,
                name: state.mongo_db.clone(),
                message: error.to_string(),
            },
        },
        None => DatabaseStatus {
            configured: false,
            ok: false,
            name: state.mongo_db.clone(),
            message: "MONGO_URI is not configured".to_string(),
        },
    };

    Json(SystemStatusResponse {
        ok: database.ok,
        service: "webtopup-api-v2",
        version: env!("CARGO_PKG_VERSION"),
        api_prefix: "/v2",
        timestamp: timestamp_now(),
        database,
        user: proxy_context.into_response(),
    })
    .into_response()
}
