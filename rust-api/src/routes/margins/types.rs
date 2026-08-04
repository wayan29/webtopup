use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_MARGIN_PERCENT: f64 = 500.0;

#[derive(Serialize)]
pub struct MarginResponse {
    pub success: bool,
    pub data: MarginData,
    pub meta: MarginMeta,
    pub limits: MarginLimits,
}

#[derive(Deserialize)]
pub struct MarginPayload {
    pub(super) basic: Option<Value>,
    pub(super) gold: Option<Value>,
    pub(super) platinum: Option<Value>,
    pub(super) note: Option<Value>,
}

#[derive(Serialize)]
pub struct MarginUpdateResponse {
    pub message: &'static str,
    pub success: bool,
    pub data: MarginData,
    pub meta: MarginMeta,
    pub limits: MarginLimits,
}

#[derive(Serialize)]
pub struct MarginData {
    pub basic: f64,
    pub gold: f64,
    pub platinum: f64,
    pub note: String,
}

#[derive(Serialize)]
pub struct MarginMeta {
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<MarginAuditUser>,
}

#[derive(Serialize)]
pub struct MarginAuditUser {
    pub id: String,
    pub email: String,
    pub role: String,
}

#[derive(Serialize)]
pub struct MarginLimits {
    #[serde(rename = "maxPercent")]
    pub max_percent: i64,
    pub tiers: [&'static str; 3],
}
