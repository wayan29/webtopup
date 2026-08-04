use axum::response::Response;
use mongodb::bson::oid::ObjectId;
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value;

use super::{
    responses::{status_message, string_message},
    types::{PaymentMethodPayload, ValidPaymentMethodPayload},
    utils::{is_valid_time_string, read_f64_default, read_string_default},
};

pub(super) async fn validate_payment_method_payload(
    db: &mongodb::Database,
    payload: PaymentMethodPayload,
    current: &Document,
) -> Result<ValidPaymentMethodPayload, Response> {
    validate_payment_method_payload_inner(db, payload, Some(current)).await
}

pub(super) async fn validate_payment_method_create_payload(
    db: &mongodb::Database,
    payload: PaymentMethodPayload,
) -> Result<ValidPaymentMethodPayload, Response> {
    validate_payment_method_payload_inner(db, payload, None).await
}

async fn validate_payment_method_payload_inner(
    db: &mongodb::Database,
    payload: PaymentMethodPayload,
    current: Option<&Document>,
) -> Result<ValidPaymentMethodPayload, Response> {
    let empty = Document::new();
    let current = current.unwrap_or(&empty);
    let name = text_value_or_current(payload.name, current, "name", "");
    let category = match payload.category {
        Some(value) => text_value_or_current(Some(value), current, "category", ""),
        None => read_string_default(current, "category", ""),
    };
    let account_number =
        text_value_or_current(payload.account_number, current, "accountNumber", "");
    let account_name = text_value_or_current(payload.account_name, current, "accountName", "");
    let icon = text_value_or_current(payload.icon, current, "icon", "");
    let operational_start = text_value_or_current(
        payload.operational_start,
        current,
        "operationalStart",
        "00:00",
    );
    let operational_end =
        text_value_or_current(payload.operational_end, current, "operationalEnd", "23:59");
    let status = text_value_or_current(payload.status, current, "status", "active");
    let use_unique_code = match payload.use_unique_code {
        Some(Value::Bool(value)) => value,
        Some(_) => {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Format kode unik tidak valid",
            ))
        }
        None => current.get_bool("useUniqueCode").unwrap_or(true),
    };

    if name.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama metode pembayaran wajib diisi",
        ));
    }
    let category_id = match ObjectId::parse_str(&category) {
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

    let min_amount = number_value_or_current(payload.min_amount, current, "minAmount", 10_000.0)
        .map_err(|message| string_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    let max_amount = number_value_or_current(payload.max_amount, current, "maxAmount", 5_000_000.0)
        .map_err(|message| string_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    let admin_fee = number_value_or_current(payload.admin_fee, current, "adminFee", 0.0)
        .map_err(|message| string_message(axum::http::StatusCode::BAD_REQUEST, message))?;
    let admin_percent =
        number_value_or_current(payload.admin_percent, current, "adminPercent", 0.0)
            .map_err(|message| string_message(axum::http::StatusCode::BAD_REQUEST, message))?;

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
    let category_exists = db
        .collection::<Document>("paymentcategories")
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten()
        .is_some();
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
    current: &Document,
    key: &str,
    default: &str,
) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string().trim().to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) => String::new(),
        None => match current.get(key) {
            Some(Bson::ObjectId(value)) => value.to_hex(),
            _ => read_string_default(current, key, default),
        },
    }
}

fn number_value_or_current(
    value: Option<Value>,
    current: &Document,
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
        None => Ok(read_f64_default(current, key, default)),
    }
}

fn number_error_message(key: &str) -> &'static str {
    match key {
        "minAmount" => "Minimum amount tidak valid",
        "maxAmount" => "Maximum amount tidak valid",
        "adminFee" => "Biaya admin tetap tidak valid",
        "adminPercent" => "Biaya admin persen tidak valid",
        _ => "Nilai tidak valid",
    }
}
