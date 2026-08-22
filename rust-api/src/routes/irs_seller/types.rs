use mongodb::bson::{doc, Document};
use serde::Serialize;
use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::utils::bson::read_string;

const MAX_FORMATTER_MARKER_BYTES: usize = 80;

/// Validate a client-supplied IRS formatter before persistence. Only bounded
/// literal `sn.start`/`sn.end` markers are accepted; every other key,
/// including any credential alias, is rejected.
pub(super) fn validated_irs_formatter(
    value: Option<&Value>,
) -> Result<Option<Document>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Value::Object(map) = value else {
        return Err("formatter must be an object");
    };
    if map.keys().any(|key| key != "sn") {
        return Err("only sn markers are allowed");
    }
    let Some(sn) = map.get("sn") else {
        return Ok(Some(doc! {"sn": {"start": "", "end": ""}}));
    };
    let Value::Object(sn) = sn else {
        return Err("sn must be an object");
    };
    if sn.keys().any(|key| key != "start" && key != "end") {
        return Err("only sn.start and sn.end are allowed");
    };
    let mut start = String::new();
    let mut end = String::new();
    for (key, slot) in [("start", &mut start), ("end", &mut end)] {
        if let Some(value) = sn.get(key) {
            let Some(text) = value.as_str() else {
                return Err("sn markers must be strings");
            };
            if text.len() > MAX_FORMATTER_MARKER_BYTES {
                return Err("sn markers must be at most 80 bytes");
            }
            *slot = text.to_string();
        }
    }
    Ok(Some(doc! {"sn": {"start": start, "end": end}}))
}

/// Exact-length check followed by a constant-time comparison. An empty stored
/// expected value is never a match.
pub(super) fn constant_time_required_match(
    payload: Option<&Value>,
    config: &Document,
    aliases: &[&str],
    config_key: &str,
) -> bool {
    let Some(payload) = payload else {
        return false;
    };
    let expected = read_string(config, config_key);
    if expected.is_empty() {
        return false;
    }
    let Some(provided) = text_value(payload, aliases) else {
        return false;
    };
    let left = provided.as_bytes();
    let right = expected.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).into()
}

pub(super) fn irs_admin_order_item(order: &Document) -> IrsAdminOrderItem {
    IrsAdminOrderItem {
        id: super::document_id(order),
        ref_id: read_string(order, "refId"),
        internal_ref_id: read_string(order, "internalRefId")
            .if_empty_owned(read_string(order, "idTrx")),
        irs_code: read_string(order, "irsCode").if_empty_owned(read_string(order, "productCode")),
        target: read_string(order, "target"),
        status: read_string(order, "status"),
        status_code: read_string(order, "statusCode"),
        message: read_string(order, "message"),
        sn: read_string(order, "sn"),
        vendor_trx_id: read_string(order, "vendorTrxId"),
        request_ip: read_string(order, "requestIp"),
        created_at: super::date_string(order, "createdAt"),
        updated_at: super::date_string(order, "updatedAt"),
    }
}

pub(super) fn irs_log_item(log: &Document) -> IrsLogItem {
    IrsLogItem {
        id: super::document_id(log),
        timestamp: super::date_string(log, "createdAt"),
        event: read_string(log, "event").if_empty_owned("request".to_string()),
        ref_id: read_string(log, "refId"),
        status: read_string(log, "status"),
        message: read_string(log, "message"),
        verified: log.get_bool("verified").unwrap_or(false),
        request_ip: read_string(log, "requestIp"),
    }
}

trait OwnedFallback {
    fn if_empty_owned(self, fallback: String) -> String;
}

impl OwnedFallback for String {
    fn if_empty_owned(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

#[derive(Serialize)]
pub(super) struct IrsSettingsResponse {
    pub(super) configured: bool,
    pub(super) ready: bool,
    pub(super) enabled: bool,
    #[serde(rename = "merchantId")]
    pub(super) merchant_id: String,
    #[serde(rename = "passwordConfigured")]
    pub(super) password_configured: bool,
    #[serde(rename = "pinConfigured")]
    pub(super) pin_configured: bool,
    #[serde(rename = "secretConfigured")]
    pub(super) secret_configured: bool,
    #[serde(rename = "endpointUrl")]
    pub(super) endpoint_url: String,
    #[serde(rename = "allowedIps")]
    pub(super) allowed_ips: Vec<String>,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: i64,
    #[serde(rename = "callbackEnabled")]
    pub(super) callback_enabled: bool,
    #[serde(rename = "callbackUrl")]
    pub(super) callback_url: String,
    #[serde(rename = "prepaidEndpointPath")]
    pub(super) prepaid_endpoint_path: String,
    #[serde(rename = "mappingSummary")]
    pub(super) mapping_summary: IrsMappingSummary,
    pub(super) formatter: IrsFormatterMarkers,
}

#[derive(Serialize)]
pub(super) struct IrsFormatterMarkers {
    pub(super) sn: IrsFormatterSnMarkers,
}

#[derive(Serialize)]
pub(super) struct IrsFormatterSnMarkers {
    pub(super) start: String,
    pub(super) end: String,
}

#[derive(Serialize)]
pub(super) struct IrsMappingSummary {
    pub(super) active: i64,
}

#[derive(Serialize)]
pub(super) struct IrsAdminOrdersResponse {
    pub(super) items: Vec<IrsAdminOrderItem>,
}

#[derive(Serialize)]
pub(super) struct IrsAdminOrderItem {
    pub(super) id: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    #[serde(rename = "internalRefId")]
    pub(super) internal_ref_id: String,
    #[serde(rename = "irsCode")]
    pub(super) irs_code: String,
    pub(super) target: String,
    pub(super) status: String,
    #[serde(rename = "statusCode")]
    pub(super) status_code: String,
    pub(super) message: String,
    pub(super) sn: String,
    #[serde(rename = "vendorTrxId")]
    pub(super) vendor_trx_id: String,
    #[serde(rename = "requestIp")]
    pub(super) request_ip: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct IrsLogItem {
    pub(super) id: String,
    pub(super) timestamp: String,
    pub(super) event: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    pub(super) status: String,
    pub(super) message: String,
    pub(super) verified: bool,
    #[serde(rename = "requestIp")]
    pub(super) request_ip: String,
}

pub(super) fn text_value(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(|value| match value {
                Value::String(value) => Some(value.trim().to_string()),
                Value::Number(value) => Some(value.to_string()),
                Value::Bool(value) => Some(value.to_string()),
                _ => None,
            })
            .filter(|value| !value.is_empty())
    })
}

pub(super) fn bool_value(payload: &Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(|value| match value {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

pub(super) fn i64_value(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(|value| match value {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn text_from_json(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

pub(super) fn string_list_value(payload: &Value, key: &str) -> Option<Vec<String>> {
    match payload.get(key)? {
        Value::Array(values) => Some(values.iter().filter_map(text_from_json).collect()),
        Value::String(value) => Some(
            value
                .split([',', ';', '\n'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect(),
        ),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct SaveIrsSettingsPayload {
    pub(super) enabled: Option<bool>,
    pub(super) merchant_id: Option<String>,
    pub(super) password: Option<String>,
    pub(super) pin: Option<String>,
    pub(super) secret: Option<String>,
    pub(super) endpoint_url: Option<String>,
    pub(super) allowed_ips: Option<Vec<String>>,
    pub(super) seller_margin_flat: Option<i64>,
    pub(super) callback_enabled: Option<bool>,
    pub(super) callback_url: Option<String>,
    pub(super) formatter: Option<Value>,
}

impl SaveIrsSettingsPayload {
    /// Extract the typed save payload, preserving the established public/admin
    /// alias spellings (merchant_id, pass, id) while never trusting types.
    pub(super) fn from_value(payload: &Value) -> Self {
        Self {
            enabled: bool_value(payload, "enabled"),
            merchant_id: text_value(payload, &["merchantId", "merchant_id"]),
            password: text_value(payload, &["password", "pass"]),
            pin: text_value(payload, &["pin"]),
            secret: text_value(payload, &["secret", "id"]),
            endpoint_url: text_value(payload, &["endpointUrl"]),
            allowed_ips: string_list_value(payload, "allowedIps"),
            seller_margin_flat: i64_value(payload, "sellerMarginFlat"),
            callback_enabled: bool_value(payload, "callbackEnabled"),
            callback_url: text_value(payload, &["callbackUrl"]),
            formatter: payload.get("formatter").cloned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_response_fixture(
        merchant: &str,
        password: &str,
        pin: &str,
        secret: &str,
    ) -> super::IrsSettingsResponse {
        let config = doc! {
            "enabled": true,
            "merchantId": merchant,
            "password": password,
            "pin": pin,
            "secret": secret,
            "endpointUrl": "https://fixture.invalid",
            "allowedIps": ["127.0.0.1"],
            "sellerMarginFlat": 250_i64,
            "callbackEnabled": false,
            "callbackUrl": "",
        };
        crate::routes::irs_seller::settings::irs_settings_response(&config, 3)
    }

    #[test]
    fn settings_response_exposes_configured_flags_not_secret_fragments() {
        let response = settings_response_fixture(
            "merchant",
            "password-fixture",
            "1234",
            "secret-fixture",
        );
        let json = serde_json::to_value(response).unwrap();
        let text = json.to_string();
        assert_eq!(json["merchantId"], "merchant");
        assert_eq!(json["passwordConfigured"], true);
        assert_eq!(json["pinConfigured"], true);
        assert_eq!(json["secretConfigured"], true);
        for key in ["passwordMasked", "pinMasked", "secretMasked"] {
            assert!(json.get(key).is_none(), "{key} must never serialize");
        }
        for secret in ["password-fixture", "1234", "secret-fixture"] {
            assert!(!text.contains(secret), "secret fragment leaked: {secret}");
        }
    }

    #[test]
    fn settings_response_exposes_nonsecret_formatter_markers() {
        let mut config = doc! {
            "enabled": true,
            "merchantId": "merchant",
            "password": "password-fixture",
            "pin": "1234",
            "secret": "secret-fixture",
            "endpointUrl": "https://fixture.invalid",
            "allowedIps": ["127.0.0.1"],
            "sellerMarginFlat": 250_i64,
            "callbackEnabled": false,
            "callbackUrl": "",
            "formatter": { "sn": { "start": "SN:", "end": "Saldo" } },
        };
        let json = serde_json::to_value(crate::routes::irs_seller::settings::irs_settings_response(
            &config, 3,
        ))
        .unwrap();
        assert_eq!(json["formatter"]["sn"]["start"], "SN:");
        assert_eq!(json["formatter"]["sn"]["end"], "Saldo");
        assert!(!json.to_string().contains("password-fixture"));

        config.remove("formatter");
        let json = serde_json::to_value(crate::routes::irs_seller::settings::irs_settings_response(
            &config, 3,
        ))
        .unwrap();
        assert_eq!(json["formatter"]["sn"]["start"], "");
        assert_eq!(json["formatter"]["sn"]["end"], "");
    }

    #[test]
    fn formatter_accepts_only_bounded_sn_markers() {
        assert!(validated_irs_formatter(Some(&serde_json::json!({
            "sn": { "start": "SN:", "end": "Saldo" }
        })))
        .is_ok());
        assert!(validated_irs_formatter(Some(&serde_json::json!({
            "password": "alias"
        })))
        .is_err());
        assert!(validated_irs_formatter(Some(&serde_json::json!({
            "sn": { "start": "x".repeat(81) }
        })))
        .is_err());
        assert!(validated_irs_formatter(Some(&serde_json::json!({
            "sn": { "start": 12 }
        })))
        .is_err());
        assert!(validated_irs_formatter(None).unwrap().is_none());
    }

    #[test]
    fn admin_order_item_serialization_is_allowlisted() {
        let mut order = doc! {
            "refId": "ref-1",
            "idTrx": "internal-1",
            "irsCode": "tsel10",
            "target": "081200000000",
            "status": "success",
            "statusCode": "1",
            "message": "BERHASIL",
            "sn": "SN0001",
            "requestIp": "127.0.0.1",
        };
        order.insert("rawRequest", doc! { "pin": "fixture" });
        order.insert("password", "fixture");
        order.insert("unknownField", "fixture");
        order.insert("raw", doc! { "secret": "fixture" });
        order.insert("createdAt", mongodb::bson::DateTime::from_millis(0));
        order.insert("updatedAt", mongodb::bson::DateTime::from_millis(0));

        let json = serde_json::to_value(irs_admin_order_item(&order)).unwrap();
        let text = json.to_string();
        for forbidden in ["rawRequest", "password", "unknownField", "raw", "fixture"] {
            assert!(!text.contains(forbidden), "forbidden content leaked: {forbidden}");
        }
        assert_eq!(json["id"], "");
        assert_eq!(json["refId"], "ref-1");
        assert_eq!(json["internalRefId"], "internal-1");
    }

    #[test]
    fn log_item_serialization_is_allowlisted() {
        let mut log = doc! {
            "event": "request",
            "refId": "ref-1",
            "status": "failed",
            "message": "Wrong authentication",
            "verified": false,
            "requestIp": "127.0.0.1",
        };
        log.insert("raw", doc! { "secret": "fixture" });
        log.insert("password", "fixture");
        log.insert("createdAt", mongodb::bson::DateTime::from_millis(0));

        let json = serde_json::to_value(irs_log_item(&log)).unwrap();
        let text = json.to_string();
        for forbidden in ["raw", "password", "fixture"] {
            assert!(!text.contains(forbidden), "forbidden content leaked: {forbidden}");
        }
        assert_eq!(json["refId"], "ref-1");
        assert_eq!(json["verified"], false);
    }

    #[test]
    fn credential_comparison_is_exact_length_then_constant_time() {
        let payload = serde_json::json!({"password": "pw-fixture"});
        let mut config = doc! { "password": "pw-fixture" };
        assert!(constant_time_required_match(
            Some(&payload),
            &config,
            &["password", "pass"],
            "password"
        ));
        config.insert("password", "pw-fixture-differs");
        assert!(!constant_time_required_match(
            Some(&payload),
            &config,
            &["password", "pass"],
            "password"
        ));
        config.insert("password", "pw");
        assert!(!constant_time_required_match(
            Some(&payload),
            &config,
            &["password", "pass"],
            "password"
        ));
        config.insert("password", "");
        assert!(!constant_time_required_match(
            Some(&payload),
            &config,
            &["password", "pass"],
            "password"
        ));
    }

    #[test]
    fn public_storage_unavailable_message_is_generic() {
        let source = include_str!("prepaid.rs");
        assert!(!source.contains("MONGO_URI is not configured"));
    }

    #[test]
    fn admin_unavailable_never_mentions_mongo_uri() {
        let source = include_str!("mod.rs");
        assert!(
            !source.contains("MONGO_URI is not configured"),
            "IRS admin unavailable() must not leak Mongo configuration"
        );
        assert!(
            source.contains("Service Unavailable") || source.contains("tidak tersedia"),
            "IRS admin unavailable() must use a generic storage message"
        );
    }
}
