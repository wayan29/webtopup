use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ReturnDocument;
use mongodb::Database;

pub const PRODUCT_ID_COUNTER: &str = "products.productId";
/// JavaScript `Number.MAX_SAFE_INTEGER` — upper bound for interoperable counter `seq` values.
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub const MAX_PRODUCT_ID_INSERT_ATTEMPTS: usize = 3;

pub async fn allocate_product_id(db: &Database) -> Result<i64, mongodb::error::Error> {
    let counters = db.collection::<Document>("counters");
    let updated = counters
        .find_one_and_update(
            doc! { "_id": PRODUCT_ID_COUNTER },
            doc! { "$inc": { "seq": 1_i64 } },
        )
        .upsert(true)
        .return_document(ReturnDocument::After)
        .await?;

    let Some(document) = updated else {
        return Err(mongodb::error::Error::custom(
            "product id counter update returned no document",
        ));
    };
    let seq = decode_counter_seq(document.get("seq")).map_err(|reason| {
        mongodb::error::Error::custom(format!("invalid product id counter seq: {reason}"))
    })?;
    Ok(seq)
}

/// Strict decoder for `counters.seq` shared with Node (Mongoose `Number` → BSON Double).
pub fn decode_counter_seq(value: Option<&Bson>) -> Result<i64, &'static str> {
    match value {
        None => Err("missing"),
        Some(Bson::Int32(v)) => {
            let n = i64::from(*v);
            if n <= 0 {
                Err("non_positive")
            } else if n > JS_MAX_SAFE_INTEGER {
                Err("out_of_safe_range")
            } else {
                Ok(n)
            }
        }
        Some(Bson::Int64(v)) => {
            if *v <= 0 {
                Err("non_positive")
            } else if *v > JS_MAX_SAFE_INTEGER {
                Err("out_of_safe_range")
            } else {
                Ok(*v)
            }
        }
        Some(Bson::Double(v)) => {
            if !v.is_finite() {
                return Err("non_finite");
            }
            if *v <= 0.0 {
                return Err("non_positive");
            }
            if v.fract() != 0.0 {
                return Err("fractional");
            }
            if *v > JS_MAX_SAFE_INTEGER as f64 {
                return Err("out_of_safe_range");
            }
            Ok(*v as i64)
        }
        Some(_) => Err("invalid_type"),
    }
}

pub fn decode_counter_seq_from_document(document: &Document) -> Result<i64, &'static str> {
    decode_counter_seq(document.get("seq"))
}

pub fn counter_seed_update(max_product_id: i64) -> Document {
    doc! { "$max": { "seq": max_product_id.max(0) } }
}

pub fn should_retry_duplicate_product_id(error: &mongodb::error::Error, attempt: usize) -> bool {
    is_duplicate_key(error) && should_retry_duplicate_product_id_attempt(attempt)
}

/// Returns true when another insert attempt may run after a productId duplicate (0-based attempt index).
pub fn should_retry_duplicate_product_id_attempt(attempt: usize) -> bool {
    attempt + 1 < MAX_PRODUCT_ID_INSERT_ATTEMPTS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicateKeyConstraint {
    ProductId,
    Code,
    Unknown,
}

pub fn classify_duplicate_key_constraint(error: &mongodb::error::Error) -> DuplicateKeyConstraint {
    let display = error.to_string();
    let debug = format!("{error:?}");
    classify_duplicate_key_messages(&display, &debug)
}

pub fn classify_duplicate_key_messages(display: &str, debug: &str) -> DuplicateKeyConstraint {
    if !duplicate_key_in_message(display) && !duplicate_key_in_message(debug) {
        return DuplicateKeyConstraint::Unknown;
    }
    let haystack = format!("{display}\n{debug}");
    if duplicate_key_targets_product_id(&haystack) {
        return DuplicateKeyConstraint::ProductId;
    }
    if duplicate_key_targets_code(&haystack) {
        return DuplicateKeyConstraint::Code;
    }
    DuplicateKeyConstraint::Unknown
}

pub fn duplicate_key_targets_code(message: &str) -> bool {
    if !(message.contains("E11000") || message.contains("duplicate key")) {
        return false;
    }
    message.contains("uniq_products_code")
        || message.contains("code_1")
        || message.contains("index: code")
        || message.contains("dup key: { code:")
        || message.contains("dup key: { \"code\"")
}

pub fn accepted_product_id_from_bson(value: &mongodb::bson::Bson) -> Option<i64> {
    use mongodb::bson::Bson;
    match value {
        Bson::Int32(v) => {
            let n = i64::from(*v);
            (n > 0).then_some(n)
        }
        Bson::Int64(v) => (*v > 0).then_some(*v),
        _ => None,
    }
}

pub fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    duplicate_key_in_message(&error.to_string()) || duplicate_key_in_message(&format!("{error:?}"))
}

pub fn duplicate_key_in_message(message: &str) -> bool {
    message.contains("E11000") || message.contains("duplicate key")
}

pub fn duplicate_key_targets_product_id(message: &str) -> bool {
    if !(message.contains("E11000") || message.contains("duplicate key")) {
        return false;
    }
    message.contains("productId") || message.contains("uniq_products_productId")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::Bson;

    fn seq_from_seed_update(update: &Document) -> i64 {
        update
            .get("$max")
            .and_then(|v| v.as_document())
            .and_then(|d| d.get("seq"))
            .map(|b| match b {
                Bson::Int32(v) => i64::from(*v),
                Bson::Int64(v) => *v,
                Bson::Double(v) => *v as i64,
                _ => -1,
            })
            .unwrap_or(-1)
    }

    #[test]
    fn counter_seed_update_clamps_negative_to_zero() {
        let update = counter_seed_update(-5);
        assert_eq!(seq_from_seed_update(&update), 0);
    }

    #[test]
    fn counter_seed_update_uses_max_only() {
        let update = counter_seed_update(42);
        assert_eq!(update.len(), 1);
        assert!(update.contains_key("$max"));
        assert!(!update.contains_key("$set"));
        assert_eq!(seq_from_seed_update(&update), 42);
    }

    #[test]
    fn should_retry_stops_at_max_attempts() {
        let msg = "E11000 duplicate key on productId";
        assert!(duplicate_key_in_message(msg));
        assert!(should_retry_duplicate_product_id_attempt(0));
        assert!(should_retry_duplicate_product_id_attempt(1));
        assert!(!should_retry_duplicate_product_id_attempt(2));
        assert!(!should_retry_duplicate_product_id_attempt(3));
    }

    #[test]
    fn should_not_retry_non_duplicate_errors() {
        let error = mongodb::error::Error::custom("network timeout");
        assert!(!should_retry_duplicate_product_id(&error, 0));
    }

    #[test]
    fn duplicate_product_id_detection() {
        let product_id_msg = "E11000 duplicate key error index: uniq_products_productId";
        let code_msg = "E11000 duplicate key error index: code_1";
        assert!(duplicate_key_targets_product_id(product_id_msg));
        assert!(!duplicate_key_targets_product_id(code_msg));
    }

    #[test]
    fn accepted_product_id_rejects_non_integral_and_non_positive() {
        use mongodb::bson::Bson;
        assert_eq!(accepted_product_id_from_bson(&Bson::Int32(7)), Some(7));
        assert_eq!(accepted_product_id_from_bson(&Bson::Int64(9)), Some(9));
        assert_eq!(accepted_product_id_from_bson(&Bson::Int32(0)), None);
        assert_eq!(accepted_product_id_from_bson(&Bson::Int32(-1)), None);
        assert_eq!(accepted_product_id_from_bson(&Bson::Double(4.0)), None);
        assert_eq!(
            accepted_product_id_from_bson(&Bson::String("1".into())),
            None
        );
    }

    #[test]
    fn classify_duplicate_constraints_explicitly() {
        let product_id = "E11000 duplicate key error index: uniq_products_productId dup key";
        let code = "E11000 duplicate key error index: code_1 dup key: { code: \"X\" }";
        let unknown = "E11000 duplicate key error index: other_field_1";
        assert_eq!(
            classify_duplicate_key_messages(product_id, ""),
            DuplicateKeyConstraint::ProductId
        );
        assert_eq!(
            classify_duplicate_key_messages(code, ""),
            DuplicateKeyConstraint::Code
        );
        assert_eq!(
            classify_duplicate_key_messages(unknown, ""),
            DuplicateKeyConstraint::Unknown
        );
    }

    #[test]
    fn unknown_duplicate_is_not_classified_as_code() {
        let unknown = "E11000 duplicate key error index: sku_1";
        assert_eq!(
            classify_duplicate_key_messages(unknown, ""),
            DuplicateKeyConstraint::Unknown
        );
        assert!(!duplicate_key_targets_code(unknown));
    }

    #[test]
    fn vendor_sync_source_uses_shared_allocator_not_max_plus_one() {
        let src = include_str!("../routes/vendors/providers.rs");
        assert!(
            !src.contains("next_synced_product_id"),
            "vendor sync must not retain max+1 next_synced_product_id"
        );
        assert!(
            src.contains("allocate_product_id"),
            "vendor sync must call allocate_product_id"
        );
    }

    #[test]
    fn mongoose_product_model_source_uses_atomic_counter_not_max_plus_one() {
        let src = include_str!("../../../server/src/models/Product.ts");
        assert!(
            !src.contains("sort({ productId: -1 })")
                && !src.contains("lastProduct?.productId || 0) + 1"),
            "Product pre-save must not use max+1"
        );
        assert!(
            src.contains("allocateProductId"),
            "Product pre-save must use allocateProductId"
        );
    }

    #[test]
    fn should_retry_duplicate_product_id_uses_remaining_attempts() {
        let msg = "E11000 duplicate key error index: uniq_products_productId";
        assert_eq!(
            classify_duplicate_key_messages(msg, msg),
            DuplicateKeyConstraint::ProductId
        );
        assert!(should_retry_duplicate_product_id_attempt(0));
        assert!(should_retry_duplicate_product_id_attempt(1));
        assert!(!should_retry_duplicate_product_id_attempt(2));
    }

    #[test]
    fn decode_counter_seq_accepts_safe_integral_double() {
        assert_eq!(decode_counter_seq(Some(&Bson::Double(42.0))), Ok(42));
        assert_eq!(
            decode_counter_seq(Some(&Bson::Double(JS_MAX_SAFE_INTEGER as f64))),
            Ok(JS_MAX_SAFE_INTEGER)
        );
    }

    #[test]
    fn decode_counter_seq_rejects_malformed_counter_values() {
        assert_eq!(decode_counter_seq(None), Err("missing"));
        assert_eq!(
            decode_counter_seq(Some(&Bson::Int32(0))),
            Err("non_positive")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::Int64(-1))),
            Err("non_positive")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::Double(1.5))),
            Err("fractional")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::Double(f64::NAN))),
            Err("non_finite")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::Double(f64::INFINITY))),
            Err("non_finite")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::Double((JS_MAX_SAFE_INTEGER + 1) as f64))),
            Err("out_of_safe_range")
        );
        assert_eq!(
            decode_counter_seq(Some(&Bson::String("1".into()))),
            Err("invalid_type")
        );
    }
}
