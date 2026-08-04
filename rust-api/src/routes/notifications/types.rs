use mongodb::bson::DateTime;
use serde::{Deserialize, Serialize};

use crate::security::ProxyContextResponse;

#[derive(Serialize)]
pub struct NotificationSummaryResponse {
    pub ok: bool,
    pub service: &'static str,
    pub api_prefix: &'static str,
    pub generated_at: String,
    pub source: &'static str,
    pub user: Option<ProxyContextResponse>,
    pub total: i64,
    pub unread: i64,
    pub critical: i64,
    pub warning: i64,
    pub info: i64,
    pub categories: NotificationCategoryCounts,
    pub top: Vec<AdminNotificationItem>,
}

#[derive(Serialize)]
pub struct NotificationListResponse {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub total: i64,
    pub unread: i64,
    pub critical: i64,
    pub warning: i64,
    pub info: i64,
    pub notifications: Vec<AdminNotificationItem>,
}

#[derive(Deserialize)]
pub struct NotificationStatePayload {
    pub fingerprint: Option<String>,
}

#[derive(Serialize)]
pub struct NotificationStateResponse {
    pub success: bool,
}

#[derive(Serialize)]
pub struct MarkAllReadResponse {
    pub success: bool,
    pub updated: i64,
}

#[derive(Default, Serialize)]
pub struct NotificationCategoryCounts {
    pub transactions: i64,
    pub deposits: i64,
    pub vendors: i64,
    pub callbacks: i64,
}

#[derive(Clone, Serialize)]
pub struct AdminNotificationItem {
    pub id: &'static str,
    pub severity: &'static str,
    pub category: &'static str,
    pub title: &'static str,
    pub message: String,
    pub count: i64,
    #[serde(rename = "actionLabel")]
    pub action_label: &'static str,
    #[serde(rename = "actionPath")]
    pub action_path: &'static str,
    pub fingerprint: String,
    #[serde(rename = "readAt")]
    pub read_at: Option<String>,
    #[serde(rename = "dismissedAt")]
    pub dismissed_at: Option<String>,
    pub unread: bool,
}

pub struct NotificationTemplate {
    pub id: &'static str,
    pub severity: &'static str,
    pub category: &'static str,
    pub title: &'static str,
    pub message: String,
    pub action_label: &'static str,
    pub action_path: &'static str,
}

pub struct NotificationStats {
    pub total: i64,
    pub unread: i64,
    pub critical: i64,
    pub warning: i64,
    pub info: i64,
}

pub const STUCK_TRANSACTION_MINUTES: i64 = 15;
pub const HIGH_CALLBACK_ATTEMPT_THRESHOLD: i64 = 5;

pub fn date_to_string(value: &DateTime) -> String {
    value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string())
}
