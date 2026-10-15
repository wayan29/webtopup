use serde_json::Value;

pub(super) fn normalize_non_negative_number(value: Option<&Value>, fallback: i64) -> i64 {
    let Some(value) = value else { return fallback; };
    let numeric_value = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    };
    numeric_value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or(fallback)
}
