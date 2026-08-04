use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};

use super::{types::RuntimeSettings, MAINTENANCE_MESSAGE};
use crate::utils::bson::read_string;

pub(super) async fn site_settings(db: &mongodb::Database) -> RuntimeSettings {
    let mut settings = RuntimeSettings {
        maintenance_mode: false,
        maintenance_message: MAINTENANCE_MESSAGE.to_string(),
        registration_enabled: true,
    };
    let docs = match db
        .collection::<Document>("settings")
        .find(doc! { "key": { "$in": ["maintenanceMode", "maintenanceMessage", "registrationEnabled"] } })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for document in docs {
        match read_string(&document, "key").as_str() {
            "maintenanceMode" => {
                settings.maintenance_mode = bool_value(document.get("value"), false);
            }
            "maintenanceMessage" => {
                let value = string_value(document.get("value"));
                if !value.trim().is_empty() {
                    settings.maintenance_message = value.trim().to_string();
                }
            }
            "registrationEnabled" => {
                settings.registration_enabled = bool_value(document.get("value"), true);
            }
            _ => {}
        }
    }
    settings
}

pub(super) fn maintenance_message(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        MAINTENANCE_MESSAGE.to_string()
    } else {
        value.to_string()
    }
}

fn bool_value(value: Option<&Bson>, fallback: bool) -> bool {
    match value {
        Some(Bson::Boolean(value)) => *value,
        _ => fallback,
    }
}

fn string_value(value: Option<&Bson>) -> String {
    match value {
        Some(Bson::String(value)) => value.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}
