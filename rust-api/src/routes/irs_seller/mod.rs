mod admin;
mod prepaid;
mod settings;
mod types;

pub use admin::{admin_orders, delete_mapping, logs, mappings, save_mapping};
pub use prepaid::prepaid;
pub use settings::{save_settings, settings};
pub(crate) use settings::stored_config;

use axum::{
    http::HeaderMap,
    response::IntoResponse,
    response::Response,
    Json,
};
use mongodb::bson::Document;

use crate::{security::ErrorResponse, utils::bson::read_string};

pub(super) const CONFIG_KEY: &str = "irsSellerConfig";
pub(super) const DEFAULT_ENDPOINT: &str = "https://v1.apigames.id/v2/transaksi-irs";
pub(super) const DEFAULT_PREPAID_PATH: &str = "/v2/irs-seller/prepaid";
pub(super) const IRS_PROVIDER: &str = "irs_seller";

pub(super) fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next_back())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

pub(super) fn ip_matches_rule(client_ip: &str, rule: &str) -> bool {
    if client_ip == rule {
        return true;
    }
    let Some((range_ip, prefix)) = rule.split_once('/') else {
        return false;
    };
    let Ok(client) = client_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(range) = range_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    if prefix > 32 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(client) & mask) == (u32::from(range) & mask)
}

pub(super) fn string_array(document: &Document, key: &str) -> Vec<String> {
    document
        .get_array(key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

pub(super) fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub(super) fn unavailable() -> Response {
    status_message(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "Service Unavailable",
    )
}

pub(super) trait EmptyStringFallback {
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

pub(super) fn document_id(document: &Document) -> String {
    document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default()
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    match document.get(key) {
        Some(mongodb::bson::Bson::DateTime(value)) => value
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| value.to_string()),
        _ => read_string(document, key),
    }
}
