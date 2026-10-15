use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};

pub(super) async fn deposit_settings(pool: &PgPool) -> Map<String, Value> {
    let mut settings = Map::from_iter([
        ("maintenanceMode".to_string(), json!(false)),
        ("maintenanceMessage".to_string(), json!("Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.")),
        ("minDeposit".to_string(), json!(10_000)),
        ("maxDeposit".to_string(), json!(10_000_000)),
        ("depositFee".to_string(), json!(0)),
        ("depositFeeType".to_string(), json!("fixed")),
    ]);
    let keys = settings.keys().cloned().collect::<Vec<_>>();
    if let Ok(rows) = sqlx::query("SELECT key,value FROM site_settings WHERE key=ANY($1)")
        .bind(&keys).fetch_all(pool).await {
        for row in rows {
            let key: String = row.get("key");
            if settings.contains_key(&key) {
                if let Ok(value) = row.try_get::<Value, _>("value") { settings.insert(key, value); }
            }
        }
    }
    settings
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
