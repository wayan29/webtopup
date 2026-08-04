use super::types::{NormalizedDigit, NormalizedPhone};

pub fn normalize_digit_input(
    value: Option<String>,
    label: &str,
    min_length: usize,
    max_length: usize,
) -> NormalizedDigit {
    let normalized = value
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    if normalized.is_empty() {
        return NormalizedDigit {
            value: None,
            message: Some(format!("{label} harus diisi")),
        };
    }
    if normalized.len() < min_length || normalized.len() > max_length {
        return NormalizedDigit {
            value: None,
            message: Some(format!("{label} harus {min_length}-{max_length} digit")),
        };
    }
    NormalizedDigit {
        value: Some(normalized),
        message: None,
    }
}

pub fn normalize_phone_input(value: Option<String>) -> NormalizedPhone {
    let original = value.unwrap_or_default().trim().to_string();
    if original.is_empty() {
        return NormalizedPhone {
            value: None,
            original: None,
            message: Some("Nomor HP harus diisi".to_string()),
        };
    }
    let digits = original
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>();
    let normalized = if let Some(stripped) = digits.strip_prefix("62") {
        format!("0{stripped}")
    } else if digits.starts_with('8') {
        format!("0{digits}")
    } else {
        digits
    };
    if !normalized.starts_with('0')
        || !normalized
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return NormalizedPhone {
            value: None,
            original: None,
            message: Some("Nomor HP harus diawali 08, +62, atau 62".to_string()),
        };
    }
    if normalized.len() < 10 || normalized.len() > 15 {
        return NormalizedPhone {
            value: None,
            original: None,
            message: Some("Nomor HP harus 10-15 digit".to_string()),
        };
    }
    NormalizedPhone {
        value: Some(normalized),
        original: Some(original),
        message: None,
    }
}
