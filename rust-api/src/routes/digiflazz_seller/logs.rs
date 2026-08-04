use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, response::Response, Json};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};

use crate::{security::require_proxy_context, state::AppState};

use super::{
    date_string, document_id, document_string, unavailable, EmptyStringFallback, SellerLogItem,
};

pub async fn logs(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = match client
        .database(&state.mongo_db)
        .collection::<Document>("webhookeventlogs")
        .find(doc! { "provider": "digiflazz_seller" })
        .sort(doc! { "createdAt": -1 })
        .limit(100)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Json(
        docs.into_iter()
            .map(seller_log_from_doc)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

fn seller_log_from_doc(document: Document) -> SellerLogItem {
    SellerLogItem {
        id: document_id(&document),
        timestamp: date_string(&document, "createdAt"),
        event: document_string(&document, "event").if_empty("digiflazz_seller"),
        ref_id: document_string(&document, "refId"),
        status: document_string(&document, "status"),
        message: document_string(&document, "message"),
        delivered: document.get_bool("verified").unwrap_or(false),
    }
}
