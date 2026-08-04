use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    response::Response,
};
use mongodb::bson::{Bson, DateTime, Document};

use crate::utils::bson::{optional_i64, read_string};

pub fn csv_response(items: &[Document]) -> Response {
    let csv = build_audit_csv(items);
    let filename = format!("admin-audit-logs-{}.csv", date_key(DateTime::now()));
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    response_headers.insert("x-export-limit", HeaderValue::from_static("5000"));

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

fn build_audit_csv(items: &[Document]) -> String {
    let mut rows = vec![vec![
        "Tanggal".to_string(),
        "Actor".to_string(),
        "Email".to_string(),
        "Role".to_string(),
        "Action".to_string(),
        "Resource".to_string(),
        "Method".to_string(),
        "Path".to_string(),
        "Status Code".to_string(),
        "IP".to_string(),
        "User Agent".to_string(),
        "Summary".to_string(),
        "Metadata".to_string(),
    ]];

    for item in items {
        rows.push(vec![
            csv_date(item, "createdAt"),
            read_string(item, "actorName"),
            read_string(item, "actorEmail"),
            read_string(item, "actorRole"),
            read_string(item, "action"),
            read_string(item, "resource"),
            read_string(item, "method"),
            read_string(item, "path"),
            optional_i64(item, "statusCode")
                .map(|value| value.to_string())
                .unwrap_or_default(),
            read_string(item, "ip"),
            read_string(item, "userAgent"),
            read_string(item, "summary"),
            item.get("metadata")
                .map(bson_to_json_string)
                .unwrap_or_default(),
        ]);
    }

    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|value| csv_escape(&value))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv_escape(value: &str) -> String {
    let value = neutralize_csv_formula(value);
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn neutralize_csv_formula(value: &str) -> String {
    let trimmed = value
        .trim_start_matches(|character: char| character.is_control() || character.is_whitespace());
    if matches!(trimmed.chars().next(), Some('=' | '+' | '-' | '@')) {
        format!("'{}", value)
    } else {
        value.to_string()
    }
}

fn csv_date(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .ok()
        .and_then(|value| value.try_to_rfc3339_string().ok())
        .unwrap_or_default()
}

fn date_key(date: DateTime) -> String {
    date.try_to_rfc3339_string()
        .ok()
        .and_then(|value| value.get(0..10).map(ToString::to_string))
        .unwrap_or_else(|| "unknown-date".to_string())
}

fn bson_to_json_string(value: &Bson) -> String {
    match mongodb::bson::from_bson::<serde_json::Value>(value.clone()) {
        Ok(value) => value.to_string(),
        Err(_) => value.to_string(),
    }
}
