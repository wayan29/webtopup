use axum::{response::{IntoResponse, Response}, Json};
use serde_json::Value;

use crate::security::ErrorResponse;

mod flash_admin;
mod flash_public;
mod slider_idempotency;
mod slider_mutation;
mod slider_policy;
mod slider_snapshot;
mod slider_types;
pub mod sliders;

pub use flash_admin::{
    flash_sale_add_product, flash_sale_admin_detail, flash_sale_create, flash_sale_delete,
    flash_sale_remove_product, flash_sale_update, flash_sales_admin_all, FlashSalePayload,
    FlashSaleProductPayload,
};
pub use flash_public::{flash_sale_price, flash_sales_active};
pub use sliders::{
    slider_delete, sliders_admin_all, sliders_admin_archived, sliders_public,
    sliders_update_sort_order,
};
pub use slider_mutation::{
    execute_slider_mutation,
    slider_create as slider_mutation_create,
    slider_update as slider_mutation_update,
    slider_archive as slider_mutation_archive,
    slider_restore as slider_mutation_restore,
    slider_reorder as slider_mutation_reorder,
};
pub use slider_idempotency::{
    begin_slider_claim, normalize_slider_claim_binding, normalize_slider_idempotency_key,
    SliderClaimBegin, SliderClaimBinding, SliderClaimError, SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION,
};
pub use slider_snapshot::{
    load_archived_snapshot, load_current_snapshot, load_public_snapshot, load_slider_revision,
    matches_slider_etag, slider_capability_marker, slider_etag, SliderAdminItem, SliderAdminSnapshot,
    SliderLimits, SliderSnapshotError, SLIDER_METADATA_COLLECTION,
};
pub use slider_policy::{
    canonical_slider_claim_digest, canonical_slider_claim_input, effective_requires_step_up,
    normalize_create, normalize_slider_image, normalize_slider_link, normalize_slider_name,
    normalize_update, public_slider_from_fields, trim_nfc, validate_slider_order_entries,
    SliderAction, SliderPolicyError,
    MAX_CURRENT_SLIDERS,
    MAX_PUBLIC_SLIDERS, MAX_SLIDER_JSON_BYTES, SLIDER_MUTATION_CONTRACT,
};
pub use slider_types::{
    NormalizedSliderChanges, PublicSliderItem, SliderCreateFields, SliderCreateRequest,
    SliderLifecycleRequest, SliderOrderItem, SliderReorderRequest, SliderSnapshotItem,
    SliderUpdateChanges, SliderUpdateRequest,
};

#[cfg(test)]
mod route_contract_tests {
    #[test]
    fn slider_mutation_routes_use_the_shared_json_body_limit() {
        let source = include_str!("mod.rs");
        assert_eq!(
            source
                .matches("DefaultBodyLimit::max(MAX_SLIDER_JSON_BYTES)")
                .count(),
            5
        );
        assert!(source.contains("post(content::slider_mutation_create)"));
        assert!(source.contains("put(content::slider_mutation_update)"));
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
            message: "Database unavailable",
        }),
    )
        .into_response()
}
