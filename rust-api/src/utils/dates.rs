use std::time::SystemTime;

use mongodb::bson::DateTime;

pub fn timestamp_now() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_secs().to_string()
}

pub fn start_of_today_utc() -> DateTime {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let start_secs = now.as_secs() - (now.as_secs() % 86_400);
    DateTime::from_millis((start_secs * 1000) as i64)
}
