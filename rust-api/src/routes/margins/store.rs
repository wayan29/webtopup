use mongodb::bson::{doc, Document};

pub async fn load_margin_setting(settings: &mongodb::Collection<Document>) -> Option<Document> {
    settings
        .find_one(doc! { "key": "margins" })
        .projection(doc! { "value": 1, "updatedAt": 1 })
        .await
        .ok()
        .flatten()
}

pub async fn save_margin_patch(
    settings: &mongodb::Collection<Document>,
    mut value_updates: Document,
    now: mongodb::bson::DateTime,
) -> mongodb::error::Result<mongodb::results::UpdateResult> {
    value_updates.insert("key", "margins");
    value_updates.insert("description", "Global membership product margins");
    value_updates.insert("updatedAt", now);

    settings
        .update_one(
            doc! { "key": "margins" },
            doc! {
                "$set": value_updates,
                "$setOnInsert": {
                    "createdAt": now,
                    "__v": 0,
                    "value.basic": 10.0,
                    "value.gold": 5.0,
                    "value.platinum": 0.0,
                    "value.note": "",
                },
            },
        )
        .upsert(true)
        .await
}
