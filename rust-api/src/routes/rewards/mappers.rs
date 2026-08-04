use std::collections::HashMap;

use mongodb::bson::{oid::ObjectId, Bson, Document};

use super::types::{
    PointTransactionItem, PointsHistoryItem, RelatedTransactionBrief, RewardBrief, RewardItem,
    UserBrief,
};
use crate::utils::bson::{read_i64, read_string};

pub(super) fn reward_from_doc(document: Document) -> RewardItem {
    RewardItem {
        id: id_from_doc(&document),
        name: read_string(&document, "name"),
        description: read_string(&document, "description"),
        points_required: read_i64(&document, "pointsRequired"),
        stock: read_i64(&document, "stock"),
        image_url: document.get_str("imageUrl").ok().map(ToString::to_string),
        category: read_string(&document, "category"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn point_transaction_from_doc(
    document: Document,
    users: &HashMap<String, UserBrief>,
    rewards: &HashMap<String, RewardBrief>,
) -> PointTransactionItem {
    let user_id = id_from_bson(document.get("user"));
    let reward_id = id_from_bson(document.get("relatedReward"));
    PointTransactionItem {
        id: id_from_doc(&document),
        user: users.get(&user_id).cloned(),
        transaction_type: read_string(&document, "type"),
        points: read_i64(&document, "points"),
        description: read_string(&document, "description"),
        related_reward: rewards.get(&reward_id).cloned(),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn points_history_item_from_doc(
    document: Document,
    rewards: &HashMap<String, RewardBrief>,
    transactions: &HashMap<String, RelatedTransactionBrief>,
) -> PointsHistoryItem {
    let reward_id = id_from_bson(document.get("relatedReward"));
    let transaction_id = id_from_bson(document.get("relatedTransaction"));
    PointsHistoryItem {
        id: id_from_doc(&document),
        user: id_from_bson(document.get("user")),
        transaction_type: read_string(&document, "type"),
        points: read_i64(&document, "points"),
        description: read_string(&document, "description"),
        related_reward: rewards.get(&reward_id).cloned(),
        related_transaction: transactions.get(&transaction_id).cloned(),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn object_ids_from_docs(documents: &[Document], key: &str) -> Vec<ObjectId> {
    let mut ids = documents
        .iter()
        .filter_map(|doc| object_id_from_bson(doc.get(key)))
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    ids
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

fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}
