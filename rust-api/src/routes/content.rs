use axum::{
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{oid::ObjectId, Document};
use serde_json::Value;

use crate::{
    security::ErrorResponse,
    utils::bson::{read_i64, read_string},
};

mod flash_admin;
mod flash_mappers;
mod flash_payload;
mod flash_public;
mod slider_idempotency;
mod slider_mutation;
mod slider_policy;
mod slider_snapshot;
mod slider_types;
mod sliders;
mod types;
mod utils;

pub use flash_admin::{
    flash_sale_add_product, flash_sale_admin_detail, flash_sale_create, flash_sale_delete,
    flash_sale_remove_product, flash_sale_update, flash_sales_admin_all,
};
use flash_mappers::*;
use flash_payload::*;
pub use flash_public::{flash_sale_price, flash_sales_active};
pub use sliders::{
    slider_delete, sliders_admin_all, sliders_admin_archived, sliders_public,
    sliders_update_sort_order,
};
pub use slider_mutation::{
    execute_slider_mutation,
    slider_create as slider_mutation_create,
    slider_update as slider_mutation_update,
};
pub use slider_idempotency::{
    begin_slider_claim,
    complete_slider_claim_before_transaction, complete_slider_claim_in_session,
    mark_slider_commit_unknown_conditionally, mark_slider_step_up_required,
    mark_slider_transaction_started, normalize_slider_claim_binding, pre_transaction_retry_filter,
    normalize_slider_idempotency_key, preallocate_slider_recovery_ids,
    read_slider_transaction_started_at, recover_slider_commit, seal_slider_claim_after_ambiguous_start,
    store_recovery_identifiers, verify_slider_claim_fence_in_session, SliderClaimBegin,
    SliderClaimBinding, SliderClaimError,
    SliderCommitRecovery,
    SliderRecoveryIdentifiers, SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION, slider_idempotency_index_models,
};
pub use slider_snapshot::{
    load_archived_snapshot, load_current_snapshot, load_public_snapshot, load_slider_revision,
    matches_slider_etag, slider_etag, SliderAdminItem, SliderAdminSnapshot, SliderLimits,
    SliderSnapshotError, SLIDER_METADATA_COLLECTION,
};
pub use slider_policy::{
    canonical_slider_claim_digest, canonical_slider_claim_input, effective_requires_step_up,
    normalize_create, normalize_slider_image, normalize_slider_link, normalize_slider_name,
    normalize_update, public_slider_from_document, trim_nfc, SliderAction, SliderPolicyError,
    MAX_CURRENT_SLIDERS,
    MAX_PUBLIC_SLIDERS, MAX_SLIDER_JSON_BYTES, SLIDER_MUTATION_CONTRACT,
};
pub use slider_types::{
    NormalizedSliderChanges, PublicSliderItem, SliderCreateFields, SliderCreateRequest,
    SliderSnapshotItem, SliderUpdateChanges, SliderUpdateRequest,
};
use types::*;
use utils::*;

#[cfg(test)]
mod route_contract_tests {
    #[test]
    fn slider_create_and_update_routes_use_the_shared_json_body_limit() {
        let source = include_str!("mod.rs");
        assert_eq!(
            source
                .matches("DefaultBodyLimit::max(MAX_SLIDER_JSON_BYTES)")
                .count(),
            2
        );
        assert!(source.contains("post(content::slider_mutation_create)"));
        assert!(source.contains("put(content::slider_mutation_update)"));
    }
}

pub(super) fn collect_flash_sale_product_ids(documents: &[Document]) -> Vec<ObjectId> {
    let mut ids = Vec::new();
    for document in documents {
        if let Ok(products) = document.get_array("products") {
            for product in products {
                let Some(item) = product.as_document() else {
                    continue;
                };
                if let Some(id) = object_id_from_bson(item.get("productId")) {
                    ids.push(id);
                }
            }
        }
    }
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    ids
}

fn price_from_doc(document: &Document) -> ProductPrice {
    ProductPrice {
        basic: read_i64(document, "basic"),
        gold: read_i64(document, "gold"),
        platinum: read_i64(document, "platinum"),
    }
}

pub(super) fn text_value_or_current(
    value: Option<Value>,
    current: Option<&Document>,
    key: &str,
    default: &str,
) -> String {
    match value {
        Some(value) => text_value(Some(value)).unwrap_or_default(),
        None => current
            .map(|document| read_string_default(document, key, default))
            .unwrap_or_else(|| default.to_string()),
    }
}

pub(super) fn text_value(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.trim().to_string()),
        Some(Value::Number(value)) => Some(value.to_string().trim().to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) | None => None,
    }
}

pub(super) fn i64_value(value: Option<Value>) -> Option<i64> {
    match value {
        Some(Value::Number(value)) => value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Some(Value::String(value)) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}

pub(super) fn read_string_default(document: &Document, key: &str, default: &str) -> String {
    let value = read_string(document, key);
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

pub(super) fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn string_message(status: axum::http::StatusCode, message: String) -> Response {
    (status, Json(serde_json::json!({ "message": message }))).into_response()
}

pub(super) fn not_found(message: &'static str) -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(ErrorResponse { message }),
    )
        .into_response()
}

pub(super) fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

pub(super) fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}
