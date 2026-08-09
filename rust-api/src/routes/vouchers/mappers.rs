use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use super::types::{UserBrief, VoucherItem};
use crate::utils::bson::{read_i64, read_string};

pub(super) async fn user_briefs(
    db: &mongodb::Database,
    vouchers: &[Document],
) -> HashMap<String, UserBrief> {
    let mut ids = Vec::new();
    for document in vouchers {
        for key in ["redeemedBy", "createdBy", "archivedBy"] {
            if let Some(id) = object_id_from_bson(document.get(key)) {
                ids.push(id);
            }
        }
    }
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    match db
        .collection::<Document>("users")
        .find(doc! { "_id": { "$in": ids } })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = id_from_doc(&doc);
                (
                    id.clone(),
                    UserBrief {
                        id,
                        email: read_string(&doc, "email"),
                        name: read_string(&doc, "name"),
                        role: read_string(&doc, "role"),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) fn voucher_from_doc(
    document: Document,
    users: &HashMap<String, UserBrief>,
) -> VoucherItem {
    let kind = {
        let raw = read_string(&document, "kind");
        if raw.is_empty() {
            "balance".to_string()
        } else {
            raw
        }
    };
    let is_discount = kind == "discount";
    VoucherItem {
        id: id_from_doc(&document),
        code: read_string(&document, "code"),
        amount: read_i64(&document, "amount"),
        kind,
        discount_type: if is_discount {
            Some(read_string(&document, "discountType"))
        } else {
            None
        },
        discount_value: if is_discount {
            Some(read_i64(&document, "discountValue"))
        } else {
            None
        },
        max_uses: if is_discount {
            Some(read_i64(&document, "maxUses"))
        } else {
            None
        },
        used_count: if is_discount {
            Some(read_i64(&document, "usedCount"))
        } else {
            None
        },
        min_purchase: if is_discount {
            Some(read_i64(&document, "minPurchase"))
        } else {
            None
        },
        max_discount: if is_discount {
            Some(read_i64(&document, "maxDiscount"))
        } else {
            None
        },
        one_per_user: if is_discount {
            Some(document.get_bool("onePerUser").unwrap_or(true))
        } else {
            None
        },
        product_ids: if is_discount {
            Some(object_id_hex_list(&document, "productIds"))
        } else {
            None
        },
        category_ids: if is_discount {
            Some(object_id_hex_list(&document, "categoryIds"))
        } else {
            None
        },
        operator_ids: if is_discount {
            Some(object_id_hex_list(&document, "operatorIds"))
        } else {
            None
        },
        starts_at: optional_date_string(&document, "startsAt"),
        expires_at: optional_date_string(&document, "expiresAt"),
        is_redeemed: document.get_bool("isRedeemed").unwrap_or(false),
        is_archived: document.get_bool("isArchived").unwrap_or(false),
        redeemed_at: optional_date_string(&document, "redeemedAt"),
        redeemed_balance_before: number_from_bson(document.get("redeemedBalanceBefore")),
        redeemed_balance_after: number_from_bson(document.get("redeemedBalanceAfter")),
        archive_reason: optional_string(&document, "archiveReason"),
        archived_at: optional_date_string(&document, "archivedAt"),
        created_at: date_string(&document, "createdAt"),
        updated_at: optional_date_string(&document, "updatedAt"),
        version: number_from_bson(document.get("__v")),
        redeemed_by: user_for_key(&document, users, "redeemedBy"),
        created_by: user_for_key(&document, users, "createdBy"),
        archived_by: user_for_key(&document, users, "archivedBy"),
    }
}

pub(super) fn id_from_doc(document: &Document) -> String {
    id_from_bson(document.get("_id"))
}

pub(super) fn id_from_bson(value: Option<&Bson>) -> String {
    match value {
        Some(Bson::ObjectId(id)) => id.to_hex(),
        Some(Bson::String(id)) => id.clone(),
        _ => String::new(),
    }
}

pub(super) fn object_id_from_bson(value: Option<&Bson>) -> Option<ObjectId> {
    match value {
        Some(Bson::ObjectId(id)) => Some(*id),
        Some(Bson::String(id)) => ObjectId::parse_str(id).ok(),
        _ => None,
    }
}

fn object_id_hex_list(document: &Document, key: &str) -> Vec<String> {
    document
        .get_array(key)
        .ok()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| match value {
                    Bson::ObjectId(id) => Some(id.to_hex()),
                    Bson::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn number_from_bson(value: Option<&Bson>) -> Option<i64> {
    match value {
        Some(Bson::Int32(value)) => Some(i64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value),
        Some(Bson::Double(value)) => Some(*value as i64),
        _ => None,
    }
}

fn user_for_key(
    document: &Document,
    users: &HashMap<String, UserBrief>,
    key: &str,
) -> Option<UserBrief> {
    users.get(&id_from_bson(document.get(key))).cloned()
}

fn optional_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_str(key)
        .ok()
        .map(ToString::to_string)
        .filter(|value| !value.is_empty())
}

fn date_string(document: &Document, key: &str) -> String {
    optional_date_string(document, key).unwrap_or_default()
}

fn optional_date_string(document: &Document, key: &str) -> Option<String> {
    document.get_datetime(key).ok().map(|value| {
        value
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| value.to_string())
    })
}
