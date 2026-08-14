use axum::{response::IntoResponse, Json};
use mongodb::bson::{oid::ObjectId, Bson, Document};
use serde_json::Value;

use crate::utils::bson::{read_i64, read_string};

use super::{
    id_from_bson, object_id, price_from_doc, resolve_category_by_id, resolve_category_by_name,
    resolve_category_by_object_id, resolve_operator_by_id, resolve_operator_by_name,
    resolve_operator_by_object_id, resolve_product_type, vendor_from_doc, AdminProductsQuery,
    ProductNormalizedPayload, ProductPrice, ProductVendor,
};

pub(super) async fn build_product_payload(
    db: &mongodb::Database,
    payload: &Value,
    existing: Option<&Document>,
) -> Result<ProductNormalizedPayload, axum::response::Response> {
    let name = field_string(payload, "name")
        .or_else(|| existing.map(|document| read_string(document, "name")))
        .unwrap_or_default();
    if name.is_empty() {
        return Err(product_error("PRODUCT_NAME_REQUIRED"));
    }
    let code = field_string(payload, "code")
        .or_else(|| existing.map(|document| read_string(document, "code")))
        .unwrap_or_default();
    if code.is_empty() {
        return Err(product_error("PRODUCT_CODE_REQUIRED"));
    }

    let category_id_input = field_id(payload, "categoryId").or_else(|| {
        existing.and_then(|document| non_empty_id_from_bson(document.get("categoryId")))
    });
    let operator_id_input = field_id(payload, "operatorId").or_else(|| {
        existing.and_then(|document| non_empty_id_from_bson(document.get("operatorId")))
    });
    let product_type_id_input = field_id(payload, "productTypeId").or_else(|| {
        existing.and_then(|document| non_empty_id_from_bson(document.get("productTypeId")))
    });
    let category_name_input = field_string(payload, "category")
        .or_else(|| existing.map(|document| read_string(document, "category")))
        .unwrap_or_default();
    let brand_input = field_string(payload, "brand")
        .or_else(|| existing.map(|document| read_string(document, "brand")))
        .unwrap_or_default();

    let mut category = if let Some(id) = category_id_input
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let Some(object_id) = object_id(Some(id)) else {
            return Err(product_error("INVALID_CATEGORY_ID"));
        };
        let Some(category) = resolve_category_by_object_id(db, object_id).await else {
            return Err(product_error("CATEGORY_NOT_FOUND"));
        };
        Some(category)
    } else if !category_name_input.is_empty() {
        resolve_category_by_name(db, &category_name_input).await
    } else {
        None
    };
    let mut operator = if let Some(id) = operator_id_input
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let Some(object_id) = object_id(Some(id)) else {
            return Err(product_error("INVALID_OPERATOR_ID"));
        };
        let Some(operator) = resolve_operator_by_object_id(db, object_id).await else {
            return Err(product_error("OPERATOR_NOT_FOUND"));
        };
        Some(operator)
    } else {
        None
    };
    let product_type = if let Some(id) = product_type_id_input
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let Some(object_id) = object_id(Some(id)) else {
            return Err(product_error("INVALID_PRODUCT_TYPE_ID"));
        };
        let query = AdminProductsQuery {
            category: None,
            category_id: None,
            operator_id: None,
            product_type_id: Some(object_id.to_hex()),
            brand: None,
            search: None,
            status: None,
        };
        let Some(product_type) = resolve_product_type(db, &query).await else {
            return Err(product_error("PRODUCT_TYPE_NOT_FOUND"));
        };
        Some(product_type)
    } else {
        None
    };
    if operator.is_none() {
        if let Some(product_type) = &product_type {
            operator = resolve_operator_by_id(db, &product_type.operator_id).await;
            if operator.is_none() {
                return Err(product_error("OPERATOR_NOT_FOUND"));
            }
        }
    }
    if category.is_none() {
        if let Some(operator) = &operator {
            category = resolve_category_by_id(db, &operator.category_id).await;
            if category.is_none() {
                return Err(product_error("CATEGORY_NOT_FOUND"));
            }
        }
    }
    if category.is_none() {
        if let Some(product_type) = &product_type {
            category = resolve_category_by_id(db, &product_type.category_id).await;
            if category.is_none() {
                return Err(product_error("CATEGORY_NOT_FOUND"));
            }
        }
    }
    if operator.is_none() && !brand_input.is_empty() {
        operator = resolve_operator_by_name(db, &brand_input, category.as_ref()).await;
    }
    if category.is_none() {
        if let Some(operator) = &operator {
            category = resolve_category_by_id(db, &operator.category_id).await;
            if category.is_none() {
                return Err(product_error("CATEGORY_NOT_FOUND"));
            }
        }
    }

    let Some(category) = category else {
        return Err(product_error("CATEGORY_REQUIRED"));
    };
    let Some(operator) = operator else {
        return Err(product_error("OPERATOR_REQUIRED"));
    };
    let Some(product_type) = product_type else {
        return Err(product_error("PRODUCT_TYPE_REQUIRED"));
    };
    if operator.category_id != category.id {
        return Err(product_error("OPERATOR_CATEGORY_MISMATCH"));
    }
    if product_type.operator_id != operator.object_id.to_hex() {
        return Err(product_error("PRODUCT_TYPE_OPERATOR_MISMATCH"));
    }
    if product_type.category_id != category.id {
        return Err(product_error("PRODUCT_TYPE_CATEGORY_MISMATCH"));
    }

    let payment_type = field_string_raw(payload, "paymentType")
        .or_else(|| existing.map(|document| read_string(document, "paymentType")))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "prabayar".to_string());
    if payment_type != "prabayar" && payment_type != "pascabayar" {
        return Err(product_error("INVALID_PAYMENT_TYPE"));
    }
    let fallback_price = existing
        .and_then(|document| document.get_document("price").ok())
        .map(price_from_doc)
        .unwrap_or_default();
    let price = if let Some(price) = payload.get("price") {
        normalize_price_value(price, fallback_price)
    } else {
        fallback_price
    };
    let cost_price = field_number(payload, "costPrice")
        .map(normalize_non_negative_number)
        .unwrap_or_else(|| {
            existing
                .map(|document| read_i64(document, "costPrice"))
                .unwrap_or_default()
        });
    let reward_points = field_number(payload, "rewardPoints")
        .map(|value| normalize_non_negative_number(value.round()))
        .unwrap_or_else(|| {
            existing
                .map(|document| read_i64(document, "rewardPoints"))
                .unwrap_or_default()
        });
    let previous_icon = existing.map(|document| read_string(document, "icon"));
    let icon = field_string(payload, "icon")
        .or_else(|| previous_icon.clone())
        .unwrap_or_default();
    let effectively_changed = crate::services::managed_assets::effectively_changed_managed_field(
        previous_icon.as_deref(),
        &icon,
    );
    if let Err(response) = crate::services::managed_assets::ensure_managed_field_for_update(
        &crate::routes::uploads::upload_root(),
        &icon,
        crate::services::managed_assets::ManagedFieldFolderPolicy::Icons,
        effectively_changed,
    ) {
        return Err(response);
    }
    let fallback_vendor = existing
        .and_then(|document| document.get_document("vendor").ok())
        .map(vendor_from_doc)
        .unwrap_or_default();
    let vendor = if let Some(vendor) = payload.get("vendor") {
        ProductVendor {
            name: nested_field_string(vendor, "name").unwrap_or_default(),
            sku: nested_field_string(vendor, "sku").unwrap_or_default(),
        }
    } else {
        fallback_vendor
    };
    let status = field_bool(payload, "status").unwrap_or_else(|| {
        existing
            .and_then(|document| document.get_bool("status").ok())
            .unwrap_or(true)
    });
    let sort_order = if payload.get("sortOrder").is_some() {
        Some(normalize_non_negative_number(
            field_number(payload, "sortOrder").unwrap_or_default(),
        ))
    } else {
        existing.and_then(|document| {
            document
                .get("sortOrder")
                .map(|_| read_i64(document, "sortOrder"))
        })
    };

    Ok(ProductNormalizedPayload {
        name,
        code,
        category: category.name,
        category_id: ObjectId::parse_str(&category.id).unwrap_or_else(|_| ObjectId::new()),
        operator_id: operator.object_id,
        product_type_id: product_type.object_id,
        payment_type,
        brand: operator.name,
        cost_price,
        price,
        reward_points,
        icon,
        vendor,
        status,
        sort_order,
    })
}

fn field_string(payload: &Value, key: &str) -> Option<String> {
    field_string_raw(payload, key).map(|value| value.trim().to_string())
}

fn field_string_raw(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(value_to_string)
}

fn nested_field_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(value_to_string)
        .map(|value| value.trim().to_string())
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn field_id(payload: &Value, key: &str) -> Option<String> {
    let value = payload.get(key)?;
    if let Some(id) = value_to_string(value).map(|value| value.trim().to_string()) {
        return (!id.is_empty()).then_some(id);
    }
    value
        .get("_id")
        .and_then(value_to_string)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn non_empty_id_from_bson(value: Option<&Bson>) -> Option<String> {
    let id = id_from_bson(value);
    (!id.trim().is_empty()).then_some(id)
}

fn field_number(payload: &Value, key: &str) -> Option<f64> {
    payload.get(key).and_then(number_from_value)
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

fn field_bool(payload: &Value, key: &str) -> Option<bool> {
    match payload.get(key)? {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn normalize_price_value(value: &Value, fallback: ProductPrice) -> ProductPrice {
    ProductPrice {
        basic: value
            .get("basic")
            .and_then(number_from_value)
            .map(normalize_non_negative_number)
            .unwrap_or(fallback.basic),
        gold: value
            .get("gold")
            .and_then(number_from_value)
            .map(normalize_non_negative_number)
            .unwrap_or(fallback.gold),
        platinum: value
            .get("platinum")
            .and_then(number_from_value)
            .map(normalize_non_negative_number)
            .unwrap_or(fallback.platinum),
    }
}

fn normalize_non_negative_number(value: f64) -> i64 {
    if !value.is_finite() || value < 0.0 {
        0
    } else {
        value.trunc() as i64
    }
}

fn product_error(code: &str) -> axum::response::Response {
    let message = match code {
        "PRODUCT_NAME_REQUIRED" => "Nama produk wajib diisi",
        "PRODUCT_CODE_REQUIRED" => "Kode produk wajib diisi",
        "INVALID_CATEGORY_ID" => "Kategori produk tidak valid",
        "INVALID_OPERATOR_ID" => "Operator produk tidak valid",
        "INVALID_PRODUCT_TYPE_ID" => "Jenis produk tidak valid",
        "PRODUCT_TYPE_REQUIRED" => "Jenis produk wajib dipilih",
        "CATEGORY_NOT_FOUND" => "Kategori produk tidak ditemukan",
        "CATEGORY_REQUIRED" => "Kategori produk wajib dipilih",
        "OPERATOR_NOT_FOUND" => "Operator produk tidak ditemukan",
        "OPERATOR_REQUIRED" => "Operator produk wajib dipilih",
        "PRODUCT_TYPE_NOT_FOUND" => "Jenis produk tidak ditemukan",
        "OPERATOR_CATEGORY_MISMATCH" => "Operator tidak berada di kategori yang dipilih",
        "PRODUCT_TYPE_OPERATOR_MISMATCH" => "Jenis produk tidak berada di operator yang dipilih",
        "PRODUCT_TYPE_CATEGORY_MISMATCH" => "Jenis produk tidak berada di kategori yang dipilih",
        "INVALID_PAYMENT_TYPE" => "Tipe pembayaran tidak valid",
        _ => "Internal Server Error",
    };
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(crate::security::ErrorResponse { message }),
    )
        .into_response()
}
