use serde_json::Value;

const DEFAULT_ALLOWED_IP: &str = "52.74.250.133";
pub(super) fn text_from_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string().trim().to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

pub(super) fn non_negative_i64(value: Option<&Value>, fallback: i64) -> i64 {
    value
        .and_then(number_from_value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.round() as i64)
        .unwrap_or(fallback)
}

pub(super) fn bool_from_value(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub(super) fn validate_http_url(
    value: &str,
    error_code: &'static str,
) -> Result<String, &'static str> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return Err(error_code);
    };
    if !matches!(scheme, "http" | "https") || rest.trim().is_empty() {
        return Err(error_code);
    }
    Ok(value.trim_end_matches('/').to_string())
}

pub(super) fn validate_allowed_ips(value: &Value) -> Result<Vec<String>, &'static str> {
    let items = match value {
        Value::Array(values) => values.iter().map(text_from_value).collect::<Vec<_>>(),
        Value::String(value) => value
            .split([',', ';', '\n'])
            .map(str::trim)
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        Value::Null => Vec::new(),
        _ => Vec::new(),
    };
    let ips = items
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if ips.iter().any(|ip| !is_valid_ip_or_cidr(ip)) {
        return Err("DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID");
    }
    Ok(ips)
}

fn is_valid_ip_or_cidr(value: &str) -> bool {
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let Some((ip, prefix)) = value.split_once('/') else {
        return false;
    };
    ip.parse::<std::net::Ipv4Addr>().is_ok()
        && prefix.parse::<u8>().is_ok_and(|prefix| prefix <= 32)
}

pub(super) fn ip_matches_rule(client_ip: &str, rule: &str) -> bool {
    if client_ip == rule {
        return true;
    }
    let Some((range_ip, prefix)) = rule.split_once('/') else {
        return false;
    };
    let Ok(client) = client_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(range) = range_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    if prefix > 32 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(client) & mask) == (u32::from(range) & mask)
}

pub(super) fn is_valid_pulsa_code(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

pub(super) fn join_url(base_url: &str, path: &str) -> String {
    if base_url.is_empty() {
        return String::new();
    }
    format!(
        "{}{}{}",
        base_url,
        if path.starts_with('/') { "" } else { "/" },
        path
    )
}

pub(super) fn normalize_url(value: String) -> String {
    value.trim_end_matches('/').to_string()
}

