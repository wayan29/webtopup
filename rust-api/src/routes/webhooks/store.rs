use mongodb::bson::{doc, Bson, Document};

use super::utils::config_string;

pub async fn setting_string(collection: &mongodb::Collection<Document>, key: &str) -> String {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|doc| value_string(doc.get("value")))
        .unwrap_or_default()
}

pub async fn upsert_setting(
    collection: &mongodb::Collection<Document>,
    key: &str,
    value: String,
) -> mongodb::error::Result<mongodb::results::UpdateResult> {
    collection
        .update_one(
            doc! { "key": key },
            doc! { "$set": { "key": key, "value": value } },
        )
        .upsert(true)
        .await
}

pub async fn tokovoucher_credentials_configured(client: &mongodb::Client, db_name: &str) -> bool {
    let vendor = client
        .database(db_name)
        .collection::<Document>("vendors")
        .find_one(doc! { "name": { "$regex": "tokovoucher", "$options": "i" } })
        .await
        .ok()
        .flatten();
    let config = vendor
        .as_ref()
        .and_then(|doc| doc.get_document("config").ok());
    let member_code = config
        .and_then(|doc| config_string(doc, "memberCode").or_else(|| config_string(doc, "apiKey")))
        .unwrap_or_default();
    let secret = config
        .and_then(|doc| config_string(doc, "secret"))
        .unwrap_or_default();
    !member_code.is_empty() && !secret.is_empty()
}

fn value_string(value: Option<&Bson>) -> Option<String> {
    match value {
        Some(Bson::String(value)) => Some(value.trim().to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}
