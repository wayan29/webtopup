use axum::response::Response;
use serde_json::Value;
use sqlx::{postgres::PgRow, PgPool, Row};

use super::{
    responses::{status_message, string_message},
    types::{PaymentMethodPayload, ValidPaymentMethodPayload},
    utils::is_valid_time_string,
};

pub(super) async fn validate_payment_method_payload(
    pool: &PgPool,
    payload: PaymentMethodPayload,
    current: &PgRow,
) -> Result<ValidPaymentMethodPayload, Response> {
    validate_payment_method_payload_inner(pool, payload, Some(current)).await
}

pub(super) async fn validate_payment_method_create_payload(
    pool: &PgPool,
    payload: PaymentMethodPayload,
) -> Result<ValidPaymentMethodPayload, Response> {
    validate_payment_method_payload_inner(pool, payload, None).await
}

async fn validate_payment_method_payload_inner(
    pool: &PgPool,
    payload: PaymentMethodPayload,
    current: Option<&PgRow>,
) -> Result<ValidPaymentMethodPayload, Response> {
    let name = text_value_or_current(payload.name, current, "name", "");
    let category = match payload.category {
        Some(value) => text_value_or_current(Some(value), current, "category_id", ""),
        None => text_value_or_current(None, current, "category_id", ""),
    };
    let account_number =
        text_value_or_current(payload.account_number, current, "account_number", "");
    let account_name = text_value_or_current(payload.account_name, current, "account_name", "");
    let icon = text_value_or_current(payload.icon, current, "icon", "");
    let previous_icon = text_value_or_current(None, current, "icon", "");
    if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
        &crate::routes::uploads::upload_root(),
        &icon,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
        crate::services::managed_assets::effectively_changed_managed_field(
            current.map(|_| previous_icon.as_str()),
            &icon,
        ),
    ) {
        return Err(response);
    }
    let operational_start = text_value_or_current(
        payload.operational_start,
        current,
        "operational_start",
        "00:00",
    );
    let operational_end =
        text_value_or_current(payload.operational_end, current, "operational_end", "23:59");
    let status = text_value_or_current(payload.status, current, "status", "active");
    let use_unique_code = match payload.use_unique_code {
        Some(Value::Bool(value)) => value,
        Some(_) => {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Format kode unik tidak valid",
            ))
        }
        None => current
            .and_then(|row| row.try_get::<bool, _>("use_unique_code").ok())
            .unwrap_or(true),
    };
    if name.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama metode pembayaran wajib diisi",
        ));
    }
    let category_id = match uuid::Uuid::parse_str(&category) {
        Ok(id) => id,
        Err(_) => {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Kategori metode pembayaran wajib dipilih",
            ))
        }
    };
    if account_number.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nomor rekening wajib diisi",
        ));
    }
    if account_name.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Atas nama rekening wajib diisi",
        ));
    }
    if status != "active" && status != "inactive" {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Status metode pembayaran tidak valid",
        ));
    }
    if !is_valid_time_string(&operational_start) || !is_valid_time_string(&operational_end) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Jam operasional harus berformat HH:mm",
        ));
    }
    let min_amount = number_value_or_current(payload.min_amount, current, "min_amount", 10_000.0)
        .map_err(|m| string_message(axum::http::StatusCode::BAD_REQUEST, m))?;
    let max_amount =
        number_value_or_current(payload.max_amount, current, "max_amount", 5_000_000.0)
            .map_err(|m| string_message(axum::http::StatusCode::BAD_REQUEST, m))?;
    let admin_fee = number_value_or_current(payload.admin_fee, current, "admin_fee", 0.0)
        .map_err(|m| string_message(axum::http::StatusCode::BAD_REQUEST, m))?;
    let admin_percent =
        number_value_or_current(payload.admin_percent, current, "admin_percent", 0.0)
            .map_err(|m| string_message(axum::http::StatusCode::BAD_REQUEST, m))?;
    if min_amount < 0.0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Minimum amount tidak boleh negatif",
        ));
    }
    if max_amount <= 0.0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Maximum amount harus lebih besar dari 0",
        ));
    }
    if max_amount < min_amount {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Maximum amount tidak boleh lebih kecil dari minimum amount",
        ));
    }
    if admin_fee < 0.0 {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Biaya admin tetap tidak boleh negatif",
        ));
    }
    if !(0.0..=100.0).contains(&admin_percent) {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Biaya admin persen harus di antara 0 sampai 100",
        ));
    }
    let category_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM payment_categories WHERE id = $1)",
    )
    .bind(category_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    if !category_exists {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Kategori pembayaran tidak ditemukan",
        ));
    }
    Ok(ValidPaymentMethodPayload {
        name,
        category: category_id,
        account_number,
        account_name,
        icon,
        min_amount,
        max_amount,
        admin_fee,
        admin_percent,
        operational_start,
        operational_end,
        use_unique_code,
        status,
    })
}

fn text_value_or_current(
    value: Option<Value>,
    current: Option<&PgRow>,
    key: &str,
    default: &str,
) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string().trim().to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) => String::new(),
        None => {
            if key == "category_id" {
                current
                    .and_then(|row| row.try_get::<uuid::Uuid, _>(key).ok())
                    .map(|id| id.to_string())
                    .unwrap_or_default()
            } else {
                current
                    .and_then(|row| row.try_get::<String, _>(key).ok())
                    .unwrap_or_else(|| default.to_string())
            }
        }
    }
}

fn number_value_or_current(
    value: Option<Value>,
    current: Option<&PgRow>,
    key: &str,
    default: f64,
) -> Result<f64, String> {
    match value {
        Some(Value::Number(value)) => value
            .as_f64()
            .ok_or_else(|| number_error_message(key).to_string()),
        Some(Value::String(value)) => value
            .trim()
            .parse::<f64>()
            .map_err(|_| number_error_message(key).to_string()),
        Some(_) => Err(number_error_message(key).to_string()),
        None => Ok(current
            .and_then(|row| row.try_get::<f64, _>(key).ok())
            .unwrap_or(default)),
    }
}

fn number_error_message(key: &str) -> &'static str {
    match key {
        "min_amount" => "Minimum amount tidak valid",
        "max_amount" => "Maximum amount tidak valid",
        "admin_fee" => "Biaya admin tetap tidak valid",
        "admin_percent" => "Biaya admin persen tidak valid",
        _ => "Nilai tidak valid",
    }
}
