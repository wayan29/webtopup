use axum::{response::IntoResponse, response::Response, Json};
use chrono::{Duration, NaiveDate};
use mongodb::bson::{doc, DateTime, Document};

use crate::{security::ErrorResponse, utils::bson::escape_regex};

use super::types::AuditLogsQuery;

pub fn build_audit_filter(query: &AuditLogsQuery) -> Result<Document, Response> {
    let mut filter = Document::new();

    let start = parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (&start, &end) {
        if start > end {
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Tanggal mulai tidak boleh lebih besar dari tanggal akhir",
                }),
            )
                .into_response());
        }
    }
    if start.is_some() || end.is_some() {
        let mut created_at = Document::new();
        if let Some(start) = start {
            created_at.insert("$gte", start);
        }
        if let Some(end) = end {
            created_at.insert("$lte", end);
        }
        filter.insert("createdAt", created_at);
    }

    if let Some(action) = query.action.as_deref().map(str::trim) {
        if matches!(action, "create" | "update" | "delete" | "execute") {
            filter.insert("action", action);
        }
    }

    if let Some(resource) = query
        .resource
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filter.insert("resource", resource);
    }

    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        filter.insert(
            "$or",
            vec![
                doc! { "actorName": regex.clone() },
                doc! { "actorEmail": regex.clone() },
                doc! { "resource": regex.clone() },
                doc! { "path": regex.clone() },
                doc! { "ip": regex },
            ],
        );
    }

    Ok(filter)
}

pub fn parse_positive_i64(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, Response> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let Ok(local_date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") else {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Format tanggal audit tidak valid",
            }),
        )
            .into_response());
    };
    // Admin dashboard operates in WIB (UTC+7). Convert local day boundaries to UTC.
    let date_text = if end_of_day {
        format!("{}T16:59:59.999Z", local_date)
    } else {
        format!("{}T17:00:00.000Z", local_date - Duration::days(1))
    };

    match DateTime::parse_rfc3339_str(&date_text) {
        Ok(date) => Ok(Some(date)),
        Err(_) => Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Format tanggal audit tidak valid",
            }),
        )
            .into_response()),
    }
}
