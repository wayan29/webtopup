use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Deserialize)]
pub struct OperatorValidationPayload {
    #[serde(rename = "phoneNumber")]
    pub phone_number: Option<String>,
}

#[derive(Deserialize)]
pub struct FreeFireValidationPayload {
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
}

#[derive(Deserialize)]
pub struct MobileLegendsValidationPayload {
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    #[serde(rename = "zoneId")]
    pub zone_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ValidationResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<OperatorValidationData>,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct GameValidationResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<GameValidationData>,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct GameValidationData {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "zoneId", skip_serializing_if = "Option::is_none")]
    pub zone_id: Option<String>,
    pub nickname: String,
}

#[derive(Clone, Serialize)]
pub struct OperatorValidationData {
    #[serde(rename = "phoneNumber")]
    pub phone_number: String,
    #[serde(rename = "originalNumber")]
    pub original_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<&'static str>,
}

pub struct OperatorInfo {
    pub name: &'static str,
    pub prefixes: &'static [&'static str],
    pub color: &'static str,
}

#[derive(Clone)]
pub struct CachedValidation {
    pub expires_at: Instant,
    pub status: StatusCode,
    pub payload: ValidationResponse,
}

#[derive(Clone)]
pub struct CachedGameValidation {
    pub expires_at: Instant,
    pub status: StatusCode,
    pub payload: GameValidationResponse,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NicknameResultKind {
    Success,
    NotFound,
    ProviderError,
}

pub struct NicknameResult {
    pub is_success: bool,
    pub kind: NicknameResultKind,
    pub nickname: Option<String>,
    pub message: Option<String>,
}

pub struct NormalizedDigit {
    pub value: Option<String>,
    pub message: Option<String>,
}

pub struct NormalizedPhone {
    pub value: Option<String>,
    pub original: Option<String>,
    pub message: Option<String>,
}
