use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};

use crate::{security::require_proxy_context, state::AppState};

use super::{
    responses::{provider_not_found, unavailable},
    utils::webhook_log_from_doc,
};

pub async fn logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    if !matches!(provider.as_str(), "digiflazz" | "tokovoucher") {
        return provider_not_found();
    }
    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("webhookeventlogs")
        .find(doc! { "provider": provider.as_str() })
        .sort(doc! { "createdAt": -1 })
        .limit(100)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Json(
        docs.into_iter()
            .map(|doc| webhook_log_from_doc(doc, &provider))
            .collect::<Vec<_>>(),
    )
    .into_response()
}
