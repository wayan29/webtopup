use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct ArticlePayload {
    pub title: Option<Value>,
    pub excerpt: Option<Value>,
    pub content: Option<Value>,
    pub image: Option<Value>,
    pub category: Option<Value>,
    pub status: Option<Value>,
}

pub struct NormalizedArticlePayload {
    pub title: String,
    pub slug: String,
    pub excerpt: String,
    pub content: String,
    pub image: String,
    pub category: String,
    pub status: String,
}
