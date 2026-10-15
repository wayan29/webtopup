use axum::{response::IntoResponse, response::Response, Json};
use chrono::{Duration, NaiveDate, DateTime, Utc};
use sqlx::{PgPool, postgres::PgRow};

use crate::security::ErrorResponse;
use super::types::AuditLogsQuery;

pub struct AuditFilter { pub start: Option<DateTime<Utc>>, pub end: Option<DateTime<Utc>>, pub action: Option<String>, pub resource: Option<String>, pub search: Option<String> }

impl AuditFilter {
    pub async fn fetch(&self, pool: &PgPool, limit: i64, offset: i64) -> Result<Vec<PgRow>, sqlx::Error> {
        let mut query = sqlx::QueryBuilder::new("SELECT id,actor,action,correlation,payload,created_at FROM audit_events WHERE TRUE");
        self.append(&mut query);
        query.push(" ORDER BY created_at DESC,id DESC LIMIT ").push_bind(limit).push(" OFFSET ").push_bind(offset).build().fetch_all(pool).await
    }
    pub async fn count(&self, pool: &PgPool) -> Result<i64, sqlx::Error> {
        let mut query = sqlx::QueryBuilder::new("SELECT COUNT(*) FROM audit_events WHERE TRUE");
        self.append(&mut query);
        query.build_query_scalar().fetch_one(pool).await
    }
    fn append<'a>(&'a self, query: &mut sqlx::QueryBuilder<'a, sqlx::Postgres>) {
        if let Some(start) = &self.start { query.push(" AND created_at >= ").push_bind(start.to_owned()); }
        if let Some(end) = &self.end { query.push(" AND created_at <= ").push_bind(end.to_owned()); }
        if let Some(action) = &self.action { query.push(" AND action = ").push_bind(action); }
        if let Some(resource) = &self.resource { query.push(" AND payload->>'resource' = ").push_bind(resource); }
        if let Some(search) = &self.search {
            let pattern = format!("%{}%", search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            query.push(" AND (actor ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR action ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR payload->>'actorName' ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR payload->>'actorEmail' ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR payload->>'resource' ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR payload->>'path' ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR payload->>'ip' ILIKE ").push_bind(pattern.clone()).push(" ESCAPE E'\\\\' OR correlation ILIKE ").push_bind(pattern).push(" ESCAPE E'\\\\')");
        }
    }
}

pub fn build_audit_filter(query: &AuditLogsQuery) -> Result<AuditFilter, Response> {
    let start = parse_date_boundary(query.start_date.as_deref(), false)?;
    let end = parse_date_boundary(query.end_date.as_deref(), true)?;
    if let (Some(start), Some(end)) = (&start, &end) { if start > end { return Err(bad_request("Tanggal mulai tidak boleh lebih besar dari tanggal akhir")); } }
    let action = query.action.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    if action.as_deref().is_some_and(|v| !matches!(v, "create" | "update" | "delete" | "execute")) { return Err(bad_request("Aksi audit tidak valid")); }
    let resource = query.resource.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    if resource.as_ref().is_some_and(|v| v.chars().count() > 120) { return Err(bad_request("Resource harus 1–120 karakter atau dikosongkan")); }
    let search = query.search.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    if search.as_ref().is_some_and(|v| !(2..=120).contains(&v.chars().count())) { return Err(bad_request("Pencarian harus 2–120 karakter atau dikosongkan")); }
    Ok(AuditFilter { start, end, action, resource, search })
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
)-> Result<Option<DateTime<Utc>>, Response> {
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

    match chrono::DateTime::parse_from_rfc3339(&date_text) {
        Ok(date) => Ok(Some(date.with_timezone(&Utc))),
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
    fn search_filter_includes_fields_and_valid_action() {
        let filter = build_audit_filter(&query(Some("trace-123"), Some("update"), Some("Products"), None, None)).unwrap();
        assert_eq!(filter.action.as_deref(), Some("update"));
        assert_eq!(filter.resource.as_deref(), Some("Products"));
        assert_eq!(filter.search.as_deref(), Some("trace-123"));
    }
}
