mod export;
mod filters;
pub mod mappers;
mod types;

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_permission, ErrorResponse},
    state::AppState,
};

use export::csv_response;
use filters::{build_audit_filter, parse_positive_i64};
use mappers::audit_log_item_from_doc;
use types::{AuditLogsQuery, AuditLogsResponse, PaginationResponse};

const AUDIT_EXPORT_LIMIT: i64 = 5000;

pub async fn audit_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuditLogsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "viewTeam").await {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let page = parse_positive_i64(query.page.as_deref(), 1, 10_000);
    let limit = parse_positive_i64(query.limit.as_deref(), 25, 100);
    let filter = match build_audit_filter(&query) {
        Ok(filter) => filter,
        Err(response) => return response,
    };

    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("adminauditlogs");
    let skip = ((page - 1) * limit) as u64;
    let cursor = match collection
        .find(filter.clone())
        .sort(doc! { "createdAt": -1 })
        .skip(skip)
        .limit(limit)
        .await
    {
        Ok(cursor) => cursor,
        Err(error) => {
            eprintln!("Failed to query admin audit logs: {error}");
            return internal_error();
        }
    };
    let items = match cursor.try_collect::<Vec<_>>().await {
        Ok(items) => items
            .into_iter()
            .map(audit_log_item_from_doc)
            .collect::<Vec<_>>(),
        Err(error) => {
            eprintln!("Failed to collect admin audit logs: {error}");
            return internal_error();
        }
    };
    let total = match collection.count_documents(filter).await {
        Ok(total) => total,
        Err(error) => {
            eprintln!("Failed to count admin audit logs: {error}");
            return internal_error();
        }
    };
    let resources = collection
        .distinct("resource", doc! {})
        .await
        .map(|values| {
            let mut resources = values
                .into_iter()
                .filter_map(|value| match value {
                    Bson::String(text) => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>();
            resources.sort();
            resources
        })
        .unwrap_or_default();
    let total_pages = if total == 0 {
        0
    } else {
        total.div_ceil(limit as u64)
    };

    Json(AuditLogsResponse {
        items,
        resources,
        pagination: PaginationResponse {
            page,
            limit,
            total,
            total_pages,
            total_pages_camel: total_pages,
        },
    })
    .into_response()
}

pub async fn export_audit_logs(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuditLogsQuery>,
) -> Response {
    if let Err(response) = require_permission(&headers, &state, "manageTeam").await {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "exports.sensitive") {
        return response;
    }

    let Some(client) = &state.mongo_client else {
        return unavailable();
    };

    let filter = match build_audit_filter(&query) {
        Ok(filter) => filter,
        Err(response) => return response,
    };
    let collection = client
        .database(&state.mongo_db)
        .collection::<Document>("adminauditlogs");
    let cursor = match collection
        .find(filter)
        .sort(doc! { "createdAt": -1 })
        .limit(AUDIT_EXPORT_LIMIT)
        .await
    {
        Ok(cursor) => cursor,
        Err(error) => {
            eprintln!("Failed to query admin audit logs export: {error}");
            return internal_error();
        }
    };
    let items = match cursor.try_collect::<Vec<_>>().await {
        Ok(items) => items,
        Err(error) => {
            eprintln!("Failed to collect admin audit logs export: {error}");
            return internal_error();
        }
    };

    csv_response(&items)
}

fn internal_error() -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            message: "Internal Server Error",
        }),
    )
        .into_response()
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
