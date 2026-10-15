//! Critical mutation idempotency helpers shared by live SQL routes.
//!
//! Durable orchestration state lives in PostgreSQL (`guest_checkout_idempotency`,
//! `financial_requests`); this module keeps the key-extraction, digest and shared
//! response contracts that those SQL routes depend on.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
struct ErrorMessage {
    message: &'static str,
}

pub const ROUTE_BALANCE_ADJUST: &str = "users.balance.adjust";
pub const ROUTE_GUEST_CHECKOUT: &str = "guest_transactions.create";
pub const IDEMPOTENCY_HEADER: &str = "idempotency-key";

const MAX_KEY_LEN: usize = 128;
const MIN_KEY_LEN: usize = 8;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
pub enum IdempotencyError {
    MissingKey,
    InvalidKey,
    Store,
    ResponseTooLarge,
}

impl IdempotencyError {
    pub fn into_response(self) -> Response {
        match self {
            Self::MissingKey => (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    message: "Header Idempotency-Key wajib untuk mutasi finansial ini",
                }),
            )
                .into_response(),
            Self::InvalidKey => (
                StatusCode::BAD_REQUEST,
                Json(ErrorMessage {
                    message: "Header Idempotency-Key tidak valid",
                }),
            )
                .into_response(),
            Self::Store | Self::ResponseTooLarge => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorMessage {
                    message: "Internal Server Error",
                }),
            )
                .into_response(),
        }
    }
}

pub fn critical_idempotency_enforced() -> bool {
    match std::env::var("CRITICAL_MUTATION_IDEMPOTENCY_ENFORCED") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
        // Task 12 rollout: enforce by default once the service is deployed.
        Err(_) => true,
    }
}

pub fn normalize_idempotency_key(raw: &str) -> Result<String, IdempotencyError> {
    let trimmed = raw.trim();
    if trimmed.len() < MIN_KEY_LEN || trimmed.len() > MAX_KEY_LEN {
        return Err(IdempotencyError::InvalidKey);
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(IdempotencyError::InvalidKey);
    }
    Ok(trimmed.to_string())
}

pub fn extract_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, IdempotencyError> {
    let mut found: Option<String> = None;
    for (name, value) in headers.iter() {
        if name.as_str().eq_ignore_ascii_case(IDEMPOTENCY_HEADER) {
            let Ok(text) = value.to_str() else {
                return Err(IdempotencyError::InvalidKey);
            };
            if found.is_some() {
                return Err(IdempotencyError::InvalidKey);
            }
            found = Some(text.to_string());
        }
    }
    match found {
        None => Ok(None),
        Some(raw) => Ok(Some(normalize_idempotency_key(&raw)?)),
    }
}

pub fn require_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, IdempotencyError> {
    match extract_idempotency_key(headers)? {
        Some(key) => Ok(Some(key)),
        None if critical_idempotency_enforced() => Err(IdempotencyError::MissingKey),
        None => Ok(None),
    }
}

/// Canonical request material for HMAC digest. Never includes secrets or full bodies.
pub fn sha256_hex(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn request_digest(hmac_key: &[u8], route_key: &str, parts: &[&str]) -> String {
    // Compatibility contract: balance rows and durable domain markers use this exact
    // v1 framing and must remain recoverable after upgrades.
    let mut mac = HmacSha256::new_from_slice(hmac_key).expect("HMAC accepts keys of any size");
    mac.update(b"idempotency:v1\0");
    mac.update(route_key.as_bytes());
    for part in parts {
        mac.update(b"\0");
        mac.update(part.as_bytes());
    }
    let result = mac.finalize().into_bytes();
    URL_SAFE_NO_PAD.encode(result)
}

pub fn balance_adjust_digest(
    hmac_key: &[u8],
    target_user_id: &str,
    adjustment_type: &str,
    amount: f64,
    reason: &str,
) -> String {
    // Fixed-point amount avoids float textual ambiguity.
    let amount_millis = (amount * 1000.0).round() as i64;
    request_digest(
        hmac_key,
        ROUTE_BALANCE_ADJUST,
        &[
            target_user_id,
            adjustment_type,
            &amount_millis.to_string(),
            reason,
        ],
    )
}

pub fn conflict_response() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Idempotency-Key bentrok dengan permintaan berbeda",
            "error": { "code": "IDEMPOTENCY_KEY_CONFLICT", "message": "Idempotency-Key bentrok dengan permintaan berbeda" }
        })),
    )
        .into_response()
}

pub fn in_progress_response() -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses",
            "error": { "code": "IDEMPOTENCY_IN_PROGRESS", "message": "Permintaan dengan Idempotency-Key yang sama sedang diproses" }
        })),
    )
        .into_response()
}

pub fn bound_response_body(body: &Value) -> Result<String, IdempotencyError> {
    let encoded = serde_json::to_string(body).map_err(|_| IdempotencyError::Store)?;
    if encoded.len() > MAX_RESPONSE_BYTES {
        return Err(IdempotencyError::ResponseTooLarge);
    }
    Ok(encoded)
}
