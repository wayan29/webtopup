use axum::{
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{Bson, Document};
use serde_json::Value;

use super::types::{NormalizedRewardPayload, RewardPayload};
use crate::{security::ErrorResponse, utils::bson::read_string};

pub(super) fn normalize_reward_payload(
    payload: RewardPayload,
    current: Option<&Document>,
) -> Result<NormalizedRewardPayload, Response> {
    let normalized = NormalizedRewardPayload {
        name: text_value_or_current(payload.name, current, "name", "")
            .trim()
            .to_string(),
        description: text_value_or_current(payload.description, current, "description", "")
            .trim()
            .to_string(),
        points_required: payload
            .points_required
            .and_then(number_value)
            .or_else(|| current.and_then(|doc| number_from_bson(doc.get("pointsRequired"))))
            .unwrap_or_default(),
        stock: payload
            .stock
            .and_then(number_value)
            .or_else(|| current.and_then(|doc| number_from_bson(doc.get("stock"))))
            .unwrap_or_default(),
        image_url: text_value_or_current(payload.image_url, current, "imageUrl", "")
            .trim()
            .to_string(),
        category: text_value_or_current(payload.category, current, "category", "")
            .trim()
            .to_string(),
        status: match payload.status {
            Some(Value::Bool(value)) => value,
            Some(_) => false,
            None => current
                .and_then(|doc| doc.get_bool("status").ok())
                .unwrap_or(true),
        },
    };

    if normalized.name.is_empty() {
        return Err(validation_error("Nama hadiah wajib diisi"));
    }
    if normalized.description.is_empty() {
        return Err(validation_error("Deskripsi hadiah wajib diisi"));
    }
    if normalized.category.is_empty() {
        return Err(validation_error("Kategori hadiah wajib diisi"));
    }
    if normalized.points_required < 1 {
        return Err(validation_error("Poin hadiah minimal 1"));
    }
    if normalized.stock < 0 {
        return Err(validation_error("Stok hadiah tidak boleh negatif"));
    }
    // Rewards historically required http(s). Managed internal cover paths are accepted only
    // when explicitly submitted; unchanged historical values remain readable until repaired.
    let is_managed = crate::services::managed_assets::parse_managed_upload_url(&normalized.image_url)
        .is_ok();
    if !is_managed && !is_valid_http_url(&normalized.image_url) {
        return Err(validation_error(
            "URL gambar harus diawali http:// atau https://",
        ));
    }
    let previous_image = current.map(|document| read_string(document, "imageUrl"));
    let effectively_changed = crate::services::managed_assets::effectively_changed_managed_field(
        previous_image.as_deref(),
        &normalized.image_url,
    );
    crate::services::managed_assets::ensure_managed_field_for_update(
        &crate::routes::uploads::upload_root(),
        &normalized.image_url,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Covers,
        effectively_changed,
    )?;

    Ok(normalized)
}

pub(super) fn number_from_bson(value: Option<&Bson>) -> Option<i64> {
    match value {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) => Some(*value as i64),
        _ => None,
    }
}

pub(super) fn number_value(value: Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn text_value_or_current(
    value: Option<Value>,
    current: Option<&Document>,
    key: &str,
    default: &str,
) -> String {
    match value {
        Some(value) => text_value(value).unwrap_or_default(),
        None => current
            .map(|doc| read_string(doc, key))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default.to_string()),
    }
}

fn validation_error(message: &'static str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(ErrorResponse { message }),
    )
        .into_response()
}

fn is_valid_http_url(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty() || trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

fn text_value(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}
