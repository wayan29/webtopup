use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct DigiflazzWebhookConfig {
    pub secret: String,
    pub configured: bool,
    #[serde(rename = "whitelistIP")]
    pub whitelist_ip: String,
    pub protected: bool,
    #[serde(rename = "protectionMode")]
    pub protection_mode: String,
}

#[derive(Serialize)]
pub struct TokovoucherWebhookConfig {
    #[serde(rename = "whitelistIP")]
    pub whitelist_ip: String,
    pub configured: bool,
    pub protected: bool,
    #[serde(rename = "protectionMode")]
    pub protection_mode: String,
}

#[derive(Serialize)]
pub struct WebhookLogItem {
    pub id: String,
    pub timestamp: String,
    pub event: String,
    #[serde(rename = "refId")]
    pub ref_id: String,
    pub status: String,
    pub message: String,
    pub verified: bool,
}

#[derive(Deserialize)]
pub struct WebhookConfigPayload {
    pub secret: Option<String>,
    #[serde(rename = "whitelistIP")]
    pub whitelist_ip: Option<String>,
}

#[derive(Serialize)]
pub struct WebhookSaveResponse {
    pub message: &'static str,
}
