//! Bulk Site Config mutation policy: sensitive keys, canonical digest, effective changes.

use serde::Deserialize;
use serde_json::{Map, Value};
use super::{
    defaults::default_site_settings,
    snapshot::SITE_CONFIG_REVISION_KEY,
    validation::validate_setting_json_value_for_policy,
};
use crate::services::idempotency::sha256_hex;

/// Exact approved sensitive inventory for `settings.sensitive`.
pub const SENSITIVE_SITE_SETTING_KEYS: &[&str] = &[
    "maintenanceMode",
    "registrationEnabled",
    "guestCheckoutEnabled",
    "minDeposit",
    "maxDeposit",
    "depositFee",
    "depositFeeType",
    "refIdPrefix",
    "refIdDateFormat",
    "refIdSeparator",
    "refIdSequenceDigits",
    "invoicePrefix",
    "invoiceDateFormat",
    "invoiceSeparator",
    "invoiceRandomLength",
    "invoiceRandomType",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkSettingsUpdatePayload {
    pub expected_revision: i64,
    pub changes: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedSettingsIntent {
    pub expected_revision: i64,
    pub normalized_changes: Map<String, Value>,
    pub effective_changes: Map<String, Value>,
    pub digest: String,
    pub requires_step_up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsPolicyError {
    InvalidRevision,
    EmptyChanges,
    UnknownKey,
    ReservedKey,
    InvalidValue,
    CrossField,
}

impl SettingsPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRevision => "SETTINGS_INVALID_REVISION",
            Self::EmptyChanges => "SETTINGS_EMPTY_CHANGES",
            Self::UnknownKey => "SETTINGS_UNKNOWN_KEY",
            Self::ReservedKey => "SETTINGS_RESERVED_KEY",
            Self::InvalidValue => "SETTINGS_INVALID_VALUE",
            Self::CrossField => "SETTINGS_CROSS_FIELD",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidRevision => "expectedRevision harus bilangan bulat non-negatif",
            Self::EmptyChanges => "changes wajib berisi setidaknya satu key",
            Self::UnknownKey => "Key pengaturan tidak dikenali",
            Self::ReservedKey => "Key pengaturan dilindungi",
            Self::InvalidValue => "Nilai pengaturan tidak valid",
            Self::CrossField => "Kombinasi pengaturan tidak valid",
        }
    }
}

pub fn is_sensitive_setting_key(key: &str) -> bool {
    SENSITIVE_SITE_SETTING_KEYS.contains(&key)
}

pub fn canonical_settings_payload(
    expected_revision: i64,
    normalized_changes: &Map<String, Value>,
) -> Vec<u8> {
    let mut keys = normalized_changes.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    let mut ordered = Map::new();
    for key in keys {
        if let Some(value) = normalized_changes.get(&key) {
            ordered.insert(key, canonicalize_value(value));
        }
    }
    let payload = serde_json::json!({
        "expectedRevision": expected_revision,
        "changes": ordered,
    });
    serde_json::to_vec(&payload).unwrap_or_default()
}

pub fn digest_settings_payload(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

pub fn normalize_settings_intent(
    expected_revision: i64,
    changes: &Map<String, Value>,
    current: &Map<String, Value>,
) -> Result<NormalizedSettingsIntent, SettingsPolicyError> {
    if expected_revision < 0 {
        return Err(SettingsPolicyError::InvalidRevision);
    }
    if changes.is_empty() {
        return Err(SettingsPolicyError::EmptyChanges);
    }

    let defaults = default_site_settings();
    let mut normalized_changes = Map::new();
    for (key, value) in changes {
        if key == SITE_CONFIG_REVISION_KEY || key == "revision" {
            return Err(SettingsPolicyError::ReservedKey);
        }
        if !defaults.contains_key(key) {
            return Err(SettingsPolicyError::UnknownKey);
        }
        let normalized = validate_setting_json_value_for_policy(key, value)
            .map_err(|_| SettingsPolicyError::InvalidValue)?;
        normalized_changes.insert(key.clone(), normalized);
    }

    let mut next = current.clone();
    for (key, value) in &normalized_changes {
        next.insert(key.clone(), value.clone());
    }
    validate_cross_field_public(&next).map_err(|_| SettingsPolicyError::CrossField)?;

    let mut effective_changes = Map::new();
    for (key, value) in &normalized_changes {
        let current_value = current.get(key).cloned().unwrap_or(Value::Null);
        if &current_value != value {
            effective_changes.insert(key.clone(), value.clone());
        }
    }

    let requires_step_up = effective_changes
        .keys()
        .any(|key| is_sensitive_setting_key(key));
    let canonical = canonical_settings_payload(expected_revision, &normalized_changes);
    let digest = digest_settings_payload(&canonical);

    Ok(NormalizedSettingsIntent {
        expected_revision,
        normalized_changes,
        effective_changes,
        digest,
        requires_step_up,
    })
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut ordered = Map::new();
            for key in keys {
                if let Some(child) = map.get(&key) {
                    ordered.insert(key, canonicalize_value(child));
                }
            }
            Value::Object(ordered)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        other => other.clone(),
    }
}

fn validate_cross_field_public(next_settings: &Map<String, Value>) -> Result<(), ()> {
    let min_deposit = next_settings
        .get("minDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let max_deposit = next_settings
        .get("maxDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if max_deposit < min_deposit {
        return Err(());
    }
    if next_settings.get("depositFeeType").and_then(Value::as_str) == Some("percent") {
        let deposit_fee = next_settings
            .get("depositFee")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if deposit_fee > 100 {
            return Err(());
        }
    }
    if next_settings
        .get("maintenanceMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && next_settings
            .get("maintenanceMessage")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
    {
        return Err(());
    }
    let invoice_type = next_settings
        .get("invoiceRandomType")
        .and_then(Value::as_str)
        .unwrap_or("alphanumeric");
    let invoice_length = next_settings
        .get("invoiceRandomLength")
        .and_then(Value::as_i64)
        .unwrap_or(8);
    if crate::services::identifier_integrity::validate_invoice_length(invoice_type, invoice_length)
        .is_err()
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalized_intent(revision: i64, changes: Value) -> NormalizedSettingsIntent {
        let map = changes.as_object().cloned().unwrap();
        let current = Map::from_iter([
            ("brand".to_string(), json!("Danayasa")),
            ("title".to_string(), json!("Title")),
            ("maintenanceMode".to_string(), json!(false)),
            ("invoiceRandomType".to_string(), json!("alphanumeric")),
            ("invoiceRandomLength".to_string(), json!(8)),
            ("minDeposit".to_string(), json!(10000)),
            ("maxDeposit".to_string(), json!(10000000)),
            ("depositFee".to_string(), json!(0)),
            ("depositFeeType".to_string(), json!("fixed")),
            ("maintenanceMessage".to_string(), json!("Pemeliharaan")),
        ]);
        normalize_settings_intent(revision, &map, &current).unwrap()
    }

    #[test]
    fn sensitive_settings_inventory_is_exact() {
        assert_eq!(
            SENSITIVE_SITE_SETTING_KEYS,
            &[
                "maintenanceMode",
                "registrationEnabled",
                "guestCheckoutEnabled",
                "minDeposit",
                "maxDeposit",
                "depositFee",
                "depositFeeType",
                "refIdPrefix",
                "refIdDateFormat",
                "refIdSeparator",
                "refIdSequenceDigits",
                "invoicePrefix",
                "invoiceDateFormat",
                "invoiceSeparator",
                "invoiceRandomLength",
                "invoiceRandomType",
            ]
        );
    }

    #[test]
    fn canonical_digest_is_key_order_independent_but_revision_and_values_bound() {
        let left = normalized_intent(14, json!({"brand":"A", "title":"B"}));
        let reordered = normalized_intent(14, json!({"title":"B", "brand":"A"}));
        assert_eq!(left.digest, reordered.digest);
        assert_ne!(
            left.digest,
            normalized_intent(15, json!({"brand":"A", "title":"B"})).digest
        );
        assert_ne!(
            left.digest,
            normalized_intent(14, json!({"brand":"C", "title":"B"})).digest
        );
    }

    #[test]
    fn sensitive_no_op_does_not_require_step_up() {
        let current = Map::from_iter([
            ("maintenanceMode".to_string(), json!(true)),
            ("maintenanceMessage".to_string(), json!("Pemeliharaan")),
            ("brand".to_string(), json!("Danayasa")),
            ("title".to_string(), json!("Title")),
            ("invoiceRandomType".to_string(), json!("alphanumeric")),
            ("invoiceRandomLength".to_string(), json!(8)),
            ("minDeposit".to_string(), json!(10000)),
            ("maxDeposit".to_string(), json!(10000000)),
            ("depositFee".to_string(), json!(0)),
            ("depositFeeType".to_string(), json!("fixed")),
        ]);
        let changes = Map::from_iter([("maintenanceMode".to_string(), json!(true))]);
        let intent = normalize_settings_intent(1, &changes, &current).unwrap();
        assert!(intent.effective_changes.is_empty());
        assert!(!intent.requires_step_up);
    }

    #[test]
    fn reserved_and_unknown_keys_fail_closed() {
        let current = Map::new();
        let reserved = Map::from_iter([(
            SITE_CONFIG_REVISION_KEY.to_string(),
            json!(1),
        )]);
        assert_eq!(
            normalize_settings_intent(0, &reserved, &current)
                .unwrap_err()
                .code(),
            "SETTINGS_RESERVED_KEY"
        );
        let unknown = Map::from_iter([("notARealKey".to_string(), json!(true))]);
        assert_eq!(
            normalize_settings_intent(0, &unknown, &current)
                .unwrap_err()
                .code(),
            "SETTINGS_UNKNOWN_KEY"
        );
    }
}
