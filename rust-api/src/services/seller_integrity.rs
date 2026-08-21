//! Seller order index integrity.
//!
//! `digiflazzsellerorders.refId` and `irssellerorders.refId` must each be
//! covered by exactly one unique, non-TTL, non-partial ascending index before
//! seller traffic is considered ready. API startup verifies readiness and
//! never creates these indexes; creation happens only through the
//! `seller_order_readiness` binary with the disposable-database gate.

use std::fmt;

use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Document},
    Database,
};

/// Consumed by the readiness binary; the main API binary never applies.
#[allow(dead_code)]
pub const SELLER_DISPOSABLE_DATABASE: &str = "webtopup_task14_dev";

#[derive(Clone, Debug)]
pub struct SellerOrderIndexRequirement {
    pub collection: &'static str,
    pub keys: Document,
    pub unique: bool,
}

pub fn seller_order_index_requirements() -> [SellerOrderIndexRequirement; 2] {
    [
        SellerOrderIndexRequirement {
            collection: "digiflazzsellerorders",
            keys: doc! { "refId": 1 },
            unique: true,
        },
        SellerOrderIndexRequirement {
            collection: "irssellerorders",
            keys: doc! { "refId": 1 },
            unique: true,
        },
    ]
}

/// Apply-mode gate. The parsed database name, not a URI substring or
/// environment mode, is the sole write gate. Consumed by the readiness
/// binary and policy tests, never by the API request path.
#[allow(dead_code)]
pub fn seller_apply_allowed(database: &str) -> bool {
    database == SELLER_DISPOSABLE_DATABASE
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SellerIndexState {
    Ready,
    #[default]
    Missing,
    Drifted,
}

// The Mongo variant is only rendered through Display/context on the error
// path; its payload is intentionally not exposed to responses.
#[allow(dead_code)]
#[derive(Debug)]
pub enum SellerIntegrityError {
    Mongo(mongodb::error::Error),
    NotReady {
        collection: &'static str,
        state: SellerIndexState,
    },
}

impl fmt::Display for SellerIntegrityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SellerIntegrityError::Mongo(_) => {
                write!(formatter, "seller index inspection failed")
            }
            SellerIntegrityError::NotReady { collection, state } => {
                write!(formatter, "seller index for {collection} is {state:?}")
            }
        }
    }
}

impl std::error::Error for SellerIntegrityError {}

/// Classify one index model against the exact requirement. Name is ignored.
pub fn seller_requirement_state(
    indexes: &[mongodb::IndexModel],
    requirement: &SellerOrderIndexRequirement,
) -> SellerIndexState {
    let mut drifted = false;
    for index in indexes {
        if !index.keys.contains_key("refId") {
            continue;
        }
        let options = index.options.as_ref();
        let unique = options.and_then(|options| options.unique).unwrap_or(false);
        let has_ttl = options.and_then(|options| options.expire_after).is_some();
        let has_partial = options
            .and_then(|options| options.partial_filter_expression.as_ref())
            .is_some();
        if index.keys == requirement.keys
            && unique == requirement.unique
            && !has_ttl
            && !has_partial
        {
            return SellerIndexState::Ready;
        }
        drifted = true;
    }
    if drifted {
        SellerIndexState::Drifted
    } else {
        SellerIndexState::Missing
    }
}

pub async fn inspect_seller_index_state(
    db: &Database,
    requirement: &SellerOrderIndexRequirement,
) -> Result<SellerIndexState, SellerIntegrityError> {
    let indexes = db
        .collection::<Document>(requirement.collection)
        .list_indexes()
        .await
        .map_err(SellerIntegrityError::Mongo)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(SellerIntegrityError::Mongo)?;
    Ok(seller_requirement_state(&indexes, requirement))
}

/// Verification-only readiness gate used by API startup.
pub async fn ensure_seller_order_indexes_ready(db: &Database) -> Result<(), SellerIntegrityError> {
    for requirement in seller_order_index_requirements() {
        let state = inspect_seller_index_state(db, &requirement).await?;
        if state != SellerIndexState::Ready {
            return Err(SellerIntegrityError::NotReady {
                collection: requirement.collection,
                state,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seller_ref_indexes_are_exact_unique_and_non_ttl() {
        let requirements = seller_order_index_requirements();
        assert_eq!(
            requirements.clone().map(|item| item.collection),
            ["digiflazzsellerorders", "irssellerorders"]
        );
        for requirement in &requirements {
            assert_eq!(requirement.keys, doc! { "refId": 1 });
            assert!(requirement.unique);
        }
    }

    #[test]
    fn apply_is_allowed_only_for_exact_disposable_database() {
        assert!(seller_apply_allowed("webtopup_task14_dev"));
        for name in [
            "webtopup",
            "POBB",
            "webtopup_task14_dev_backup",
            "admin",
            "",
        ] {
            assert!(!seller_apply_allowed(name), "{name} must not allow apply");
        }
    }

    #[test]
    fn semantic_index_state_accepts_exact_unique_without_ttl_or_partial() {
        let requirement = seller_order_index_requirements()[0].clone();
        let exact = mongodb::IndexModel::builder()
            .keys(doc! { "refId": 1 })
            .options(
                mongodb::options::IndexOptions::builder()
                    .unique(true)
                    .name("any_name".to_string())
                    .build(),
            )
            .build();
        assert_eq!(
            seller_requirement_state(&[exact], &requirement),
            SellerIndexState::Ready
        );

        let non_unique = mongodb::IndexModel::builder()
            .keys(doc! { "refId": 1 })
            .options(mongodb::options::IndexOptions::builder().build())
            .build();
        assert_eq!(
            seller_requirement_state(&[non_unique.clone()], &requirement),
            SellerIndexState::Drifted
        );

        let partial = mongodb::IndexModel::builder()
            .keys(doc! { "refId": 1 })
            .options(
                mongodb::options::IndexOptions::builder()
                    .unique(true)
                    .partial_filter_expression(doc! { "status": "pending" })
                    .build(),
            )
            .build();
        assert_eq!(
            seller_requirement_state(&[partial], &requirement),
            SellerIndexState::Drifted
        );

        assert_eq!(
            seller_requirement_state(&[], &requirement),
            SellerIndexState::Missing
        );
    }
}
