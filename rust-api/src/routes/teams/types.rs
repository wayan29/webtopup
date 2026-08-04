use mongodb::bson::{oid::ObjectId, Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct TeamListResponse {
    pub(super) members: Vec<TeamMemberItem>,
    pub(super) summary: TeamSummary,
}

#[derive(Serialize)]
pub(super) struct TeamMemberResponse {
    pub(super) member: TeamMemberItem,
}

#[derive(Serialize)]
pub(super) struct TeamMemberItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) role: String,
    pub(super) active: bool,
    #[serde(rename = "twoFactorEnabled")]
    pub(super) two_factor_enabled: bool,
    pub(super) permissions: serde_json::Value,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "createdBy")]
    pub(super) created_by: Option<CreatedByItem>,
}

#[derive(Serialize)]
pub(super) struct CreatedByItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) role: String,
}

#[derive(Default, Serialize)]
pub(super) struct TeamSummary {
    pub(super) total: i64,
    pub(super) active: i64,
    pub(super) inactive: i64,
    pub(super) owner: i64,
    pub(super) admin: i64,
    pub(super) cs: i64,
}

#[derive(Serialize)]
pub(super) struct TeamAuditLogsResponse {
    pub(super) logs: Vec<TeamAuditLogItem>,
    #[serde(rename = "currentPage")]
    pub(super) current_page: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
    #[serde(rename = "totalLogs")]
    pub(super) total_logs: i64,
    #[serde(rename = "pageSize")]
    pub(super) page_size: i64,
}

#[derive(Serialize)]
pub(super) struct TeamAuditLogItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) actor: Option<String>,
    #[serde(rename = "actorName")]
    pub(super) actor_name: String,
    #[serde(rename = "actorEmail")]
    pub(super) actor_email: String,
    #[serde(rename = "targetUser", skip_serializing_if = "Option::is_none")]
    pub(super) target_user: Option<String>,
    #[serde(rename = "targetName")]
    pub(super) target_name: String,
    #[serde(rename = "targetEmail")]
    pub(super) target_email: String,
    #[serde(rename = "targetRole")]
    pub(super) target_role: String,
    pub(super) action: String,
    pub(super) summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) metadata: Option<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct LoginLogsResponse {
    pub(super) logs: Vec<LoginLogItem>,
    #[serde(rename = "currentPage")]
    pub(super) current_page: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
    #[serde(rename = "totalLogs")]
    pub(super) total_logs: i64,
    #[serde(rename = "pageSize")]
    pub(super) page_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) scope: Option<String>,
}

#[derive(Serialize)]
pub(super) struct LoginLogItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user: Option<String>,
    pub(super) email: String,
    pub(super) role: String,
    pub(super) ip: String,
    #[serde(rename = "userAgent")]
    pub(super) user_agent: String,
    pub(super) status: String,
    #[serde(rename = "failReason", skip_serializing_if = "Option::is_none")]
    pub(super) fail_reason: Option<String>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

pub(super) struct ActorScope {
    pub(super) id: ObjectId,
    pub(super) name: String,
    pub(super) email: String,
    pub(super) role: String,
    pub(super) is_owner: bool,
    pub(super) permissions: Document,
}

#[derive(Deserialize)]
pub struct TeamMemberPayload {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) password: Option<String>,
    pub(super) role: Option<String>,
    pub(super) permissions: Option<Value>,
}
