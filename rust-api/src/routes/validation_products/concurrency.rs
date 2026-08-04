use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

pub const MAX_JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(super) fn validate_expected_version(version: i64) -> Result<i64, ()> {
    if (0..=MAX_JS_SAFE_INTEGER).contains(&version) {
        Ok(version)
    } else {
        Err(())
    }
}

pub(super) fn validation_product_version_for_mutation(document: &Document) -> Result<i64, ()> {
    match document.get("__v") {
        None => Ok(0),
        Some(Bson::Int32(value)) => {
            let value = i64::from(*value);
            if (0..=MAX_JS_SAFE_INTEGER).contains(&value) {
                Ok(value)
            } else {
                Err(())
            }
        }
        Some(Bson::Int64(value)) => {
            if (0..=MAX_JS_SAFE_INTEGER).contains(value) {
                Ok(*value)
            } else {
                Err(())
            }
        }
        _ => Err(()),
    }
}

pub(super) fn validation_product_version_for_response(document: &Document) -> Option<i64> {
    validation_product_version_for_mutation(document).ok()
}

pub(super) fn active_version_filter(id: ObjectId, version: i64) -> Document {
    let mut filter = doc! {
        "_id": id,
        "validation.enabled": true,
        "validation.archived": { "$ne": true },
    };
    if version == 0 {
        filter.insert(
            "$or",
            vec![
                Bson::Document(doc! { "__v": { "$exists": false } }),
                Bson::Document(doc! { "__v": 0_i64 }),
            ],
        );
    } else {
        filter.insert("__v", version);
    }
    filter
}

pub(super) fn versioned_update(set_doc: Document) -> Document {
    doc! {
        "$set": set_doc,
        "$inc": { "__v": 1_i64 },
    }
}

pub(super) fn validation_product_version(document: &Document) -> i64 {
    validation_product_version_for_mutation(document).unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;

    #[test]
    fn validate_expected_version_accepts_safe_range_and_rejects_out_of_range() {
        assert_eq!(validate_expected_version(0), Ok(0));
        assert_eq!(
            validate_expected_version(MAX_JS_SAFE_INTEGER),
            Ok(MAX_JS_SAFE_INTEGER)
        );
        assert_eq!(validate_expected_version(-1), Err(()));
        assert_eq!(validate_expected_version(MAX_JS_SAFE_INTEGER + 1), Err(()));
    }

    #[test]
    fn legacy_missing_version_maps_to_zero_for_mutation_and_response() {
        let document = doc! { "_id": ObjectId::new(), "code": "LEGACY" };
        assert_eq!(validation_product_version_for_mutation(&document), Ok(0));
        assert_eq!(validation_product_version_for_response(&document), Some(0));
    }

    #[test]
    fn malformed_stored_version_is_not_mutable_or_emitted() {
        let document = doc! { "_id": ObjectId::new(), "__v": "bad" };
        assert_eq!(validation_product_version_for_mutation(&document), Err(()));
        assert_eq!(validation_product_version_for_response(&document), None);
    }

    #[test]
    fn active_version_filter_for_zero_matches_missing_or_zero() {
        let id = ObjectId::new();
        let filter = active_version_filter(id, 0);
        assert_eq!(filter.get_object_id("_id").ok(), Some(id));
        let or_clause = filter.get_array("$or").expect("$or");
        assert_eq!(or_clause.len(), 2);
    }

    #[test]
    fn active_version_filter_for_nonzero_uses_exact_version() {
        let id = ObjectId::new();
        let filter = active_version_filter(id, 3);
        assert_eq!(crate::utils::bson::read_i64(&filter, "__v"), 3);
        assert!(filter.get("$or").is_none());
    }

    #[test]
    fn versioned_update_sets_fields_and_increments_version() {
        let mut set_doc = Document::new();
        set_doc.insert("status", false);
        let update = versioned_update(set_doc);
        let set = update.get_document("$set").expect("$set");
        assert_eq!(set.get_bool("status").ok(), Some(false));
        let inc = update.get_document("$inc").expect("$inc");
        assert_eq!(crate::utils::bson::read_i64(inc, "__v"), 1);
    }
}
