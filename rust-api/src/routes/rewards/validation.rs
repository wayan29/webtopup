use serde_json::Value;

pub(super) fn number_value(value: Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}
