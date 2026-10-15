use std::time::{SystemTime, UNIX_EPOCH};



pub(super) fn is_valid_time_string(value: &str) -> bool {
    let Some((hours, minutes)) = value.split_once(':') else {
        return false;
    };
    hours.len() == 2
        && minutes.len() == 2
        && hours.chars().all(|character| character.is_ascii_digit())
        && minutes.chars().all(|character| character.is_ascii_digit())
        && time_to_minutes(value).is_some()
}

pub(super) fn visibility_issues(
    method_status: &str,
    category_status: Option<&str>,
    is_operational: bool,
    operational_start: &str,
    operational_end: &str,
) -> Vec<String> {
    let mut issues = Vec::new();
    match category_status {
        None => issues.push("Kategori metode tidak ditemukan".to_string()),
        Some(status) if status != "active" => issues.push("Kategori sedang nonaktif".to_string()),
        Some(_) => {}
    }
    if method_status != "active" {
        issues.push("Metode pembayaran sedang nonaktif".to_string());
    }
    if !is_operational {
        issues.push(format!("Di luar jam operasional {operational_start}-{operational_end}"));
    }
    issues
}

pub(super) fn is_operational_now(start: &str, end: &str) -> bool {
    let Some(start_minutes) = time_to_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = time_to_minutes(end) else {
        return false;
    };
    if start_minutes == end_minutes {
        return true;
    }
    let current_minutes = current_utc_minutes();
    if start_minutes < end_minutes {
        return current_minutes >= start_minutes && current_minutes <= end_minutes;
    }
    current_minutes >= start_minutes || current_minutes <= end_minutes
}

fn time_to_minutes(value: &str) -> Option<u64> {
    let (hours, minutes) = value.split_once(':')?;
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(hours * 60 + minutes)
}

fn current_utc_minutes() -> u64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    (seconds % 86_400) / 60
}


pub(super) fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}
