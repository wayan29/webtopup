use mongodb::bson::{oid::ObjectId, Document};
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub(super) use super::types::{SliderItem, SliderPayload};

/// The canonical data accepted by a slider create request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderCreateRequest {
    pub expected_revision: i64,
    pub slider: SliderCreateFields,
}

/// The fields that may be supplied when creating a slider.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderCreateFields {
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub link: String,
    pub status: bool,
}

/// The canonical data accepted by a slider update request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderUpdateRequest {
    pub expected_revision: i64,
    pub changes: SliderUpdateChanges,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderLifecycleRequest {
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderReorderRequest {
    pub expected_revision: i64,
    pub orders: Vec<SliderOrderItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderOrderItem {
    pub id: String,
    pub sort_order: i64,
}

/// An update contains only explicitly changed fields. `Option<bool>` is deliberate: JSON
/// strings/numbers must not be coerced into a boolean by the request boundary.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliderUpdateChanges {
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub image: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub link: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_bool")]
    pub status: Option<bool>,
}

/// A normalized slider state used by the mutation and idempotency layers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedSliderChanges {
    pub expected_revision: i64,
    pub name: String,
    pub image: String,
    pub link: String,
    pub status: bool,
}

/// The small internal state needed to evaluate effective public impact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliderSnapshotItem {
    pub id: ObjectId,
    pub name: String,
    pub image: String,
    pub link: String,
    pub sort_order: i64,
    pub status: bool,
    pub lifecycle: String,
}

impl SliderSnapshotItem {
    pub fn is_public(&self) -> bool {
        self.lifecycle != "archived" && self.status
    }
}

/// Public responses intentionally contain no lifecycle, status, ordering, timestamps, or
/// operational metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicSliderItem {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    pub image: String,
    pub link: String,
}

/// A BSON-backed public item is useful at the snapshot boundary, where legacy documents must be
/// readable without being rewritten.
impl From<&Document> for PublicSliderItem {
    fn from(document: &Document) -> Self {
        let id = document
            .get_object_id("_id")
            .map(|value| value.to_hex())
            .unwrap_or_default();
        Self {
            id,
            name: document.get_str("name").unwrap_or_default().to_string(),
            image: document.get_str("image").unwrap_or_default().to_string(),
            link: document.get_str("link").unwrap_or_default().to_string(),
        }
    }
}

/// Legacy handlers still consume these names until the revisioned route migration. Keeping the
/// compatibility types in this module makes the new slider contracts the single source of truth
/// without changing the old endpoint's wire shape in this task.
fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(de::Error::custom("expected a string, not null"));
    }
    value
        .as_str()
        .map(ToString::to_string)
        .map(Some)
        .ok_or_else(|| de::Error::custom("expected a string"))
}

fn deserialize_optional_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(de::Error::custom("expected a boolean, not null"));
    }
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| de::Error::custom("expected a boolean"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn request_types_reject_unknown_fields() {
        let error = serde_json::from_value::<SliderCreateRequest>(serde_json::json!({
            "expectedRevision": 0,
            "slider": {
                "name": "Promo",
                "image": "/uploads/covers/1710000000000-deadbeef.webp",
                "link": "",
                "status": false,
                "unexpected": true
            }
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));

        let error = serde_json::from_value::<SliderUpdateRequest>(serde_json::json!({
            "expectedRevision": 0,
            "changes": { "status": false, "unexpected": true }
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn request_types_require_literal_boolean_status() {
        for value in [serde_json::json!("false"), serde_json::json!(0), serde_json::json!(null)] {
            let error = serde_json::from_value::<SliderCreateRequest>(serde_json::json!({
                "expectedRevision": 0,
                "slider": {
                    "name": "Promo",
                    "image": "/uploads/covers/1710000000000-deadbeef.webp",
                    "link": "",
                    "status": value
                }
            }))
            .unwrap_err();
            assert!(error.to_string().contains("boolean"), "{error}");
        }
    }

    #[test]
    fn public_dto_has_only_compatibility_fields() {
        let document = doc! {
            "_id": ObjectId::new(),
            "name": "Promo",
            "image": "/uploads/covers/example.webp",
            "link": "/promo",
            "sortOrder": 0_i64,
            "status": true,
            "lifecycle": "active",
            "createdAt": "hidden",
            "updatedAt": "hidden",
        };
        let json = serde_json::to_value(PublicSliderItem::from(&document)).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from([
                "_id".to_string(),
                "image".to_string(),
                "link".to_string(),
                "name".to_string(),
            ])
        );
    }
}
