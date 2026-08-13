//! Consistent revisioned slider reads and public freshness helpers.
//!
//! Slider mutations are deliberately not part of this module yet.  The read snapshots therefore
//! do not advertise a mutation capability marker while the legacy mutation handlers remain in
//! place for compatibility.

use axum::http::HeaderValue;
use futures_util::TryStreamExt;
use mongodb::{bson::{doc, oid::ObjectId, Bson, Document}, Client, Database};
use serde::Serialize;

use super::{
    public_slider_from_document, PublicSliderItem, MAX_CURRENT_SLIDERS, MAX_PUBLIC_SLIDERS,
};
use crate::utils::bson::{read_i64, read_string};

/// Dedicated collection containing the one global slider revision document.
pub const SLIDER_METADATA_COLLECTION: &str = "slidermetadata";
const GLOBAL_METADATA_ID: &str = "global";
const SNAPSHOT_ATTEMPTS: usize = 3;

/// Errors returned while obtaining a self-consistent slider read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderSnapshotError {
    /// The database was unavailable or contained an unusable revision value.
    Unavailable,
    /// The revision changed during every bounded read attempt.
    Unstable,
}

impl SliderSnapshotError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "SLIDER_SNAPSHOT_UNAVAILABLE",
            Self::Unstable => "SLIDER_SNAPSHOT_UNSTABLE",
        }
    }
}

/// Administrative slider data.  This intentionally exposes operational read metadata but no
/// mutation contract or idempotency/registry internals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderAdminItem {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    pub image: String,
    pub link: String,
    pub sort_order: i64,
    pub status: bool,
    pub lifecycle: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub archived_by: Option<String>,
}

/// Capacity and current usage metadata included with every admin snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderLimits {
    pub total: i64,
    pub active: i64,
    pub current_total: i64,
    pub current_active: i64,
    pub remaining_total: i64,
    pub remaining_active: i64,
}

/// A versioned, read-only administrative snapshot.
///
/// `mutationContract` is intentionally absent in this milestone.  The client must treat this
/// shape as read-only until the later transaction, readiness, and gateway capability gates are
/// complete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SliderAdminSnapshot {
    pub revision: i64,
    pub sliders: Vec<SliderAdminItem>,
    pub limits: SliderLimits,
}

/// Load the global slider revision.  A missing metadata document is the initial revision zero.
pub async fn load_slider_revision(
    client: &Client,
    db_name: &str,
) -> Result<i64, SliderSnapshotError> {
    let document = client
        .database(db_name)
        .collection::<Document>(SLIDER_METADATA_COLLECTION)
        .find_one(doc! { "_id": GLOBAL_METADATA_ID })
        .await
        .map_err(|_| SliderSnapshotError::Unavailable)?;

    let Some(document) = document else {
        return Ok(0);
    };

    let revision = match document.get("revision") {
        None => 0,
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        Some(Bson::Double(value)) if value.is_finite() && value.fract() == 0.0 => *value as i64,
        Some(Bson::String(value)) => value
            .trim()
            .parse::<i64>()
            .map_err(|_| SliderSnapshotError::Unavailable)?,
        _ => return Err(SliderSnapshotError::Unavailable),
    };

    if revision < 0 {
        return Err(SliderSnapshotError::Unavailable);
    }
    Ok(revision)
}

/// Load all current/non-archived sliders and the corresponding capacity metadata.
pub async fn load_current_snapshot(
    client: &Client,
    db_name: &str,
) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    load_admin_snapshot(client, db_name, current_filter()).await
}

/// Load archived sliders while keeping capacity metadata for the current collection.
pub async fn load_archived_snapshot(
    client: &Client,
    db_name: &str,
) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    load_admin_snapshot(client, db_name, archived_filter()).await
}

/// Load the public array and its authoritative global revision.
///
/// Public links are sanitized at read time: historical HTTP/unsafe links remain in storage for
/// diagnosis, but are disclosed as an empty link rather than becoming an interactive anchor.
pub async fn load_public_snapshot(
    client: &Client,
    db_name: &str,
) -> Result<(i64, Vec<PublicSliderItem>), SliderSnapshotError> {
    for _ in 0..SNAPSHOT_ATTEMPTS {
        let before = load_slider_revision(client, db_name).await?;
        let documents = load_documents(
            client.database(db_name),
            public_filter(),
            Some(MAX_PUBLIC_SLIDERS),
        )
        .await?;
        let after = load_slider_revision(client, db_name).await?;
        if before == after {
            return Ok((
                before,
                documents.iter().map(public_item_from_document).collect(),
            ));
        }
    }
    Err(SliderSnapshotError::Unstable)
}

/// Return a strong ETag derived only from the global revision.
pub fn slider_etag(revision: i64) -> String {
    format!("\"sliders-{revision}\"")
}

/// Match an exact strong member of an HTTP `If-None-Match` entity-tag list.
///
/// Weak tags, wildcard, unquoted values, malformed members, and zero-padded revisions are never
/// treated as a match.  A malformed member invalidates the complete list so malformed input
/// cannot broaden a cache validator.
pub fn matches_slider_etag(value: Option<&HeaderValue>, revision: i64) -> bool {
    let Some(raw) = value.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let Some(members) = split_entity_tag_list(raw) else {
        return false;
    };
    if members.is_empty() || members.iter().any(|member| !valid_entity_tag(member)) {
        return false;
    }
    let expected = slider_etag(revision);
    members.iter().any(|member| *member == expected)
}

fn split_entity_tag_list(raw: &str) -> Option<Vec<&str>> {
    let bytes = raw.as_bytes();
    let mut members = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte == b'"' {
            in_quotes = !in_quotes;
        } else if !in_quotes && byte == b',' {
            members.push(raw[start..index].trim());
            start = index + 1;
        }
    }
    if in_quotes {
        return None;
    }
    members.push(raw[start..].trim());
    Some(members)
}

fn valid_entity_tag(value: &str) -> bool {
    if value == "*" {
        return true;
    }
    let candidate = value.strip_prefix("W/").unwrap_or(value);
    if candidate.len() < 2 || !candidate.starts_with('"') || !candidate.ends_with('"') {
        return false;
    }
    candidate[1..candidate.len() - 1]
        .bytes()
        .all(|byte| byte == 0x21 || (0x23..=0x7e).contains(&byte) || byte >= 0x80)
}

async fn load_admin_snapshot(
    client: &Client,
    db_name: &str,
    filter: Document,
) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    for _ in 0..SNAPSHOT_ATTEMPTS {
        let before = load_slider_revision(client, db_name).await?;
        let documents = load_documents(client.database(db_name), filter.clone(), None).await?;
        let current_documents = if filter == archived_filter() {
            load_documents(client.database(db_name), current_filter(), None).await?
        } else {
            documents.clone()
        };
        let after = load_slider_revision(client, db_name).await?;
        if before == after {
            return Ok(SliderAdminSnapshot {
                revision: before,
                sliders: documents.iter().map(admin_item_from_document).collect(),
                limits: limits_from_documents(&current_documents),
            });
        }
    }
    Err(SliderSnapshotError::Unstable)
}

async fn load_documents(
    database: Database,
    filter: Document,
    limit: Option<i64>,
) -> Result<Vec<Document>, SliderSnapshotError> {
    let collection = database.collection::<Document>("sliders");
    let mut find = collection
        .find(filter)
        .sort(doc! { "sortOrder": 1, "_id": 1 });
    if let Some(limit) = limit {
        find = find.limit(limit);
    }
    find.await
        .map_err(|_| SliderSnapshotError::Unavailable)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|_| SliderSnapshotError::Unavailable)
}

fn current_filter() -> Document {
    doc! { "lifecycle": { "$ne": "archived" } }
}

fn archived_filter() -> Document {
    doc! { "lifecycle": "archived" }
}

fn public_filter() -> Document {
    doc! {
        "lifecycle": { "$ne": "archived" },
        "status": true,
    }
}

fn limits_from_documents(documents: &[Document]) -> SliderLimits {
    let current_total = documents.len() as i64;
    let current_active = documents
        .iter()
        .filter(|document| document.get_bool("status").unwrap_or(true))
        .count() as i64;
    SliderLimits {
        total: MAX_CURRENT_SLIDERS,
        active: MAX_PUBLIC_SLIDERS,
        current_total,
        current_active,
        remaining_total: (MAX_CURRENT_SLIDERS - current_total).max(0),
        remaining_active: (MAX_PUBLIC_SLIDERS - current_active).max(0),
    }
}

fn admin_item_from_document(document: &Document) -> SliderAdminItem {
    SliderAdminItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .or_else(|_| document.get_str("_id").map(ToString::to_string))
            .unwrap_or_default(),
        name: read_string(document, "name"),
        image: read_string(document, "image"),
        link: read_string(document, "link"),
        sort_order: read_i64(document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        lifecycle: document
            .get_str("lifecycle")
            .unwrap_or("active")
            .to_string(),
        created_at: optional_date_or_string(document, "createdAt").unwrap_or_default(),
        updated_at: optional_date_or_string(document, "updatedAt").unwrap_or_default(),
        archived_at: optional_date_or_string(document, "archivedAt"),
        archived_by: optional_object_id_or_string(document, "archivedBy"),
    }
}

fn public_item_from_document(document: &Document) -> PublicSliderItem {
    let mut item = public_slider_from_document(document);
    if super::normalize_slider_link(&item.link).is_err() {
        item.link.clear();
    }
    item
}

fn optional_date_or_string(document: &Document, key: &str) -> Option<String> {
    if let Ok(value) = document.get_datetime(key) {
        return value.try_to_rfc3339_string().ok();
    }
    document
        .get_str(key)
        .ok()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_object_id_or_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_object_id(key)
        .map(|id| id.to_hex())
        .or_else(|_| document.get_str(key).map(ToString::to_string))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;
    use std::collections::BTreeSet;

    fn public_fixture() -> Document {
        doc! {
            "_id": ObjectId::new(),
            "name": "Promo",
            "image": "/uploads/covers/1710000000000-deadbeef.webp",
            "link": "/promo",
            "sortOrder": 0_i64,
            "status": true,
            "lifecycle": "active",
            "createdAt": "hidden",
            "updatedAt": "hidden",
            "archivedAt": "hidden",
            "archivedBy": ObjectId::new(),
        }
    }

    #[test]
    fn exact_strong_slider_etag_list_matching() {
        let current = HeaderValue::from_static("\"other,tag\", \"sliders-14\"");
        assert!(matches_slider_etag(Some(&current), 14));
        let literal_backslash = HeaderValue::from_static(r#""ends-with\", "sliders-14""#);
        assert!(matches_slider_etag(Some(&literal_backslash), 14));
        for raw in [
            "W/\"sliders-14\"",
            "*",
            "\"sliders-014\"",
            "sliders-14",
            "\"sliders-15\"",
        ] {
            assert!(!matches_slider_etag(
                Some(&HeaderValue::from_str(raw).unwrap()),
                14
            ));
        }
    }

    #[test]
    fn malformed_entity_tag_list_does_not_broaden_a_match() {
        for raw in [
            "\"sliders-14\", malformed",
            "\"sliders-14\", \"unterminated",
            "\"sliders-14\",",
        ] {
            assert!(!matches_slider_etag(
                Some(&HeaderValue::from_str(raw).unwrap()),
                14
            ));
        }
    }

    #[test]
    fn public_dto_omits_internal_slider_fields() {
        let json = serde_json::to_value(public_slider_from_document(&public_fixture())).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from(["_id".into(), "image".into(), "link".into(), "name".into()])
        );
    }

    #[test]
    fn legacy_missing_lifecycle_is_current_and_invalid_public_links_are_empty() {
        let mut legacy = public_fixture();
        legacy.remove("lifecycle");
        assert_eq!(admin_item_from_document(&legacy).lifecycle, "active");

        legacy.insert("link", "http://legacy.example/promo");
        assert!(public_item_from_document(&legacy).link.is_empty());
    }

    #[test]
    fn stable_reads_use_at_most_three_before_after_attempts() {
        assert_eq!(stable_revision_from_sequence(&[1, 2, 2, 2]).unwrap(), 2);
        assert_eq!(
            stable_revision_from_sequence(&[1, 2, 2, 3, 3, 4]).unwrap_err(),
            SliderSnapshotError::Unstable
        );
    }

    #[test]
    fn admin_snapshot_is_read_only_until_capability_gates_are_complete() {
        let snapshot = SliderAdminSnapshot {
            revision: 3,
            sliders: Vec::new(),
            limits: limits_from_documents(&[]),
        };
        let json = serde_json::to_value(snapshot).unwrap();
        assert!(!json
            .as_object()
            .unwrap()
            .contains_key("mutationContract"));
    }

    fn stable_revision_from_sequence(
        sequence: &[i64],
    ) -> Result<i64, SliderSnapshotError> {
        let mut offset = 0;
        for _ in 0..SNAPSHOT_ATTEMPTS {
            let before = sequence.get(offset).ok_or(SliderSnapshotError::Unstable)?;
            let after = sequence
                .get(offset + 1)
                .ok_or(SliderSnapshotError::Unstable)?;
            offset += 2;
            if before == after {
                return Ok(*before);
            }
        }
        Err(SliderSnapshotError::Unstable)
    }
}
