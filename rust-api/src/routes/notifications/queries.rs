use mongodb::bson::{doc, Bson, DateTime, Document};

use super::types::HIGH_CALLBACK_ATTEMPT_THRESHOLD;

pub async fn count(db: &mongodb::Database, collection: &str, filter: Document) -> i64 {
    db.collection::<Document>(collection)
        .count_documents(filter)
        .await
        .unwrap_or(0) as i64
}

pub fn callback_due_retry_filter(now: DateTime) -> Document {
    doc! {
        "status": { "$ne": "pending" },
        "callbackRequired": true,
        "$or": [
            { "callbackNextRetryAt": { "$exists": false } },
            { "callbackNextRetryAt": Bson::Null },
            { "callbackNextRetryAt": { "$lte": now } }
        ]
    }
}

pub async fn callback_high_attempt_count(db: &mongodb::Database) -> i64 {
    count(
        db,
        "digiflazzsellerorders",
        doc! {
            "callbackRequired": true,
            "callbackAttemptCount": { "$gte": HIGH_CALLBACK_ATTEMPT_THRESHOLD }
        },
    )
    .await
}
