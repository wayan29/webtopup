use mongodb::bson::{Bson, Document};

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

pub fn sanitize_audit_document(document: &Document) -> Document {
    sanitize_document_with_context(document, AuditSanitizeContext::Default)
}

/// Sanitize a slider domain audit while retaining the nonsecret full-order integrity evidence.
/// The exception is deliberately scoped to the exact top-level `ordering` object and its three
/// required evidence keys; arbitrary digest-like authorization fields remain redacted.
pub fn sanitize_slider_audit_document(document: &Document) -> Document {
    sanitize_document_with_context(document, AuditSanitizeContext::SliderRoot)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuditSanitizeContext {
    Default,
    SliderRoot,
    SliderOrdering,
}

fn sanitize_document_with_context(
    document: &Document,
    context: AuditSanitizeContext,
) -> Document {
    match sanitize_audit_bson_with_context(
        &Bson::Document(document.clone()),
        0,
        context,
    ) {
        Bson::Document(sanitized) => sanitized,
        other => doc_with_single_value("value", other),
    }
}

pub fn sanitize_audit_bson(value: &Bson, depth: usize) -> Bson {
    sanitize_audit_bson_with_context(value, depth, AuditSanitizeContext::Default)
}

fn sanitize_audit_bson_with_context(
    value: &Bson,
    depth: usize,
    context: AuditSanitizeContext,
) -> Bson {
    if depth >= MAX_AUDIT_DEPTH {
        return Bson::String("[depth-limited]".to_string());
    }

    match value {
        Bson::Document(document) => {
            let mut sanitized = Document::new();
            for (index, (key, entry)) in document.iter().enumerate() {
                if index >= MAX_OBJECT_ENTRIES {
                    break;
                }
                let ordering_evidence = context == AuditSanitizeContext::SliderOrdering
                    && SLIDER_ORDERING_EVIDENCE_KEYS.contains(&key.as_str());
                if is_sensitive_audit_metadata_key(key) && !ordering_evidence {
                    sanitized.insert(key, Bson::String(AUDIT_REDACTION.to_string()));
                } else {
                    let child_context = if context == AuditSanitizeContext::SliderRoot
                        && key == "ordering"
                    {
                        AuditSanitizeContext::SliderOrdering
                    } else {
                        AuditSanitizeContext::Default
                    };
                    sanitized.insert(
                        key,
                        sanitize_audit_bson_with_context(entry, depth + 1, child_context),
                    );
                }
            }
            Bson::Document(sanitized)
        }
        Bson::Array(entries) => Bson::Array(
            entries
                .iter()
                .take(MAX_ARRAY_ENTRIES)
                // Arrays cannot be the exact `ordering` object path, so reset context here.
                .map(|entry| {
                    sanitize_audit_bson_with_context(
                        entry,
                        depth + 1,
                        AuditSanitizeContext::Default,
                    )
                })
                .collect(),
        ),
        Bson::String(text) if text.chars().count() > MAX_STRING_CHARS => {
            let truncated: String = text.chars().take(MAX_STRING_CHARS).collect();
            Bson::String(format!("{truncated}..."))
        }
        other => other.clone(),
    }
}

fn doc_with_single_value(key: &str, value: Bson) -> Document {
    let mut document = Document::new();
    document.insert(key, value);
    document
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, oid::ObjectId, Binary, DateTime};

    #[test]
    fn disclosure_sanitizer_redacts_pin_aliases_without_false_positives() {
        let input = doc! {
            "pin": "fixture-value",
            "Merchant-PIN": "fixture-value",
            "shipping": "visible",
            "nested": [{ "api_key": "fixture-value", "mapping": "visible" }],
        };
        let output = sanitize_audit_document(&input);
        assert_eq!(output.get_str("pin").unwrap(), AUDIT_REDACTION);
        assert_eq!(output.get_str("Merchant-PIN").unwrap(), AUDIT_REDACTION);
        assert_eq!(output.get_str("shipping").unwrap(), "visible");
        let nested = output
            .get_array("nested")
            .unwrap()
            .first()
            .and_then(Bson::as_document)
            .unwrap();
        assert_eq!(nested.get_str("api_key").unwrap(), AUDIT_REDACTION);
        assert_eq!(nested.get_str("mapping").unwrap(), "visible");
        assert!(!is_sensitive_audit_metadata_key("shipping"));
        assert!(!is_sensitive_audit_metadata_key("mapping"));
        assert!(!is_sensitive_audit_metadata_key("pinned"));
        assert!(!is_sensitive_audit_metadata_key("opinion"));
    }

    #[test]
    fn slider_audit_sanitizer_preserves_ordering_evidence_without_widening_redaction() {
        let input = doc! {
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
        };

        let output = sanitize_slider_audit_document(&input);
        let ordering = output.get_document("ordering").unwrap();
        assert_eq!(ordering.get_str("oldDigest"), Ok("old-order-integrity"));
        assert_eq!(ordering.get_str("newDigest"), Ok("new-order-integrity"));
        assert_eq!(ordering.get_str("digest"), Ok("order-transition-integrity"));
        assert_eq!(
            output.get_document("result").unwrap().get_str("evidence"),
            Ok("transaction_committed")
        );
        assert_eq!(ordering.get_str("payloadDigest"), Ok(AUDIT_REDACTION));
        assert_eq!(output.get_str("authorizationDigest"), Ok(AUDIT_REDACTION));
        assert_eq!(output.get_str("payloadDigest"), Ok(AUDIT_REDACTION));
        assert_eq!(output.get_str("digest"), Ok(AUDIT_REDACTION));

        // The shared sanitizer remains strict for arbitrary digest-like keys.
        let generic = sanitize_audit_document(&doc! {
            "ordering": { "digest": "not-slider-context" },
        });
        assert_eq!(
            generic.get_document("ordering").unwrap().get_str("digest"),
            Ok(AUDIT_REDACTION)
        );
    }

    #[test]
    fn disclosure_sanitizer_applies_limits_and_preserves_scalar_types() {
        let mut deep = doc! { "leaf": "ok" };
        for _ in 0..10 {
            deep = doc! { "child": deep };
        }
        let sanitized = sanitize_audit_document(&deep);
        // Root is depth 0; the eighth nested child is sanitized at depth 8 and becomes
        // the depth-limited marker instead of another document.
        let mut walker = &sanitized;
        for _ in 0..7 {
            walker = walker.get_document("child").unwrap();
        }
        assert_eq!(
            walker.get("child").unwrap(),
            &Bson::String("[depth-limited]".to_string())
        );

        let long_array = Bson::Array((0..60).map(Bson::from).collect());
        let sanitized_array = sanitize_audit_bson(&long_array, 0);
        assert_eq!(sanitized_array.as_array().unwrap().len(), 50);

        let mut wide = Document::new();
        for index in 0..120 {
            wide.insert(format!("k{index}"), index as i32);
        }
        let sanitized_wide = sanitize_audit_document(&wide);
        assert_eq!(sanitized_wide.len(), 100);
        assert_eq!(sanitized_wide.get_i32("k0").unwrap(), 0);
        assert_eq!(sanitized_wide.get_i32("k99").unwrap(), 99);
        assert!(sanitized_wide.get("k100").is_none());

        let long_string = "x".repeat(600);
        assert_eq!(
            sanitize_audit_bson(&Bson::String(long_string), 0),
            Bson::String(format!("{}...", "x".repeat(500)))
        );

        let object_id = ObjectId::new();
        let datetime = DateTime::now();
        let binary = Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic,
            bytes: vec![1, 2, 3],
        };
        let scalars = doc! {
            "id": object_id,
            "when": datetime,
            "blob": binary.clone(),
            "flag": true,
            "count": 7_i64,
            "empty": Bson::Null,
        };
        let sanitized_scalars = sanitize_audit_document(&scalars);
        assert_eq!(
            sanitized_scalars.get_object_id("id").unwrap(),
            object_id
        );
        assert_eq!(
            sanitized_scalars.get_datetime("when").unwrap(),
            &datetime
        );
        assert_eq!(
            sanitized_scalars.get_binary_generic("blob").unwrap(),
            &binary.bytes
        );
        assert_eq!(sanitized_scalars.get_bool("flag").unwrap(), true);
        assert_eq!(sanitized_scalars.get_i64("count").unwrap(), 7);
        assert!(matches!(sanitized_scalars.get("empty"), Some(Bson::Null)));
    }
}
