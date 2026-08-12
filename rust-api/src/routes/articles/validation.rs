use axum::response::Response;
use mongodb::bson::Document;
use regex::Regex;
use serde_json::Value;

use crate::utils::bson::read_string;

use super::{
    responses::status_message,
    types::{ArticlePayload, NormalizedArticlePayload},
};

pub fn build_article_payload(
    payload: ArticlePayload,
    current: Option<&Document>,
) -> Result<NormalizedArticlePayload, Response> {
    let title = text_value_or_current(payload.title, current, "title", "");
    if title.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Judul artikel wajib diisi",
        ));
    }
    let slug = slugify_title(&title);
    if slug.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Judul artikel tidak valid untuk dijadikan slug",
        ));
    }
    let excerpt = text_value_or_current(payload.excerpt, current, "excerpt", "");
    if excerpt.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ringkasan artikel wajib diisi",
        ));
    }
    let content = sanitize_article_html(&text_value_or_current(
        payload.content,
        current,
        "content",
        "",
    ));
    if strip_html_tags(&content).trim().is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Konten artikel wajib diisi",
        ));
    }
    let status = match payload.status {
        Some(Value::String(value)) if value == "published" || value == "draft" => value,
        Some(_) => {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Status artikel tidak valid",
            ))
        }
        None => current
            .map(|document| read_string_default(document, "status", "draft"))
            .unwrap_or_else(|| "draft".to_string()),
    };
    let image = text_value_or_current(payload.image, current, "image", "");
    if let Err(response) = crate::services::managed_assets::ensure_managed_fields(
        &crate::routes::uploads::upload_root(),
        &[&image],
    ) {
        return Err(response);
    }
    Ok(NormalizedArticlePayload {
        title,
        slug,
        excerpt,
        content,
        image,
        category: {
            let category = text_value_or_current(payload.category, current, "category", "");
            if category.is_empty() {
                "Umum".to_string()
            } else {
                category
            }
        },
        status,
    })
}

fn text_value_or_current(
    value: Option<Value>,
    current: Option<&Document>,
    key: &str,
    default: &str,
) -> String {
    match value {
        Some(value) => text_value(Some(value)).unwrap_or_default(),
        None => current
            .map(|document| read_string_default(document, key, default))
            .unwrap_or_else(|| default.to_string()),
    }
}

fn text_value(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.trim().to_string()),
        Some(Value::Number(value)) => Some(value.to_string().trim().to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) | None => None,
    }
}

fn read_string_default(document: &Document, key: &str, default: &str) -> String {
    let value = read_string(document, key);
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

fn slugify_title(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.to_lowercase().trim().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn strip_html_tags(value: &str) -> String {
    Regex::new(r"<[^>]+>")
        .map(|regex| regex.replace_all(value, " ").to_string())
        .unwrap_or_else(|_| value.to_string())
}

pub fn sanitize_article_html(value: &str) -> String {
    let patterns = [
        r#"(?is)<script[\s\S]*?>[\s\S]*?</script>"#,
        r#"(?is)<style[\s\S]*?>[\s\S]*?</style>"#,
        r#"(?is)<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>[\s\S]*?</(iframe|object|embed|form|input|button|textarea|select|meta|link|base)>"#,
        r#"(?is)<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)([^>]*)/?>"#,
        r#"(?i)\s(on[a-z]+)\s*=\s*"[^"]*""#,
        r#"(?i)\s(on[a-z]+)\s*=\s*'[^']*'"#,
        r#"(?i)\s(on[a-z]+)\s*=\s*[^\s>]+"#,
        r#"(?i)\s(href|src)\s*=\s*"\s*javascript:[^"]*""#,
        r#"(?i)\s(href|src)\s*=\s*'\s*javascript:[^']*'"#,
        r#"(?i)\s(href|src)\s*=\s*"\s*data:text/html[^"]*""#,
        r#"(?i)\s(href|src)\s*=\s*'\s*data:text/html[^']*'"#,
        r#"(?i)\sstyle\s*=\s*"[^"]*""#,
        r#"(?i)\sstyle\s*=\s*'[^']*'"#,
    ];
    let mut sanitized = value.to_string();
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            sanitized = regex.replace_all(&sanitized, "").to_string();
        }
    }
    sanitized.trim().to_string()
}
