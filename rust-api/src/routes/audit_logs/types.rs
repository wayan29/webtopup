use mongodb::bson::Document;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct AuditLogsQuery {
    pub(super) page: Option<String>,
    pub(super) limit: Option<String>,
    pub(super) search: Option<String>,
    pub(super) action: Option<String>,
    pub(super) resource: Option<String>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<String>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<String>,
}

#[derive(Serialize)]
pub struct AuditLogsResponse {
    pub items: Vec<AuditLogItem>,
    pub resources: Vec<String>,
    pub pagination: PaginationResponse,
}

#[derive(Serialize)]
pub struct PaginationResponse {
    pub page: i64,
    pub limit: i64,
    pub total: u64,
    pub total_pages: u64,
    #[serde(rename = "totalPages")]
    pub total_pages_camel: u64,
}

#[derive(Serialize)]
pub struct AuditLogItem {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "actorName")]
    pub actor_name: String,
    #[serde(rename = "actorEmail")]
    pub actor_email: String,
    #[serde(rename = "actorRole")]
    pub actor_role: String,
    pub action: String,
    pub resource: String,
    pub method: String,
    pub path: String,
    #[serde(rename = "statusCode")]
    pub status_code: Option<i64>,
    pub ip: Option<String>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    pub summary: String,
    pub metadata: Option<Document>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}
