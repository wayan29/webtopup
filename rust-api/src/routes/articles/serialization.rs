use mongodb::bson::{Bson, DateTime, Document};
use serde_json::{Map, Value};

use crate::utils::bson::read_string;

use super::validation::sanitize_article_html;

pub fn serialize_public_article(mut document: Document) -> Value {
    let title = read_string(&document, "title").trim().to_string();
    let excerpt = read_string(&document, "excerpt").trim().to_string();
    let category = read_string(&document, "category").trim().to_string();
    let image = read_string(&document, "image").trim().to_string();
    let content = sanitize_article_html(&read_string(&document, "content"));
    document.insert("title", title);
    document.insert("excerpt", excerpt);
    document.insert(
        "category",
        if category.is_empty() {
            "Umum".to_string()
        } else {
            category
        },
    );
    document.insert("image", image);
    document.insert("content", content);
    document_to_json(document)
}

pub fn document_to_json(document: Document) -> Value {
    let mut map = Map::new();
    for (key, value) in document {
        map.insert(key, bson_to_json(value));
    }
    Value::Object(map)
}

fn bson_to_json(value: Bson) -> Value {
    match value {
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::DateTime(value) => Value::String(date_time_to_mongoose_string(value)),
        Bson::String(value) => Value::String(value),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => serde_json::json!(value),
        Bson::Int64(value) => serde_json::json!(value),
        Bson::Double(value) => serde_json::json!(value),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_to_json).collect()),
        Bson::Document(document) => document_to_json(document),
        Bson::Null => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

fn date_time_to_mongoose_string(value: DateTime) -> String {
    let millis = value.timestamp_millis();
    let ms = millis.rem_euclid(1000);
    let base = value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string());
    let Some((date_time, _)) = base.split_once('.') else {
        return base.replace('Z', &format!(".{ms:03}Z"));
    };
    format!("{date_time}.{ms:03}Z")
}
