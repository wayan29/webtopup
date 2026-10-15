
pub fn has_whitelist(value: &str) -> bool {
    value
        .split(',')
        .map(str::trim)
        .any(|value| !value.is_empty())
}

pub fn normalize_whitelist(value: &str) -> String {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

pub fn protection_mode(has_signature: bool, has_whitelist: bool) -> &'static str {
    if has_signature {
        "signature"
    } else if has_whitelist {
        "ip_only"
    } else {
        "unprotected"
    }
}

