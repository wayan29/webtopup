use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use serde_json::{json, Map, Value};

pub(super) async fn deposit_settings(db: &mongodb::Database) -> Map<String, Value> {
    let mut settings = Map::from_iter([
        ("maintenanceMode".to_string(), json!(false)),
        (
            "maintenanceMessage".to_string(),
            json!("Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi."),
        ),
        ("minDeposit".to_string(), json!(10_000)),
        ("maxDeposit".to_string(), json!(10_000_000)),
        ("depositFee".to_string(), json!(0)),
        ("depositFeeType".to_string(), json!("fixed")),
    ]);
    let keys = settings
        .keys()
        .map(|key| Bson::String(key.clone()))
        .collect::<Vec<_>>();
    let docs = match db
        .collection::<Document>("settings")
        .find(doc! { "key": { "$in": keys } })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for doc in docs {
        if let Ok(key) = doc.get_str("key") {
            if settings.contains_key(key) {
                settings.insert(key.to_string(), bson_to_json(doc.get("value")));
            }
        }
    }
    settings
}

fn bson_to_json(value: Option<&Bson>) -> Value {
    match value {
        Some(Bson::Boolean(value)) => json!(*value),
        Some(Bson::Int32(value)) => json!(*value),
        Some(Bson::Int64(value)) => json!(*value),
        Some(Bson::Double(value)) => json!(*value),
        Some(Bson::String(value)) => json!(value),
        _ => Value::Null,
    }
}

pub(super) fn setting_bool(settings: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    settings
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

pub(super) fn setting_i64(settings: &Map<String, Value>, key: &str, fallback: i64) -> i64 {
    settings
        .get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
                .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
        })
        .unwrap_or(fallback)
}

pub(super) fn setting_string(settings: &Map<String, Value>, key: &str, fallback: &str) -> String {
    settings
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn maintenance_message(settings: &Map<String, Value>) -> String {
    let message = setting_string(
        settings,
        "maintenanceMessage",
        "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.",
    );
    if message.trim().is_empty() {
        "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.".to_string()
    } else {
        message
    }
}
