use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::utils::bson::read_string;

pub async fn user_level(db: &mongodb::Database, user_id: ObjectId) -> String {
    db.collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "level": 1 })
        .await
        .ok()
        .flatten()
        .map(|doc| read_string(&doc, "level"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "basic".to_string())
}

pub async fn name_map(
    db: &mongodb::Database,
    collection: &str,
    ids: Vec<ObjectId>,
) -> HashMap<String, String> {
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>(collection)
        .find(doc! { "_id": { "$in": ids } })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| {
                Some((
                    doc.get_object_id("_id").ok()?.to_hex(),
                    read_string(&doc, "name"),
                ))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub async fn product_code_name_map(
    db: &mongodb::Database,
    ids: Vec<ObjectId>,
) -> HashMap<String, (String, String)> {
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
            .filter_map(|doc| {
                Some((
                    doc.get_object_id("_id").ok()?.to_hex(),
                    (read_string(&doc, "code"), read_string(&doc, "name")),
                ))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}
