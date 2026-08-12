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
            return Err(bad_request(
                "Tanggal mulai tidak boleh lebih besar dari tanggal akhir",
            ));
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

    if let Some(action_raw) = query.action.as_deref() {
        let action = action_raw.trim();
        if !action.is_empty() {
            if !matches!(action, "create" | "update" | "delete" | "execute") {
                return Err(bad_request("Aksi audit tidak valid"));
            }
            filter.insert("action", action);
        }
    }

    if let Some(resource_raw) = query.resource.as_deref() {
        let resource = resource_raw.trim();
        if !resource.is_empty() {
            if resource.chars().count() > 120 {
                return Err(bad_request("Resource harus 1–120 karakter atau dikosongkan"));
            }
            filter.insert("resource", resource);
        }
    }

    if let Some(search_raw) = query.search.as_deref() {
        let search = search_raw.trim();
        if !search.is_empty() {
            let length = search.chars().count();
            if length < 2 || length > 120 {
                return Err(bad_request(
                    "Pencarian harus 2–120 karakter atau dikosongkan",
                ));
            }
            let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
            filter.insert(
                "$or",
                vec![
                    doc! { "actorName": regex.clone() },
                    doc! { "actorEmail": regex.clone() },
                    doc! { "resource": regex.clone() },
                    doc! { "path": regex.clone() },
                    doc! { "ip": regex.clone() },
                    doc! { "metadata.traceId": regex },
                ],
            );
        }
    }

    Ok(filter)
}

pub fn parse_positive_i64(
    value: Option<&str>,
    fallback: i64,
    max: i64,
) -> Result<i64, Response> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(fallback);
    };

    let Ok(parsed) = raw.parse::<i64>() else {
        return Err(bad_request("Nilai pagination tidak valid"));
    };
    if parsed <= 0 || parsed > max {
        return Err(bad_request("Nilai pagination di luar batas yang diizinkan"));
    }
    Ok(parsed)
}

fn parse_date_boundary(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime>, Response> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let Ok(local_date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") else {
        return Err(bad_request("Format tanggal audit tidak valid"));
    };
    // Admin dashboard operates in WIB (UTC+7). Convert local day boundaries to UTC.
    let date_text = if end_of_day {
        format!("{}T16:59:59.999Z", local_date)
    } else {
        format!("{}T17:00:00.000Z", local_date - Duration::days(1))
    };

    match DateTime::parse_rfc3339_str(&date_text) {
        Ok(date) => Ok(Some(date)),
        Err(_) => Err(bad_request("Format tanggal audit tidak valid")),
    }
}

fn bad_request(message: &'static str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(ErrorResponse { message }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(
        search: Option<&str>,
        action: Option<&str>,
        resource: Option<&str>,
        start: Option<&str>,
        end: Option<&str>,
    ) -> AuditLogsQuery {
        AuditLogsQuery {
            page: None,
            limit: None,
            search: search.map(str::to_string),
            action: action.map(str::to_string),
            resource: resource.map(str::to_string),
            start_date: start.map(str::to_string),
            end_date: end.map(str::to_string),
        }
    }

    #[test]
    fn invalid_supplied_filters_return_bad_request() {
        assert!(build_audit_filter(&query(Some("a"), None, None, None, None)).is_err());
        assert!(build_audit_filter(&query(
            Some(&"x".repeat(121)),
            None,
            None,
            None,
            None
        ))
        .is_err());
        assert!(build_audit_filter(&query(None, Some("deleted"), None, None, None)).is_err());
        assert!(build_audit_filter(&query(
            None,
            None,
            Some(&"r".repeat(121)),
            None,
            None
        ))
        .is_err());
        assert!(build_audit_filter(&query(
            None,
            None,
            None,
            Some("2026-02-30"),
            None
        ))
        .is_err());
        assert!(build_audit_filter(&query(
            None,
            None,
            None,
            Some("2026-08-12"),
            Some("2026-08-01")
        ))
        .is_err());
        assert!(parse_positive_i64(Some("0"), 1, 10_000).is_err());
        assert!(parse_positive_i64(Some("-2"), 1, 10_000).is_err());
        assert!(parse_positive_i64(Some("10001"), 1, 10_000).is_err());
        assert!(parse_positive_i64(Some("abc"), 1, 10_000).is_err());
        assert_eq!(parse_positive_i64(None, 25, 100).unwrap(), 25);
    }

    #[test]
    fn search_filter_includes_trace_id_and_valid_action() {
        let filter = build_audit_filter(&query(
            Some("trace-123"),
            Some("update"),
            Some("Products"),
            None,
            None,
        ))
        .unwrap();
        assert_eq!(filter.get_str("action").unwrap(), "update");
        assert_eq!(filter.get_str("resource").unwrap(), "Products");
        let ors = filter.get_array("$or").unwrap();
        assert!(ors.iter().any(|entry| {
            entry
                .as_document()
                .and_then(|document| document.get("metadata.traceId"))
                .is_some()
        }));
    }
}
