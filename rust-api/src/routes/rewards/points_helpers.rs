use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use super::{mappers::*, types::*, validation::number_from_bson};
use crate::utils::bson::{read_i64, read_string};

pub(super) async fn upsert_setting(
    settings: &mongodb::Collection<Document>,
    key: &str,
    value: i64,
    description: &str,
) -> Result<(), ()> {
    let now = DateTime::now();
    settings
        .update_one(
            doc! { "key": key },
            doc! {
                "$set": { "value": value, "description": description, "updatedAt": now },
                "$setOnInsert": { "key": key, "createdAt": now, "__v": 0 },
            },
        )
        .upsert(true)
        .await
        .map(|_| ())
        .map_err(|_| ())
}

pub(super) async fn user_briefs(
    db: &mongodb::Database,
    transactions: &[Document],
) -> HashMap<String, UserBrief> {
    let ids = object_ids_from_docs(transactions, "user");
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
                        name: read_string(&doc, "name"),
                        email: read_string(&doc, "email"),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn reward_briefs(
    db: &mongodb::Database,
    transactions: &[Document],
) -> HashMap<String, RewardBrief> {
    let ids = object_ids_from_docs(transactions, "relatedReward");
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>("rewards")
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
                    RewardBrief {
                        id,
                        name: read_string(&doc, "name"),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn transaction_briefs(
    db: &mongodb::Database,
    point_transactions: &[Document],
) -> HashMap<String, RelatedTransactionBrief> {
    let ids = object_ids_from_docs(point_transactions, "relatedTransaction");
    if ids.is_empty() {
        return HashMap::new();
    }

    let transactions = match db
        .collection::<Document>("transactions")
        .find(doc! { "_id": { "$in": ids } })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_ids = transactions
        .iter()
        .filter_map(|doc| object_id_from_bson(doc.get("product")))
        .collect::<Vec<_>>();
    let product_map = product_briefs(db, product_ids).await;

    transactions
        .into_iter()
        .map(|doc| {
            let id = id_from_doc(&doc);
            let product_id = id_from_bson(doc.get("product"));
            (
                id.clone(),
                RelatedTransactionBrief {
                    id,
                    amount: read_i64(&doc, "amount"),
                    target: read_string(&doc, "target"),
                    status: read_string(&doc, "status"),
                    product: product_map.get(&product_id).cloned(),
                },
            )
        })
        .collect()
}

pub(super) async fn user_points(
    db: &mongodb::Database,
    object_id: Option<ObjectId>,
    user_id: &str,
) -> i64 {
    let filter = object_id
        .map(|id| doc! { "_id": id })
        .unwrap_or_else(|| doc! { "_id": user_id });
    db.collection::<Document>("users")
        .find_one(filter)
        .await
        .ok()
        .flatten()
        .map(|doc| read_i64(&doc, "points"))
        .unwrap_or_default()
}

pub(super) async fn rollback_user_points(
    users: &mongodb::Collection<Document>,
    user_id: ObjectId,
    points_delta: i64,
) {
    if let Err(error) = users
        .update_one(
            doc! { "_id": user_id },
            doc! { "$inc": { "points": -points_delta }, "$set": { "updatedAt": DateTime::now() } },
        )
        .await
    {
        eprintln!("Failed to roll back user points mutation: {error}");
    }
}

pub(super) async fn setting_value(db: &mongodb::Database, key: &str, fallback: i64) -> i64 {
    db.collection::<Document>("settings")
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|doc| number_from_bson(doc.get("value")))
        .unwrap_or(fallback)
}

pub(super) async fn sum_points(
    collection: &mongodb::Collection<Document>,
    filter: Document,
    absolute: bool,
) -> i64 {
    let group_sum = if absolute {
        doc! { "$sum": { "$abs": "$points" } }
    } else {
        doc! { "$sum": "$points" }
    };
    match collection
        .aggregate(vec![
            doc! { "$match": filter },
            doc! { "$group": { "_id": Bson::Null, "total": group_sum } },
        ])
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .first()
            .and_then(|doc| number_from_bson(doc.get("total")))
            .unwrap_or_default(),
        Err(_) => 0,
    }
}

async fn product_briefs(
    db: &mongodb::Database,
    mut ids: Vec<ObjectId>,
) -> HashMap<String, ProductBrief> {
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }

    match db
        .collection::<Document>("products")
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
                    ProductBrief {
                        id,
                        name: read_string(&doc, "name"),
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}
