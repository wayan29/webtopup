//! Seller secrecy boundaries.
//!
//! New Digiflazz/IRS seller order and event-log writes must contain only
//! allowlisted operational fields. Credentials, signatures, raw request
//! bodies, and unknown nested keys must never be persisted.

use mongodb::bson::{doc, DateTime, Document};
use serde_json::Value;

/// Policy table for tests/hygiene verification only; the request path never
/// needs detector-based redaction because builders are allowlist-only.
#[cfg_attr(not(test), allow(dead_code))]
const SENSITIVE_SELLER_KEYS: &[&str] = &[
    "apikey",
    "api_key",
    "sign",
    "signature",
    "secret",
    "password",
    "pass",
    "pin",
    "authorization",
    "cookie",
    "x-step-up-token",
    "granttoken",
];

const MAX_REF_ID_CHARS: usize = 120;
const MAX_STATUS_CHARS: usize = 32;
const MAX_MESSAGE_CHARS: usize = 300;
const MAX_REQUEST_IP_CHARS: usize = 120;

fn bounded(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

pub fn safe_seller_event_document(
    provider: &str,
    event: &str,
    ref_id: &str,
    status: &str,
    message: &str,
    verified: bool,
    request_ip: &str,
) -> Document {
    let now = DateTime::now();
    doc! {
        "provider": provider,
        "event": event,
        "refId": bounded(ref_id, MAX_REF_ID_CHARS),
        "status": bounded(status, MAX_STATUS_CHARS),
        "message": bounded(message, MAX_MESSAGE_CHARS),
        "verified": verified,
        "requestIp": bounded(request_ip, MAX_REQUEST_IP_CHARS),
        "createdAt": now,
        "updatedAt": now,
    }
}

/// Detector used by secrecy policy tests and hygiene verification. Runtime
/// writes remain allowlist-only and do not depend on this check.
#[cfg_attr(not(test), allow(dead_code))]
pub fn contains_sensitive_seller_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            SENSITIVE_SELLER_KEYS.contains(&key.trim().to_ascii_lowercase().as_str())
                || contains_sensitive_seller_key(child)
        }),
        Value::Array(items) => items.iter().any(contains_sensitive_seller_key),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_event_contains_only_allowlisted_operational_fields() {
        let event = safe_seller_event_document(
            "digiflazz_seller",
            "request",
            "ref-1",
            "failed",
            "Wrong authentication",
            false,
            "127.0.0.1",
        );
        assert_eq!(
            event.keys().cloned().collect::<std::collections::BTreeSet<_>>(),
            [
                "provider",
                "event",
                "refId",
                "status",
                "message",
                "verified",
                "requestIp",
                "createdAt",
                "updatedAt"
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        );
        assert!(!event.contains_key("raw"));
        assert!(!event.contains_key("rawRequest"));
    }

    #[test]
    fn nested_seller_secret_aliases_are_detected_case_insensitively() {
        let value = serde_json::json!({"data":{"PASS":"fixture", "pin":"fixture"}});
        assert!(contains_sensitive_seller_key(&value));
        assert!(!contains_sensitive_seller_key(
            &serde_json::json!({"refId":"safe", "target":"0812"})
        ));
    }
}
