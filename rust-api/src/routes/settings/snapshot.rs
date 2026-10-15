//! Consistent revisioned settings snapshot reads and public ETag helpers.

use axum::http::HeaderValue;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::services::bot_protection::effective_bot_protection;

use super::store::{load_domain_snapshot, SETTINGS_DOMAIN};

pub const SITE_CONFIG_REVISION_KEY: &str = "__site_config_revision__";

#[derive(Debug, Clone, PartialEq)]
pub struct SiteSettingsSnapshot {
    pub revision: i64,
    pub settings: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Unavailable,
}

impl SnapshotError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "SETTINGS_SNAPSHOT_UNAVAILABLE",
        }
    }
}

pub fn site_settings_etag(revision: i64) -> String {
    format!("\"site-settings-{revision}\"")
}

pub fn matches_site_settings_etag(raw: Option<&HeaderValue>, revision: i64) -> bool {
    let Some(raw) = raw.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let expected = site_settings_etag(revision);
    raw.split(',').map(str::trim).any(|candidate| candidate == expected)
}

/// Load the settings revision and stored rows from one statement snapshot.
pub async fn load_revision(pool: &PgPool) -> Result<i64, SnapshotError> {
    Ok(load_consistent_snapshot(pool, &[]).await?.revision)
}

pub async fn load_consistent_snapshot(
    pool: &PgPool,
    selected_keys: &[&str],
) -> Result<SiteSettingsSnapshot, SnapshotError> {
    let (revision, settings) = load_domain_snapshot(pool, SETTINGS_DOMAIN)
        .await
        .map_err(|_| SnapshotError::Unavailable)?;
    let mut settings = settings;
    if !selected_keys.is_empty() {
        settings.retain(|key, _| selected_keys.contains(&key.as_str()));
    }
    Ok(SiteSettingsSnapshot { revision, settings })
}

pub fn with_revision_field(mut settings: Map<String, Value>, revision: i64) -> Map<String, Value> {
    settings.insert("revision".to_string(), Value::from(revision));
    settings
}

pub fn apply_public_bot_protection(settings: &mut Map<String, Value>, kill_switch: bool) {
    let stored_enabled = settings
        .get("botProtectionEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    settings.insert(
        "botProtectionEnabled".to_string(),
        Value::Bool(effective_bot_protection(stored_enabled, kill_switch)),
    );
}

pub fn with_admin_bot_protection_metadata(
    settings: Map<String, Value>,
    revision: i64,
    kill_switch: bool,
) -> Map<String, Value> {
    let mut settings = with_revision_field(settings, revision);
    settings.insert(
        "botProtectionKillSwitch".to_string(),
        Value::Bool(kill_switch),
    );
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn etag_uses_the_site_settings_revision() {
        assert_eq!(site_settings_etag(7), "\"site-settings-7\"");
    }

    #[test]
    fn etag_matches_exact_members_only() {
        let revision = 4;
        let matching = HeaderValue::from_static("\"site-settings-4\"");
        let listed = HeaderValue::from_static("\"other\", \"site-settings-4\"");
        let stale = HeaderValue::from_static("\"site-settings-3\"");
        assert!(matches_site_settings_etag(Some(&matching), revision));
        assert!(matches_site_settings_etag(Some(&listed), revision));
        assert!(!matches_site_settings_etag(Some(&stale), revision));
        assert!(!matches_site_settings_etag(None, revision));
    }

    #[test]
    fn revision_field_is_added_to_the_public_object() {
        let mut settings = Map::new();
        settings.insert("brand".to_string(), json!("Danayasa"));
        let with_revision = with_revision_field(settings, 9);
        assert_eq!(with_revision.get("revision"), Some(&json!(9)));
    }

    #[test]
    fn public_bot_protection_honors_the_kill_switch() {
        let mut enabled = Map::new();
        enabled.insert("botProtectionEnabled".to_string(), json!(true));
        apply_public_bot_protection(&mut enabled, true);
        assert_eq!(enabled.get("botProtectionEnabled"), Some(&json!(false)));

        let mut disabled = Map::new();
        disabled.insert("botProtectionEnabled".to_string(), json!(false));
        apply_public_bot_protection(&mut disabled, false);
        assert_eq!(disabled.get("botProtectionEnabled"), Some(&json!(false)));
    }

    #[test]
    fn admin_metadata_includes_kill_switch_and_revision() {
        let settings = Map::new();
        let metadata = with_admin_bot_protection_metadata(settings, 3, true);
        assert_eq!(metadata.get("revision"), Some(&json!(3)));
        assert_eq!(metadata.get("botProtectionKillSwitch"), Some(&json!(true)));
    }
}
