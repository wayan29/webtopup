use mongodb::bson::{doc, Bson, Document};

use crate::utils::bson::read_string;

use super::types::VendorCredentials;
use super::IfEmpty;

pub(super) async fn find_vendor_by_name(
    client: &mongodb::Client,
    db_name: &str,
    name: &str,
) -> Option<Document> {
    client
        .database(db_name)
        .collection::<Document>("vendors")
        .find_one(doc! { "name": { "$regex": name, "$options": "i" } })
        .await
        .ok()
        .flatten()
}

pub(super) fn digiflazz_credentials(vendor: Option<&Document>) -> VendorCredentials {
    let config = vendor.and_then(|doc| doc.get_document("config").ok());
    VendorCredentials {
        username: config
            .and_then(|doc| normalized_config_string(doc, "username"))
            .or_else(|| env_string("DIGIFLAZZ_USERNAME"))
            .unwrap_or_default(),
        secret: config
            .and_then(|doc| normalized_config_string(doc, "apiKey"))
            .or_else(|| env_string("DIGIFLAZZ_API_KEY"))
            .unwrap_or_default(),
    }
}

pub(super) fn tokovoucher_credentials(vendor: Option<&Document>) -> VendorCredentials {
    let config = vendor.and_then(|doc| doc.get_document("config").ok());
    VendorCredentials {
        username: config
            .and_then(|doc| {
                normalized_config_string(doc, "memberCode")
                    .or_else(|| normalized_config_string(doc, "apiKey"))
            })
            .or_else(|| env_string("TOKOVOUCHER_MEMBER_CODE"))
            .or_else(|| env_string("TOKOVOUCHER_API_KEY"))
            .unwrap_or_default(),
        secret: config
            .and_then(|doc| normalized_config_string(doc, "secret"))
            .or_else(|| env_string("TOKOVOUCHER_SECRET"))
            .unwrap_or_default(),
    }
}

pub(super) fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn vendor_base_url(vendor: &Document, fallback: &str) -> String {
    read_string(vendor, "apiBaseUrl")
        .trim()
        .to_string()
        .if_empty(fallback)
}

pub(super) fn short_mask(value: &str) -> String {
    let prefix = value.chars().take(4).collect::<String>();
    format!("{}***", prefix)
}

pub(super) fn normalized_config_string(config: &Document, key: &str) -> Option<String> {
    config
        .get_str(key)
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn normalize_payload_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!(
            "***{}",
            value
                .chars()
                .rev()
                .take(4)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        )
    }
}

pub(super) fn has_any_non_empty_value(config: &Document) -> bool {
    config.iter().any(|(_, value)| match value {
        Bson::String(text) => !text.trim().is_empty(),
        Bson::Null => false,
        _ => true,
    })
}
