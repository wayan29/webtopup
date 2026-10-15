use std::time::{SystemTime, UNIX_EPOCH};

pub fn timestamp_now() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_secs().to_string()
}
