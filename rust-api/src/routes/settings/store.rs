use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::{UpdateModifications, UpdateOneModel, WriteModel},
    ClientSession, Database, Namespace,
};
use serde_json::{Map, Value};

use super::{
    conversion::{json_to_bson, normalize_cross_field_settings, normalize_setting_value},
    defaults::default_site_settings,
};

pub async fn load_settings(
    client: &mongodb::Client,
    db_name: &str,
    selected_keys: &[&str],
) -> Result<Map<String, Value>, mongodb::error::Error> {
    let mut settings = settings_from_defaults(selected_keys);
    let keys = selected_keys
        .iter()
        .map(|key| Bson::String((*key).to_string()))
        .collect::<Vec<_>>();
    let docs = match client
        .database(db_name)
        .collection::<Document>("settings")
        .find(doc! { "key": { "$in": keys } })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await?,
        Err(error) => return Err(error),
    };
    apply_setting_documents(&mut settings, docs);
    Ok(settings)
}

fn settings_from_defaults(selected_keys: &[&str]) -> Map<String, Value> {
    let defaults = default_site_settings();
    selected_keys
        .iter()
        .filter_map(|key| {
            defaults
                .get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect::<Map<_, _>>()
}

fn apply_setting_documents(settings: &mut Map<String, Value>, docs: Vec<Document>) {
    for document in docs {
        if let Ok(key) = document.get_str("key") {
            if settings.contains_key(key) {
                if let Some(value) = document.get("value") {
                    settings.insert(key.to_string(), normalize_setting_value(key, value));
                }
            }
        }
    }
    normalize_cross_field_settings(settings);
}

pub async fn load_settings_in_session(
    db: &Database,
    session: &mut ClientSession,
    selected_keys: &[&str],
) -> Result<Map<String, Value>, mongodb::error::Error> {
    let mut settings = settings_from_defaults(selected_keys);
    let keys = selected_keys
        .iter()
        .map(|key| Bson::String((*key).to_string()))
        .collect::<Vec<_>>();
    let mut cursor = db
        .collection::<Document>("settings")
        .find(doc! { "key": { "$in": keys } })
        .session(&mut *session)
        .await?;
    let mut docs = Vec::new();
    while cursor.advance(&mut *session).await? {
        docs.push(cursor.deserialize_current()?);
    }
    apply_setting_documents(&mut settings, docs);
    Ok(settings)
}

pub async fn upsert_settings(
    client: &mongodb::Client,
    db_name: &str,
    changed_values: &Map<String, Value>,
) -> Result<(), ()> {
    if changed_values.is_empty() {
        return Ok(());
    }
    let namespace = Namespace::new(db_name, "settings");
    let models = changed_values
        .iter()
        .map(|(key, value)| {
            WriteModel::UpdateOne(
                UpdateOneModel::builder()
                    .namespace(namespace.clone())
                    .filter(doc! { "key": key })
                    .update(UpdateModifications::Document(doc! {
                        "$set": { "key": key, "value": json_to_bson(value) }
                    }))
                    .upsert(true)
                    .build(),
            )
        })
        .collect::<Vec<_>>();
    client
        .bulk_write(models)
        .ordered(true)
        .await
        .map_err(|error| {
            eprintln!("Failed to bulk upsert site settings: {error}");
        })?;
    Ok(())
}
