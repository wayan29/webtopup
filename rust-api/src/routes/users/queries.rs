use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use crate::utils::bson::{read_i64, read_string};

use super::{
    mappers::{read_f64, user_item_from_doc},
    types::{AdjustmentActor, UserItem, UserSummary},
};

pub(super) async fn build_summary(db: &mongodb::Database) -> UserSummary {
    let pipeline = vec![
        doc! { "$match": { "role": "member" } },
        doc! { "$group": {
            "_id": Bson::Null,
            "totalMembers": { "$sum": 1 },
            "activeMembers": { "$sum": { "$cond": [{ "$eq": ["$active", false] }, 0, 1] } },
            "inactiveMembers": { "$sum": { "$cond": [{ "$eq": ["$active", false] }, 1, 0] } },
            "totalBalance": { "$sum": "$balance" }
        } },
    ];
    let docs = match db.collection::<Document>("users").aggregate(pipeline).await {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let Some(document) = docs.first() else {
        return UserSummary::default();
    };
    UserSummary {
        id: Some(serde_json::Value::Null),
        total_members: read_i64(document, "totalMembers"),
        active_members: read_i64(document, "activeMembers"),
        inactive_members: read_i64(document, "inactiveMembers"),
        total_balance: read_f64(document, "totalBalance"),
    }
}

pub(super) async fn ensure_member_exists(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
) -> Result<(), ()> {
    users
        .find_one(doc! { "_id": user_id, "role": "member" })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .map(|_| ())
        .ok_or(())
}

pub(super) async fn load_member_user_item(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
) -> Option<UserItem> {
    users
        .find_one(doc! { "_id": user_id, "role": "member" })
        .projection(member_projection())
        .await
        .ok()
        .flatten()
        .map(user_item_from_doc)
}

pub(super) async fn load_docs(
    db: &mongodb::Database,
    collection: &str,
    filter: Document,
    projection: Document,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .find(filter)
        .projection(projection)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) async fn product_labels(
    db: &mongodb::Database,
    transactions: &[Document],
) -> HashMap<String, (String, String)> {
    let mut ids = transactions
        .iter()
        .filter_map(|doc| doc.get_object_id("product").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    match db
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "name": 1, "code": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = doc
                    .get_object_id("_id")
                    .map(|id| id.to_hex())
                    .unwrap_or_default();
                (id, (read_string(&doc, "name"), read_string(&doc, "code")))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn adjustment_actors(
    db: &mongodb::Database,
    adjustments: &[Document],
) -> HashMap<String, AdjustmentActor> {
    let mut ids = adjustments
        .iter()
        .filter_map(|doc| doc.get_object_id("adjustedBy").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    match db
        .collection::<Document>("users")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "name": 1, "email": 1, "role": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|doc| {
                let id = doc
                    .get_object_id("_id")
                    .map(|id| id.to_hex())
                    .unwrap_or_default();
                (
                    id.clone(),
                    AdjustmentActor {
                        id,
                        name: read_string(&doc, "name"),
                        email: read_string(&doc, "email"),
                        role: read_string(&doc, "role"),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) fn member_projection() -> Document {
    doc! {
        "name": 1,
        "email": 1,
        "level": 1,
        "balance": 1,
        "points": 1,
        "active": 1,
        "memberCode": 1,
        // Projected only to derive hasOpenApiKey; never serialized raw.
        "apiKey": 1,
        "createdAt": 1,
        "updatedAt": 1,
    }
}
