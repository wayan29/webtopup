use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::utils::bson::read_i64;

pub(super) fn public_product_type_pipeline(filter: Document) -> Vec<Document> {
    let mut pipeline = Vec::new();
    if !filter.is_empty() {
        pipeline.push(doc! { "$match": filter });
    }
    pipeline.extend([
        lookup_stage("categories", "categoryId", "categoryData"),
        doc! { "$unwind": "$categoryData" },
        lookup_stage("operators", "operatorId", "operatorData"),
        doc! { "$unwind": "$operatorData" },
        doc! { "$match": { "status": true, "$or": [
            { "categoryData.status": true },
            { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": true }] },
            { "$and": [{ "categoryData.status": { "$exists": false } }, { "categoryData.isActive": { "$exists": false } }] }
        ], "operatorData.status": true } },
        doc! { "$sort": { "sortOrder": 1, "name": 1 } },
    ]);
    pipeline
}

pub(super) async fn find_sorted(
    db: &mongodb::Database,
    collection: &str,
    sort: Document,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .find(Document::new())
        .sort(sort)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) async fn aggregate_documents(
    db: &mongodb::Database,
    collection: &str,
    pipeline: Vec<Document>,
) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) fn slugify(value: &str) -> Option<String> {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

pub(super) async fn max_sort_order(collection: &mongodb::Collection<Document>) -> i64 {
    collection
        .find_one(doc! {})
        .sort(doc! { "sortOrder": -1 })
        .projection(doc! { "sortOrder": 1 })
        .await
        .ok()
        .flatten()
        .map(|document| read_i64(&document, "sortOrder"))
        .unwrap_or(0)
}

pub(super) fn id_or_slug_filter(id: &str) -> Option<Document> {
    if let Ok(object_id) = ObjectId::parse_str(id) {
        Some(doc! { "$or": [{ "_id": object_id }, { "slug": id }] })
    } else if id.trim().is_empty() {
        None
    } else {
        Some(doc! { "slug": id })
    }
}

pub(super) fn lookup_stage(from: &str, local_field: &str, as_field: &str) -> Document {
    doc! { "$lookup": { "from": from, "localField": local_field, "foreignField": "_id", "as": as_field } }
}

pub(super) fn unwind_stage(path: &str) -> Document {
    doc! { "$unwind": { "path": path, "preserveNullAndEmptyArrays": true } }
}
