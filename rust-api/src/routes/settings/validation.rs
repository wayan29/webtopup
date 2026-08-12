use axum::response::Response;
use serde_json::{json, Map, Value};
use url::Url;

use super::{
    defaults::default_site_settings,
    responses::{status_message, string_message},
    store::load_settings,
};
use crate::services::managed_assets::ensure_managed_fields;

pub async fn validate_update_payload(
    client: &mongodb::Client,
    db_name: &str,
    payload: &Map<String, Value>,
) -> Result<(Map<String, Value>, Map<String, Value>, Map<String, Value>), Response> {
    let defaults = default_site_settings();
    let invalid_keys = payload
        .keys()
        .filter(|key| !defaults.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    if !invalid_keys.is_empty() {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("Key pengaturan tidak dikenali: {}", invalid_keys.join(", ")),
        ));
    }
    let selected_keys = defaults.keys().map(String::as_str).collect::<Vec<_>>();
    let mut next_settings = load_settings(client, db_name, &selected_keys)
        .await
        .map_err(|error| {
            eprintln!("Failed to load settings for validation: {error}");
            status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            )
        })?;
    let previous_settings = next_settings.clone();
    let mut changed_values = Map::new();
    for (key, value) in payload {
        let normalized = validate_setting_json_value(key, value)?;
        next_settings.insert(key.clone(), normalized.clone());
        changed_values.insert(key.clone(), normalized);
    }
    validate_cross_field_settings(&next_settings)?;
    for key in ["favicon", "logo", "popupBannerImage"] {
        if let Some(Value::String(path)) = next_settings.get(key) {
            if let Err(response) = ensure_managed_fields(&crate::routes::uploads::upload_root(), &[path.as_str()]) {
                return Err(response);
            }
        }
    }
    Ok((next_settings, changed_values, previous_settings))
}

fn validate_cross_field_settings(next_settings: &Map<String, Value>) -> Result<(), Response> {
    let min_deposit = next_settings
        .get("minDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let max_deposit = next_settings
        .get("maxDeposit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if next_settings
        .get("brand")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Brand wajib diisi",
        ));
    }
    if next_settings
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Judul website wajib diisi",
        ));
    }
    if max_deposit < min_deposit {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Maximum deposit tidak boleh lebih kecil dari minimum deposit",
        ));
    }
    if next_settings.get("depositFeeType").and_then(Value::as_str) == Some("percent") {
        let deposit_fee = next_settings
            .get("depositFee")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if deposit_fee > 100 {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Biaya deposit persentase tidak boleh lebih dari 100%",
            ));
        }
    }
    if next_settings
        .get("maintenanceMode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && next_settings
            .get("maintenanceMessage")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
    {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Pesan maintenance wajib diisi saat maintenance aktif",
        ));
    }
    if next_settings
        .get("popupBannerEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && next_settings
            .get("popupBannerImage")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
    {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Gambar popup banner wajib diisi saat popup aktif",
        ));
    }
    let invoice_type = next_settings
        .get("invoiceRandomType")
        .and_then(Value::as_str)
        .unwrap_or("alphanumeric");
    let invoice_length = next_settings
        .get("invoiceRandomLength")
        .and_then(Value::as_i64)
        .unwrap_or(8);
    if crate::services::identifier_integrity::validate_invoice_length(invoice_type, invoice_length)
        .is_err()
    {
        let min = crate::services::identifier_integrity::invoice_min_length(invoice_type);
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("Panjang random invoice harus di antara {min} sampai 12"),
        ));
    }
    Ok(())
}

pub(super) fn validate_setting_json_value_for_policy(
    key: &str,
    value: &Value,
) -> Result<Value, Response> {
    validate_setting_json_value(key, value)
}

fn validate_setting_json_value(key: &str, value: &Value) -> Result<Value, Response> {
    match key {
        "brand" => ensure_text(value, "Brand", 80),
        "title" => ensure_text(value, "Judul website", 120),
        "favicon" => ensure_safe_path_or_url(value, "Favicon"),
        "logo" => ensure_safe_path_or_url(value, "Logo"),
        "description" => ensure_text(value, "Deskripsi website", 300),
        "whatsapp" => ensure_optional_whatsapp(value),
        "telegram" => ensure_text(value, "Telegram", 255),
        "email" => ensure_optional_email(value, "Email"),
        "instagram" => ensure_text(value, "Instagram", 255),
        "facebook" => ensure_text(value, "Facebook", 255),
        "twitter" => ensure_text(value, "Twitter / X", 255),
        "youtube" => ensure_text(value, "YouTube", 255),
        "address" => ensure_text(value, "Alamat", 500),
        "maintenanceMode" => ensure_boolean(value, "Mode maintenance"),
        "maintenanceMessage" => ensure_text(value, "Pesan maintenance", 500),
        "registrationEnabled" => ensure_boolean(value, "Status registrasi"),
        "guestCheckoutEnabled" => ensure_boolean(value, "Status guest checkout"),
        "minDeposit" => ensure_integer(value, "Minimum deposit", 0, 100_000_000),
        "maxDeposit" => ensure_integer(value, "Maximum deposit", 0, 100_000_000),
        "depositFee" => ensure_integer(value, "Biaya deposit", 0, 100_000_000),
        "depositFeeType" => ensure_enum(value, "Tipe biaya deposit", &["fixed", "percent"]),
        "footerText" => ensure_text(value, "Teks footer", 200),
        "termsUrl" => ensure_safe_path_or_url(value, "URL syarat & ketentuan"),
        "privacyUrl" => ensure_safe_path_or_url(value, "URL kebijakan privasi"),
        "googleAnalyticsId" => ensure_text(value, "Google Analytics ID", 60)
            .map(|value| Value::String(value.as_str().unwrap_or("").to_uppercase())),
        "facebookPixelId" => ensure_text(value, "Facebook Pixel ID", 60),
        "popupBannerEnabled" => ensure_boolean(value, "Status popup banner"),
        "popupBannerImage" => ensure_safe_path_or_url(value, "Gambar popup banner"),
        "popupBannerLink" => ensure_safe_path_or_url(value, "Link popup banner"),
        "popupBannerTitle" => ensure_text(value, "Judul popup banner", 120),
        "popupBannerDescription" => ensure_text(value, "Deskripsi popup banner", 300),
        "refIdPrefix" => ensure_prefix(value, "Prefix Ref ID"),
        "refIdDateFormat" => ensure_enum(
            value,
            "Format tanggal Ref ID",
            crate::services::identifier_integrity::REF_ID_DATE_FORMATS,
        ),
        "refIdSeparator" => ensure_enum(value, "Separator Ref ID", &["", "-", "_"]),
        "refIdSequenceDigits" => ensure_integer(value, "Digit sequence Ref ID", 1, 10),
        "invoicePrefix" => ensure_prefix(value, "Prefix invoice"),
        "invoiceDateFormat" => ensure_enum(
            value,
            "Format tanggal invoice",
            crate::services::identifier_integrity::INVOICE_DATE_FORMATS,
        ),
        "invoiceSeparator" => ensure_enum(value, "Separator invoice", &["", "-", "_"]),
        // Final type-specific min is enforced in cross-field validation.
        "invoiceRandomLength" => ensure_integer(value, "Panjang random invoice", 1, 12),
        "invoiceRandomType" => {
            ensure_enum(value, "Tipe random invoice", &["alphanumeric", "numeric"])
        }
        _ => Ok(value.clone()),
    }
}

fn ensure_text(value: &Value, field_label: &str, max_length: usize) -> Result<Value, Response> {
    let Some(text) = value.as_str() else {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} harus berupa teks"),
        ));
    };
    let normalized = text.trim().to_string();
    if normalized.chars().count() > max_length {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} maksimal {max_length} karakter"),
        ));
    }
    Ok(Value::String(normalized))
}

fn ensure_boolean(value: &Value, field_label: &str) -> Result<Value, Response> {
    match value.as_bool() {
        Some(value) => Ok(Value::Bool(value)),
        None => Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} tidak valid"),
        )),
    }
}

fn ensure_integer(value: &Value, field_label: &str, min: i64, max: i64) -> Result<Value, Response> {
    let number = if let Some(number) = value.as_i64() {
        number
    } else if let Some(number) = value.as_f64() {
        if number.fract() != 0.0 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("{field_label} harus berupa bilangan bulat"),
            ));
        }
        number as i64
    } else if let Some(text) = value.as_str() {
        match text.trim().parse::<f64>() {
            Ok(number) if number.is_finite() && number.fract() == 0.0 => number as i64,
            Ok(number) if number.is_finite() => {
                return Err(string_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("{field_label} harus berupa bilangan bulat"),
                ))
            }
            _ => {
                return Err(string_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("{field_label} harus berupa angka"),
                ))
            }
        }
    } else {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} harus berupa angka"),
        ));
    };
    if number < min || number > max {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} harus di antara {min} sampai {max}"),
        ));
    }
    Ok(json!(number))
}

fn ensure_enum(value: &Value, field_label: &str, allowed: &[&str]) -> Result<Value, Response> {
    let normalized = value.as_str().unwrap_or("").trim().to_string();
    if !allowed.contains(&normalized.as_str()) {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} tidak valid"),
        ));
    }
    Ok(Value::String(normalized))
}

fn ensure_safe_path_or_url(value: &Value, field_label: &str) -> Result<Value, Response> {
    let normalized = value.as_str().unwrap_or("").trim().to_string();
    if normalized.is_empty() {
        return Ok(Value::String(String::new()));
    }
    if normalized.starts_with('/') {
        if normalized.starts_with("//") {
            return Err(safe_path_error(field_label));
        }
        return Ok(Value::String(normalized));
    }
    match Url::parse(&normalized) {
        Ok(parsed)
            if parsed.scheme() == "https"
                && parsed.host_str().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none() =>
        {
            Ok(Value::String(normalized))
        }
        _ => Err(safe_path_error(field_label)),
    }
}

fn safe_path_error(field_label: &str) -> Response {
    string_message(
        axum::http::StatusCode::BAD_REQUEST,
        format!("{field_label} URL harus berupa https atau path internal yang diawali \"/\""),
    )
}

fn ensure_optional_email(value: &Value, field_label: &str) -> Result<Value, Response> {
    let normalized = ensure_text(value, field_label, 120)?;
    let text = normalized.as_str().unwrap_or("");
    if text.is_empty() {
        return Ok(normalized);
    }
    let parts = text.split('@').collect::<Vec<_>>();
    if parts.len() == 2
        && !parts[0].is_empty()
        && parts[1].contains('.')
        && !parts[1].starts_with('.')
        && !parts[1].ends_with('.')
        && text.chars().all(|character| {
            character.is_ascii() && !character.is_control() && !character.is_whitespace()
        })
    {
        return Ok(normalized);
    }
    Err(string_message(
        axum::http::StatusCode::BAD_REQUEST,
        format!("{field_label} tidak valid"),
    ))
}

fn ensure_optional_whatsapp(value: &Value) -> Result<Value, Response> {
    let normalized = ensure_text(value, "WhatsApp", 20)?;
    let text = normalized.as_str().unwrap_or("");
    if text.is_empty()
        || (text.len() >= 8
            && text.len() <= 20
            && text.chars().all(|character| character.is_ascii_digit()))
    {
        return Ok(normalized);
    }
    Err(status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "WhatsApp harus berupa angka 8-20 digit tanpa spasi",
    ))
}

fn ensure_prefix(value: &Value, field_label: &str) -> Result<Value, Response> {
    let normalized = ensure_text(value, field_label, 12)?;
    let text = normalized.as_str().unwrap_or("").to_uppercase();
    if text.is_empty() {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} wajib diisi"),
        ));
    }
    if !text
        .chars()
        .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    {
        return Err(string_message(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{field_label} hanya boleh berisi huruf dan angka"),
        ));
    }
    Ok(Value::String(text))
}
