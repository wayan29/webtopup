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
    VoucherItem {
        id: id_from_doc(&document),
        code: read_string(&document, "code"),
        amount: read_i64(&document, "amount"),
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
