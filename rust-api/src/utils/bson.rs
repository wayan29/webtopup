use serde_json::Value;

pub fn read_i64(document: &Value, key: &str) -> i64 {
    optional_i64(document, key).unwrap_or_default()
}

pub fn optional_i64(document: &Value, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Value::Number(value)) => value.as_i64().or_else(|| value.as_f64().map(|v| v as i64)),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

pub fn read_string(document: &Value, key: &str) -> String {
    optional_string(document, key).unwrap_or_default()
}

pub fn optional_string(document: &Value, key: &str) -> Option<String> {
    match document.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

pub fn escape_regex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}
