use mongodb::bson::{Bson, Document};

pub const AUDIT_REDACTION: &str = "[redacted]";
const MAX_AUDIT_DEPTH: usize = 8;
const MAX_ARRAY_ENTRIES: usize = 50;
const MAX_OBJECT_ENTRIES: usize = 100;
const MAX_STRING_CHARS: usize = 500;

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
    match sanitize_audit_bson(&Bson::Document(document.clone()), 0) {
        Bson::Document(sanitized) => sanitized,
        other => doc_with_single_value("value", other),
    }
}

pub fn sanitize_audit_bson(value: &Bson, depth: usize) -> Bson {
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
                if is_sensitive_audit_metadata_key(key) {
                    sanitized.insert(key, Bson::String(AUDIT_REDACTION.to_string()));
                } else {
                    sanitized.insert(key, sanitize_audit_bson(entry, depth + 1));
                }
            }
            Bson::Document(sanitized)
        }
        Bson::Array(entries) => Bson::Array(
            entries
                .iter()
                .take(MAX_ARRAY_ENTRIES)
                .map(|entry| sanitize_audit_bson(entry, depth + 1))
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
