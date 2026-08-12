//! Consistent revisioned settings snapshot reads and public ETag helpers.

use axum::http::HeaderValue;
use serde_json::{Map, Value};

use super::{defaults::default_site_settings, store::load_settings};

pub const SITE_CONFIG_REVISION_KEY: &str = "__site_config_revision__";
const SNAPSHOT_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct SiteSettingsSnapshot {
    pub revision: i64,
    pub settings: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Unavailable,
    Unstable,
}

impl SnapshotError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "SETTINGS_SNAPSHOT_UNAVAILABLE",
            Self::Unstable => "SETTINGS_SNAPSHOT_UNSTABLE",
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
    raw.split(',')
        .map(str::trim)
        .any(|candidate| candidate == expected)
}

pub async fn load_revision(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<i64, SnapshotError> {
    use futures_util::TryStreamExt;
    use mongodb::bson::{doc, Document};

    let mut cursor = client
        .database(db_name)
        .collection::<Document>("settings")
        .find(doc! { "key": SITE_CONFIG_REVISION_KEY })
        .await
        .map_err(|_| SnapshotError::Unavailable)?;
    let mut docs = Vec::new();
    while let Some(document) = cursor
        .try_next()
        .await
        .map_err(|_| SnapshotError::Unavailable)?
    {
        docs.push(document);
    }
    if docs.len() > 1 {
        return Err(SnapshotError::Unavailable);
    }
    let Some(document) = docs.into_iter().next() else {
        return Ok(0);
    };
    let revision = match document.get("value") {
        Some(mongodb::bson::Bson::Int32(value)) => i64::from(*value),
        Some(mongodb::bson::Bson::Int64(value)) => *value,
        Some(mongodb::bson::Bson::Double(value)) if value.fract() == 0.0 && *value >= 0.0 => {
            *value as i64
        }
        Some(mongodb::bson::Bson::String(value)) => value
            .trim()
            .parse::<i64>()
            .map_err(|_| SnapshotError::Unavailable)?,
        None => 0,
        _ => return Err(SnapshotError::Unavailable),
    };
    if revision < 0 {
        return Err(SnapshotError::Unavailable);
    }
    Ok(revision)
}

pub async fn load_consistent_snapshot(
    client: &mongodb::Client,
    db_name: &str,
    selected_keys: &[&str],
) -> Result<SiteSettingsSnapshot, SnapshotError> {
    for _ in 0..SNAPSHOT_ATTEMPTS {
        let before = load_revision(client, db_name).await?;
        let settings = load_settings(client, db_name, selected_keys)
            .await
            .map_err(|_| SnapshotError::Unavailable)?;
        let after = load_revision(client, db_name).await?;
        if before == after {
            return Ok(SiteSettingsSnapshot {
                revision: before,
                settings,
            });
        }
    }
    Err(SnapshotError::Unstable)
}

pub fn with_revision_field(mut settings: Map<String, Value>, revision: i64) -> Map<String, Value> {
    settings.insert("revision".to_string(), Value::from(revision));
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::settings::defaults::{default_site_settings, public_site_setting_keys};

    #[test]
    fn revision_key_is_reserved_and_never_a_normal_setting() {
        assert!(!default_site_settings().contains_key(SITE_CONFIG_REVISION_KEY));
        assert!(!public_site_setting_keys().contains(&SITE_CONFIG_REVISION_KEY));
    }

    #[test]
    fn etag_matching_accepts_only_the_exact_strong_service_tag() {
        assert!(matches_site_settings_etag(
            Some(&HeaderValue::from_static("\"site-settings-14\"")),
            14
        ));
        for value in [
            "W/\"site-settings-14\"",
            "\"site-settings-014\"",
            "*",
            "\"other-14\"",
            "site-settings-14",
        ] {
            assert!(
                !matches_site_settings_etag(Some(&HeaderValue::from_str(value).unwrap()), 14),
                "{value}"
            );
        }
        assert!(matches_site_settings_etag(
            Some(&HeaderValue::from_static(
                "\"site-settings-13\", \"site-settings-14\""
            )),
            14
        ));
    }

    #[test]
    fn with_revision_field_is_top_level_metadata() {
        let mut settings = Map::new();
        settings.insert("brand".to_string(), Value::String("Danayasa".into()));
        let with_revision = with_revision_field(settings, 3);
        assert_eq!(with_revision.get("revision"), Some(&Value::from(3)));
        assert_eq!(
            with_revision.get("brand"),
            Some(&Value::String("Danayasa".into()))
        );
    }
}
