use mongodb::bson::Document;

use crate::utils::bson::read_string;

use super::types::WebhookLogItem;

pub fn webhook_log_from_doc(document: Document, provider: &str) -> WebhookLogItem {
    WebhookLogItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        timestamp: date_string(&document, "createdAt"),
        event: read_string(&document, "event").if_empty(provider),
        ref_id: read_string(&document, "refId"),
        status: read_string(&document, "status"),
        message: read_string(&document, "message"),
        verified: document.get_bool("verified").unwrap_or(false),
    }
}

pub fn config_string(config: &Document, key: &str) -> Option<String> {
    config
        .get_str(key)
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn has_whitelist(value: &str) -> bool {
    value
        .split(',')
        .map(str::trim)
        .any(|value| !value.is_empty())
}

pub fn normalize_whitelist(value: &str) -> String {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

pub fn protection_mode(has_signature: bool, has_whitelist: bool) -> &'static str {
    if has_signature {
        "signature"
    } else if has_whitelist {
        "ip_only"
    } else {
        "unprotected"
    }
}

fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}
