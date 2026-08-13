use mongodb::bson::{oid::ObjectId, Document};
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;
use url::Url;

use crate::services::idempotency::sha256_hex;

use super::slider_types::{
    NormalizedSliderChanges, PublicSliderItem, SliderCreateRequest, SliderSnapshotItem,
    SliderUpdateRequest,
};

/// Version of the canonical slider mutation binding shared by Rust and the gateway.
pub const SLIDER_MUTATION_CONTRACT: &str = "slider-revision-v1";
pub const MAX_CURRENT_SLIDERS: i64 = 20;
pub const MAX_PUBLIC_SLIDERS: i64 = 8;
pub const MAX_SLIDER_JSON_BYTES: usize = 64 * 1024;
pub const MAX_SLIDER_NAME_SCALARS: usize = 120;
pub const MAX_SLIDER_NAME_BYTES: usize = 480;
pub const MAX_SLIDER_IMAGE_BYTES: usize = 2048;
pub const MAX_SLIDER_LINK_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderAction {
    Create,
    Update,
    Archive,
    Restore,
    Reorder,
}

impl SliderAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Archive => "archive",
            Self::Restore => "restore",
            Self::Reorder => "reorder",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderPolicyError {
    InvalidName,
    InvalidImage,
    InvalidLink,
    InvalidRevision,
    EmptyChanges,
}

impl SliderPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidName => "SLIDER_NAME_INVALID",
            Self::InvalidImage => "SLIDER_IMAGE_INVALID",
            Self::InvalidLink => "SLIDER_LINK_INVALID",
            Self::InvalidRevision => "SLIDER_REVISION_INVALID",
            Self::EmptyChanges => "SLIDER_CHANGES_EMPTY",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidName => "Nama slider tidak valid",
            Self::InvalidImage => "Gambar slider tidak valid",
            Self::InvalidLink => "Link slider tidak valid",
            Self::InvalidRevision => "expectedRevision harus bilangan bulat non-negatif",
            Self::EmptyChanges => "changes wajib berisi setidaknya satu field",
        }
    }
}

pub fn trim_nfc(raw: &str) -> String {
    raw.trim().nfc().collect::<String>()
}

pub fn normalize_slider_name(raw: &str) -> Result<String, SliderPolicyError> {
    let normalized = trim_nfc(raw);
    if normalized.is_empty()
        || normalized.chars().count() > MAX_SLIDER_NAME_SCALARS
        || normalized.as_bytes().len() > MAX_SLIDER_NAME_BYTES
        || normalized.chars().any(|character| character == '\0' || character.is_control())
    {
        return Err(SliderPolicyError::InvalidName);
    }
    Ok(normalized)
}

pub fn normalize_slider_image(raw: &str) -> Result<String, SliderPolicyError> {
    let normalized = trim_nfc(raw);
    if normalized.as_bytes().len() > MAX_SLIDER_IMAGE_BYTES
        || !is_canonical_cover_path(&normalized)
    {
        return Err(SliderPolicyError::InvalidImage);
    }
    Ok(normalized)
}

pub fn normalize_slider_link(raw: &str) -> Result<String, SliderPolicyError> {
    let normalized = trim_nfc(raw);
    if normalized.as_bytes().len() > MAX_SLIDER_LINK_BYTES
        || normalized.chars().any(|character| character == '\0' || character.is_control())
    {
        return Err(SliderPolicyError::InvalidLink);
    }
    if normalized.is_empty() {
        return Ok(normalized);
    }
    if normalized.starts_with('/') {
        return validate_internal_link(&normalized).then_some(normalized).ok_or(SliderPolicyError::InvalidLink);
    }

    let parsed = Url::parse(&normalized).map_err(|_| SliderPolicyError::InvalidLink)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(SliderPolicyError::InvalidLink);
    }
    Ok(parsed.to_string())
}

pub fn normalize_create(
    payload: SliderCreateRequest,
) -> Result<NormalizedSliderChanges, SliderPolicyError> {
    if payload.expected_revision < 0 {
        return Err(SliderPolicyError::InvalidRevision);
    }
    Ok(NormalizedSliderChanges {
        expected_revision: payload.expected_revision,
        name: normalize_slider_name(&payload.slider.name)?,
        image: normalize_slider_image(&payload.slider.image)?,
        link: normalize_slider_link(&payload.slider.link)?,
        status: payload.slider.status,
    })
}

pub fn normalize_update(
    payload: SliderUpdateRequest,
    current: &SliderSnapshotItem,
) -> Result<NormalizedSliderChanges, SliderPolicyError> {
    if payload.expected_revision < 0 {
        return Err(SliderPolicyError::InvalidRevision);
    }
    if payload.changes.name.is_none()
        && payload.changes.image.is_none()
        && payload.changes.link.is_none()
        && payload.changes.status.is_none()
    {
        return Err(SliderPolicyError::EmptyChanges);
    }
    let name = match payload.changes.name {
        Some(value) => normalize_slider_name(&value)?,
        None => current.name.clone(),
    };
    let image = match payload.changes.image {
        Some(value) => normalize_slider_image(&value)?,
        None => current.image.clone(),
    };
    let link = match payload.changes.link {
        Some(value) => normalize_slider_link(&value)?,
        None => normalize_slider_link(&current.link)?,
    };
    Ok(NormalizedSliderChanges {
        expected_revision: payload.expected_revision,
        name,
        image,
        link,
        status: payload.changes.status.unwrap_or(current.status),
    })
}

pub fn effective_requires_step_up(
    action: SliderAction,
    before: Option<&SliderSnapshotItem>,
    after: Option<&SliderSnapshotItem>,
    old_public_order: &[ObjectId],
    new_public_order: &[ObjectId],
) -> bool {
    match action {
        SliderAction::Create => after.is_some_and(|value| value.status),
        SliderAction::Update => {
            let was_public = before.is_some_and(SliderSnapshotItem::is_public);
            let becomes_public = after.is_some_and(SliderSnapshotItem::is_public);
            (!was_public && becomes_public)
                || (was_public && public_fields_changed(before, after))
        }
        SliderAction::Archive => before.is_some_and(SliderSnapshotItem::is_public),
        SliderAction::Restore => false,
        SliderAction::Reorder => old_public_order != new_public_order,
    }
}

pub fn canonical_slider_claim_input(
    contract_version: &str,
    operator_id: ObjectId,
    action: SliderAction,
    target_id: Option<ObjectId>,
    expected_revision: i64,
    normalized_payload: &Value,
) -> Value {
    serde_json::json!({
        "action": action.as_str(),
        "contractVersion": contract_version,
        "expectedRevision": expected_revision,
        "normalizedPayload": canonicalize_value(normalized_payload),
        "operatorId": operator_id.to_hex(),
        "targetId": target_id.map(|value| value.to_hex()),
    })
}

/// Return the public DTO without allowing operational fields to leak through serialization.
pub fn public_slider_from_document(document: &Document) -> PublicSliderItem {
    PublicSliderItem::from(document)
}

/// Digest helper kept beside the canonical input so every caller uses SHA-256 over the same JSON.
pub fn canonical_slider_claim_digest(input: &Value) -> String {
    let bytes = serde_json::to_vec(input).unwrap_or_default();
    sha256_hex(&bytes)
}

fn public_fields_changed(
    before: Option<&SliderSnapshotItem>,
    after: Option<&SliderSnapshotItem>,
) -> bool {
    let (Some(before), Some(after)) = (before, after) else {
        return false;
    };
    before.name != after.name || before.image != after.image || before.link != after.link
}

fn is_canonical_cover_path(value: &str) -> bool {
    let Some(filename) = value.strip_prefix("/uploads/covers/") else {
        return false;
    };
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('?')
        || filename.contains('#')
        || filename.contains('%')
        || filename == "."
        || filename == ".."
        || filename.contains("..")
        || filename.chars().any(|character| character == '\0' || character.is_control())
    {
        return false;
    }
    let Some((stem, extension)) = filename.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() || !matches!(extension, "jpg" | "jpeg" | "png" | "webp") {
        return false;
    }
    stem.split_once('-').is_some_and(|(timestamp, random)| {
        !timestamp.is_empty()
            && timestamp.chars().all(|character| character.is_ascii_digit())
            && !random.is_empty()
            && random.chars().all(|character| character.is_ascii_hexdigit())
    })
}

fn validate_internal_link(value: &str) -> bool {
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || (value.contains('%') && !valid_percent_escapes(value))
    {
        return false;
    }
    let (without_fragment, fragment) = value.split_once('#').unwrap_or((value, ""));
    let (path, query) = without_fragment.split_once('?').unwrap_or((without_fragment, ""));
    if fragment_has_unsafe_bytes(fragment) || fragment.contains('/') {
        return false;
    }
    if query_has_unsafe_bytes(query) {
        return false;
    }
    let segments = path.split('/');
    if segments.clone().any(|segment| segment == "." || segment == "..") {
        return false;
    }
    if value.to_ascii_lowercase().contains("%2f")
        || value.to_ascii_lowercase().contains("%5c")
        || value.to_ascii_lowercase().contains("%2e")
    {
        return false;
    }
    true
}

fn valid_percent_escapes(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn fragment_has_unsafe_bytes(value: &str) -> bool {
    value.contains('\\') || value.chars().any(|character| character.is_control())
}

fn query_has_unsafe_bytes(value: &str) -> bool {
    fragment_has_unsafe_bytes(value)
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut ordered = Map::new();
            for key in keys {
                if let Some(value) = map.get(&key) {
                    ordered.insert(key, canonicalize_value(value));
                }
            }
            Value::Object(ordered)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize_value).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;
    use serde_json::json;

    fn snapshot(status: bool) -> SliderSnapshotItem {
        SliderSnapshotItem {
            id: ObjectId::new(),
            name: "Promo".to_string(),
            image: "/uploads/covers/1710000000000-deadbeef.webp".to_string(),
            link: "/promo".to_string(),
            sort_order: 0,
            status,
            lifecycle: "active".to_string(),
        }
    }

    #[test]
    fn name_uses_trim_then_nfc_and_enforces_scalar_and_byte_bounds() {
        let normalized = normalize_slider_name("  Cafe\u{301}  ").unwrap();
        assert_eq!(normalized, "Café");
        assert_eq!(normalize_slider_name(&"é".repeat(120)).unwrap().chars().count(), 120);
        assert_eq!(normalize_slider_name(&"é".repeat(121)).unwrap_err().code(), "SLIDER_NAME_INVALID");
        assert_eq!(normalize_slider_name("bad\nname").unwrap_err().code(), "SLIDER_NAME_INVALID");
    }

    #[test]
    fn image_requires_exact_canonical_cover_path() {
        for bad in [
            "https://cdn.example/x.webp",
            "/uploads/icons/x.webp",
            "/uploads/covers/../x.webp",
            "/uploads/covers/%2e%2e.png",
            "/uploads/covers/x.webp?raw=1",
        ] {
            assert_eq!(normalize_slider_image(bad).unwrap_err().code(), "SLIDER_IMAGE_INVALID");
        }
        assert_eq!(
            normalize_slider_image("/uploads/covers/1710000000000-deadbeef.webp").unwrap(),
            "/uploads/covers/1710000000000-deadbeef.webp"
        );
    }

    #[test]
    fn links_accept_internal_or_https_and_normalize_authoritatively() {
        assert_eq!(normalize_slider_link("").unwrap(), "");
        assert_eq!(normalize_slider_link("/promo?a=1&a=2#x").unwrap(), "/promo?a=1&a=2#x");
        assert_eq!(normalize_slider_link("HTTPS://EXAMPLE.COM:443").unwrap(), "https://example.com/");
        for bad in [
            "http://example.com",
            "https://u:p@example.com",
            "//example.com",
            "/../admin",
            "/%2fadmin",
            "javascript:alert(1)",
        ] {
            assert_eq!(normalize_slider_link(bad).unwrap_err().code(), "SLIDER_LINK_INVALID");
        }
    }

    #[test]
    fn revision_and_body_policy_are_bounded() {
        assert_eq!(MAX_SLIDER_JSON_BYTES, 64 * 1024);
        assert_eq!(normalize_slider_name("\u{0}").unwrap_err().code(), "SLIDER_NAME_INVALID");
        let error = normalize_create(SliderCreateRequest {
            expected_revision: -1,
            slider: super::super::slider_types::SliderCreateFields {
                name: "Promo".into(),
                image: "/uploads/covers/1710000000000-deadbeef.webp".into(),
                link: String::new(),
                status: false,
            },
        })
        .unwrap_err();
        assert_eq!(error.code(), "SLIDER_REVISION_INVALID");
    }

    #[test]
    fn sensitivity_truth_table_uses_effective_public_state() {
        let draft = snapshot(false);
        let mut public = snapshot(true);
        assert!(effective_requires_step_up(SliderAction::Create, None, Some(&public), &[], &[]));
        assert!(!effective_requires_step_up(SliderAction::Restore, None, Some(&draft), &[], &[]));
        assert!(effective_requires_step_up(SliderAction::Archive, Some(&public), None, &[], &[]));
        assert!(!effective_requires_step_up(SliderAction::Update, Some(&draft), Some(&draft), &[], &[]));
        public.name = "Changed".into();
        assert!(effective_requires_step_up(SliderAction::Update, Some(&snapshot(true)), Some(&public), &[], &[]));
        assert!(effective_requires_step_up(SliderAction::Reorder, None, None, &[ObjectId::new()], &[ObjectId::new()]));
    }

    #[test]
    fn canonical_claim_input_binds_every_security_relevant_dimension() {
        let operator = ObjectId::new();
        let target = ObjectId::new();
        let base = canonical_slider_claim_input("slider-revision-v1", operator, SliderAction::Update, Some(target), 7, &json!({"name":"Promo"}));
        let digest = canonical_slider_claim_digest(&base);
        let variants = [
            canonical_slider_claim_input("slider-revision-v2", operator, SliderAction::Update, Some(target), 7, &json!({"name":"Promo"})),
            canonical_slider_claim_input("slider-revision-v1", ObjectId::new(), SliderAction::Update, Some(target), 7, &json!({"name":"Promo"})),
            canonical_slider_claim_input("slider-revision-v1", operator, SliderAction::Archive, Some(target), 7, &json!({"name":"Promo"})),
            canonical_slider_claim_input("slider-revision-v1", operator, SliderAction::Update, None, 7, &json!({"name":"Promo"})),
            canonical_slider_claim_input("slider-revision-v1", operator, SliderAction::Update, Some(target), 8, &json!({"name":"Promo"})),
            canonical_slider_claim_input("slider-revision-v1", operator, SliderAction::Update, Some(target), 7, &json!({"name":"Other"})),
        ];
        for variant in variants {
            assert_ne!(digest, canonical_slider_claim_digest(&variant));
        }
        assert_eq!(base["normalizedPayload"], json!({"name":"Promo"}));
    }
}
