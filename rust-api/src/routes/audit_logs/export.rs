use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    response::Response,
};
use chrono::Utc;
use serde_json::Value;

use crate::utils::bson::{optional_i64, read_string};

use crate::services::audit_sanitize::{sanitize_audit_document, AUDIT_REDACTION};

pub fn csv_response(items: &[Value], truncated: bool) -> Response {
    let csv = build_audit_csv(items);
    let filename = format!("admin-audit-logs-{}.csv", date_key());
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response_headers.insert(header::CONTENT_DISPOSITION, value);
    }

    response_headers.insert("x-export-limit", HeaderValue::from_static("5000"));
    response_headers.insert(
        "x-export-truncated",
        HeaderValue::from_static(if truncated { "true" } else { "false" }),
    );

    (StatusCode::OK, response_headers, format!("\u{FEFF}{csv}")).into_response()
}

fn build_audit_csv(items: &[Value]) -> String {
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
        let metadata = item.get("metadata").map(sanitize_audit_document);
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
            metadata.as_ref().map(Value::to_string).unwrap_or_default(),
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

fn csv_date(document: &Value, key: &str) -> String {
    document
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn date_key() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use serde_json::json;

    #[tokio::test]
    async fn export_sets_truncation_headers_and_redacts_metadata() {
        let item = json!({
            "createdAt": "2023-11-14T22:13:20.000Z",
            "actorName": "Audit Fixture",
            "actorEmail": "audit-fixture@task14.invalid",
            "actorRole": "cs",
            "action": "update",
            "resource": "Products",
            "method": "PUT",
            "path": "/api/v2/products/admin/update",
            "statusCode": 200_i64,
            "ip": "127.0.0.1",
            "userAgent": "task14",
            "summary": "\t=1+1",
            "metadata": {
                "pin": "fixture-value",
                "shipping": "visible",
            },
        });

        let response = csv_response(std::slice::from_ref(&item), false);
        assert_eq!(
            response
                .headers()
                .get("x-export-limit")
                .and_then(|value| value.to_str().ok()),
            Some("5000")
        );
        assert_eq!(
            response
                .headers()
                .get("x-export-truncated")
                .and_then(|value| value.to_str().ok()),
            Some("false")
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let csv = String::from_utf8(body.to_vec()).unwrap();
        assert!(csv.contains(AUDIT_REDACTION));
        assert!(!csv.contains("fixture-value"));
        assert!(csv.contains("visible"));
        // CSV formula neutralization is cell-scoped; summary is a dedicated cell.
        assert!(csv.contains("\"'\t=1+1\"") || csv.contains("'\t=1+1"));

        let truncated_response = csv_response(&[item], true);
        assert_eq!(
            truncated_response
                .headers()
                .get("x-export-truncated")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
    }

    #[test]
    fn formula_values_are_neutralized_after_control_prefix() {
        assert_eq!(neutralize_csv_formula("\t=1+1"), "'\t=1+1");
        assert_eq!(neutralize_csv_formula("  +cmd"), "'  +cmd");
        assert_eq!(neutralize_csv_formula("safe"), "safe");
    }
}
