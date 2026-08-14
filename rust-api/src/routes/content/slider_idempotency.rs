//! Slider idempotency index foundation.
//!
//! Claim lifecycle and recovery behavior are intentionally deferred to Task 8.  This module only
//! exposes exact semantic index models and constants to readiness/startup code.

use mongodb::{bson::doc, options::IndexOptions, IndexModel};

pub const SLIDER_IDEMPOTENCY_CLAIMS_COLLECTION: &str = "slideridempotencyclaims";
pub const SLIDER_CLAIM_KEY_INDEX: &str = "slider_claim_key_unique";
pub const SLIDER_CLAIM_STATE_INDEX: &str = "slider_claim_state_lease";
pub const SLIDER_CLAIM_COMMIT_UNKNOWN_INDEX: &str = "slider_claim_commit_unknown";

pub fn slider_idempotency_index_models() -> Vec<IndexModel> {
    vec![
        IndexModel::builder()
            .keys(doc! { "key": 1 })
            .options(IndexOptions::builder().name(SLIDER_CLAIM_KEY_INDEX.to_string()).unique(true).build())
            .build(),
        IndexModel::builder()
            .keys(doc! { "state": 1, "leaseExpiresAt": 1 })
            .options(IndexOptions::builder().name(SLIDER_CLAIM_STATE_INDEX.to_string()).build())
            .build(),
        IndexModel::builder()
            .keys(doc! { "commitUnknown": 1, "transactionStartedAt": 1 })
            .options(IndexOptions::builder().name(SLIDER_CLAIM_COMMIT_UNKNOWN_INDEX.to_string()).build())
            .build(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_indexes_are_permanent_and_exact() {
        let models = slider_idempotency_index_models();
        let key = models.iter().find(|model| model.keys == doc! { "key": 1 }).unwrap();
        assert_eq!(key.options.as_ref().and_then(|options| options.unique), Some(true));
        assert!(models.iter().all(|model| model.options.as_ref().and_then(|options| options.expire_after).is_none()));
        assert!(models.iter().any(|model| model.keys == doc! { "state": 1, "leaseExpiresAt": 1 }));
        assert!(models.iter().any(|model| model.keys == doc! { "commitUnknown": 1, "transactionStartedAt": 1 }));
    }
}
