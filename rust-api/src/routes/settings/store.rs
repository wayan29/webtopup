use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::{UpdateModifications, UpdateOneModel, WriteModel},
    Namespace,
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
    let defaults = default_site_settings();
    let mut settings = selected_keys
        .iter()
        .filter_map(|key| {
            defaults
                .get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect::<Map<_, _>>();
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
    for document in docs {
        if let Ok(key) = document.get_str("key") {
            if settings.contains_key(key) {
                if let Some(value) = document.get("value") {
                    settings.insert(key.to_string(), normalize_setting_value(key, value));
                }
            }
        }
    }
    normalize_cross_field_settings(&mut settings);
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
