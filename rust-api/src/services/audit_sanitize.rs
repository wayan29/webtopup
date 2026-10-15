use serde_json::Value;

pub const AUDIT_REDACTION: &str = "[redacted]";
const MAX_AUDIT_DEPTH: usize = 8;
const MAX_ARRAY_ENTRIES: usize = 50;
const MAX_OBJECT_ENTRIES: usize = 100;
const MAX_STRING_CHARS: usize = 500;
const SLIDER_ORDERING_EVIDENCE_KEYS: &[&str] = &["oldDigest", "newDigest", "digest"];

const EXACT_SENSITIVE_AUDIT_KEYS: &[&str] = &[
    "password",
    "currentpassword",
    "newpassword",
    "confirmpassword",
    "pin",
    "merchantpin",
    "transactionpin",
    "securitypin",
    "apikey",
    "secret",
    "vendorsecret",
    "twofactorsecret",
    "twofactorpendingsecret",
    "otp",
    "code",
    "token",
    "authorization",
    "cookie",
    "csrftoken",
    "xcsrftoken",
    "accesstoken",
    "refreshtoken",
    "recoverytoken",
    "ciphertext",
    "nonce",
    "digest",
    "sessiontokenhashsecret",
];

pub fn normalize_audit_metadata_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

pub fn is_sensitive_audit_metadata_key(key: &str) -> bool {
    let normalized = normalize_audit_metadata_key(key);
    EXACT_SENSITIVE_AUDIT_KEYS
        .iter()
        .any(|candidate| *candidate == normalized.as_str())
        || regex_like_sensitive(&normalized)
}

fn regex_like_sensitive(normalized: &str) -> bool {
    // Matches the Node fallback after alphanumeric normalization.
    let patterns = [
        "token",
        "password",
        "secret",
        "apikey",
        "authorization",
        "cookie",
        "ciphertext",
        "otp",
        "csrf",
        "nonce",
        "digest",
    ];
    patterns.iter().any(|pattern| normalized.contains(pattern))
}

pub fn sanitize_audit_document(document: &Value) -> Value {
    sanitize_document_with_context(document, AuditSanitizeContext::Default)
}

/// Sanitize a slider domain audit while retaining the nonsecret full-order integrity evidence.
/// The exception is deliberately scoped to the exact top-level `ordering` object and its three
/// required evidence keys; arbitrary digest-like authorization fields remain redacted.
pub fn sanitize_slider_audit_document(document: &Value) -> Value {
    sanitize_document_with_context(document, AuditSanitizeContext::SliderRoot)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuditSanitizeContext {
    Default,
    SliderRoot,
    SliderOrdering,
}

fn sanitize_document_with_context(document: &Value, context: AuditSanitizeContext) -> Value {
    sanitize_audit_value_with_context(document, 0, context)
}

pub fn sanitize_audit_bson(value: &Value, depth: usize) -> Value {
    sanitize_audit_value_with_context(value, depth, AuditSanitizeContext::Default)
}

fn sanitize_audit_value_with_context(
    value: &Value,
    depth: usize,
    context: AuditSanitizeContext,
) -> Value {
    if depth >= MAX_AUDIT_DEPTH {
        return Value::String("[depth-limited]".to_string());
    }

    match value {
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for (index, (key, entry)) in map.iter().enumerate() {
                if index >= MAX_OBJECT_ENTRIES {
                    break;
                }
                let ordering_evidence = context == AuditSanitizeContext::SliderOrdering
                    && SLIDER_ORDERING_EVIDENCE_KEYS.contains(&key.as_str());
                if is_sensitive_audit_metadata_key(key) && !ordering_evidence {
                    sanitized.insert(key.clone(), Value::String(AUDIT_REDACTION.to_string()));
                } else {
                    let child_context = if context == AuditSanitizeContext::SliderRoot
                        && key == "ordering"
                    {
                        AuditSanitizeContext::SliderOrdering
                    } else {
                        AuditSanitizeContext::Default
                    };
                    sanitized.insert(
                        key.clone(),
                        sanitize_audit_value_with_context(entry, depth + 1, child_context),
                    );
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .take(MAX_ARRAY_ENTRIES)
                // Arrays cannot be the exact `ordering` object path, so reset context here.
                .map(|entry| {
                    sanitize_audit_value_with_context(
                        entry,
                        depth + 1,
                        AuditSanitizeContext::Default,
                    )
                })
                .collect(),
        ),
        Value::String(text) if text.chars().count() > MAX_STRING_CHARS => {
            let truncated: String = text.chars().take(MAX_STRING_CHARS).collect();
            Value::String(format!("{truncated}..."))
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disclosure_sanitizer_redacts_pin_aliases_without_false_positives() {
        let input = json!({
            "pin": "fixture-value",
            "Merchant-PIN": "fixture-value",
            "shipping": "visible",
            "nested": [{ "api_key": "fixture-value", "mapping": "visible" }],
        });
        let output = sanitize_audit_document(&input);
        assert_eq!(output["pin"], AUDIT_REDACTION);
        assert_eq!(output["Merchant-PIN"], AUDIT_REDACTION);
        assert_eq!(output["shipping"], "visible");
        let nested = &output["nested"][0];
        assert_eq!(nested["api_key"], AUDIT_REDACTION);
        assert_eq!(nested["mapping"], "visible");
        assert!(!is_sensitive_audit_metadata_key("shipping"));
        assert!(!is_sensitive_audit_metadata_key("mapping"));
        assert!(!is_sensitive_audit_metadata_key("pinned"));
        assert!(!is_sensitive_audit_metadata_key("opinion"));
    }

    #[test]
    fn slider_audit_sanitizer_preserves_ordering_evidence_without_widening_redaction() {
        let input = json!({
            "ordering": {
                "oldDigest": "old-order-integrity",
                "newDigest": "new-order-integrity",
                "digest": "order-transition-integrity",
                "payloadDigest": "ordering-secret",
            },
            "result": { "evidence": "transaction_committed" },
            "authorizationDigest": "authorization-secret",
            "payloadDigest": "payload-secret",
            "digest": "generic-secret",
        });

        let output = sanitize_slider_audit_document(&input);
        let ordering = &output["ordering"];
        assert_eq!(ordering["oldDigest"], "old-order-integrity");
        assert_eq!(ordering["newDigest"], "new-order-integrity");
        assert_eq!(ordering["digest"], "order-transition-integrity");
        assert_eq!(output["result"]["evidence"], "transaction_committed");
        assert_eq!(ordering["payloadDigest"], AUDIT_REDACTION);
        assert_eq!(output["authorizationDigest"], AUDIT_REDACTION);
        assert_eq!(output["payloadDigest"], AUDIT_REDACTION);
        assert_eq!(output["digest"], AUDIT_REDACTION);

        // The shared sanitizer remains strict for arbitrary digest-like keys.
        let generic = sanitize_audit_document(&json!({
            "ordering": { "digest": "not-slider-context" },
        }));
        assert_eq!(generic["ordering"]["digest"], AUDIT_REDACTION);
    }

    #[test]
    fn disclosure_sanitizer_applies_limits_and_preserves_scalar_types() {
        let mut deep = json!({ "leaf": "ok" });
        for _ in 0..10 {
            deep = json!({ "child": deep });
        }
        let sanitized = sanitize_audit_document(&deep);
        // Root is depth 0; the eighth nested child is sanitized at depth 8 and becomes
        // the depth-limited marker instead of another document.
        let mut walker = &sanitized;
        for _ in 0..7 {
            walker = &walker["child"];
        }
        assert_eq!(walker["child"], "[depth-limited]");

        let long_array = Value::Array((0..60).map(|value| json!(value)).collect());
        let sanitized_array = sanitize_audit_bson(&long_array, 0);
        assert_eq!(sanitized_array.as_array().unwrap().len(), 50);

        let mut wide = serde_json::Map::new();
        for index in 0..120 {
            wide.insert(format!("k{index}"), json!(index));
        }
        let sanitized_wide = sanitize_audit_document(&Value::Object(wide.clone()));
        let map = sanitized_wide.as_object().unwrap();
        assert_eq!(map.len(), 100);
        assert!(map.keys().all(|key| {
            let index = key.strip_prefix('k').and_then(|value| value.parse::<usize>().ok());
            index.is_some_and(|index| index < 120)
        }));
        assert!(map.len() < wide.len());
        let long_string = "x".repeat(600);
        assert_eq!(
            sanitize_audit_bson(&Value::String(long_string), 0),
            Value::String(format!("{}...", "x".repeat(500)))
        );

        let scalars = json!({
            "flag": true,
            "count": 7_i64,
            "ratio": 0.5,
            "empty": Value::Null,
        });
        let sanitized_scalars = sanitize_audit_document(&scalars);
        assert_eq!(sanitized_scalars["flag"], json!(true));
        assert_eq!(sanitized_scalars["count"], json!(7));
        assert_eq!(sanitized_scalars["ratio"], json!(0.5));
        assert!(sanitized_scalars["empty"].is_null());
    }
}
