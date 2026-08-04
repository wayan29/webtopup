use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Document};

use super::types::TeamSummary;

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

pub(super) fn team_member_read_pipeline(
    match_stage: Document,
    include_sort: bool,
) -> Vec<Document> {
    let mut pipeline = vec![
        doc! { "$match": match_stage },
        doc! { "$lookup": { "from": "users", "localField": "createdBy", "foreignField": "_id", "as": "createdByData" } },
        doc! { "$unwind": { "path": "$createdByData", "preserveNullAndEmptyArrays": true } },
        doc! { "$project": { "name": 1, "email": 1, "role": 1, "permissions": 1, "active": 1, "twoFactorEnabled": 1, "createdAt": 1, "updatedAt": 1, "createdByData._id": 1, "createdByData.name": 1, "createdByData.email": 1, "createdByData.role": 1 } },
    ];
    if include_sort {
        pipeline.push(doc! { "$sort": { "role": 1, "createdAt": -1 } });
    }
    pipeline
}

pub(super) async fn team_member_lookup(
    db: &mongodb::Database,
    member_id: ObjectId,
) -> Option<Document> {
    aggregate_documents(
        db,
        "users",
        team_member_read_pipeline(doc! { "_id": member_id }, false),
    )
    .await
    .into_iter()
    .next()
}

pub(super) fn update_summary(summary: &mut TeamSummary, document: &Document) {
    summary.total += 1;
    if document.get_bool("active").unwrap_or(true) {
        summary.active += 1;
    } else {
        summary.inactive += 1;
    }
    match document.get_str("role").unwrap_or_default() {
        "owner" => summary.owner += 1,
        "admin" => summary.admin += 1,
        "cs" => summary.cs += 1,
        _ => {}
    }
}
