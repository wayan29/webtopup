use std::collections::{BTreeSet, HashMap};

use axum::response::Response;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::Value;

use crate::utils::bson::{read_i64, read_string};

use super::{
    i64_value, internal_error, number_from_bson, object_id_from_bson, status_message,
    string_message, text_value, text_value_or_current, FlashSalePayload, FlashSaleProductPayload,
    NormalizedFlashSalePayload, NormalizedFlashSaleProduct, ProductValidationSnapshot,
};

pub(super) async fn sanitize_flash_sale_payload(
    db: &mongodb::Database,
    payload: FlashSalePayload,
    current: Option<&Document>,
) -> Result<NormalizedFlashSalePayload, Response> {
    let name = text_value_or_current(payload.name, current, "name", "");
    if name.is_empty() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Nama flash sale wajib diisi",
        ));
    }
    let start_date =
        parse_flash_sale_date(payload.start_date, current, "startDate", "Tanggal mulai")?;
    let end_date = parse_flash_sale_date(payload.end_date, current, "endDate", "Tanggal selesai")?;
    if end_date.timestamp_millis() <= start_date.timestamp_millis() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Tanggal selesai harus setelah tanggal mulai",
        ));
    }
    let is_active = match payload.is_active {
        Some(Value::Bool(value)) => value,
        Some(_) => false,
        None => current
            .and_then(|document| document.get_bool("isActive").ok())
            .unwrap_or(true),
    };
    let products = match payload.products {
        Some(value) => flash_sale_products_from_value(value)?,
        None => current.map(current_flash_sale_products).unwrap_or_default(),
    };
    let exclude_id = current.and_then(|document| document.get_object_id("_id").ok());
    let normalized =
        validate_flash_sale_products(db, products, start_date, end_date, is_active, exclude_id)
            .await?;

    Ok(NormalizedFlashSalePayload {
        name,
        description: text_value_or_current(payload.description, current, "description", ""),
        start_date,
        end_date,
        products: normalized,
        is_active,
        banner: text_value_or_current(payload.banner, current, "banner", ""),
    })
}

fn parse_flash_sale_date(
    value: Option<Value>,
    current: Option<&Document>,
    key: &str,
    label: &'static str,
) -> Result<DateTime, Response> {
    if let Some(value) = value {
        let Some(text) = text_value(Some(value)) else {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                if label == "Tanggal mulai" {
                    "Tanggal mulai tidak valid"
                } else {
                    "Tanggal selesai tidak valid"
                },
            ));
        };
        return parse_date_text(&text).ok_or_else(|| {
            status_message(
                axum::http::StatusCode::BAD_REQUEST,
                if label == "Tanggal mulai" {
                    "Tanggal mulai tidak valid"
                } else {
                    "Tanggal selesai tidak valid"
                },
            )
        });
    }
    if let Some(current) = current {
        if let Ok(value) = current.get_datetime(key) {
            return Ok(*value);
        }
    }
    Err(status_message(
        axum::http::StatusCode::BAD_REQUEST,
        if label == "Tanggal mulai" {
            "Tanggal mulai wajib diisi"
        } else {
            "Tanggal selesai wajib diisi"
        },
    ))
}

fn parse_date_text(value: &str) -> Option<DateTime> {
    if value.trim().is_empty() {
        return None;
    }
    DateTime::parse_rfc3339_str(value)
        .ok()
        .or_else(|| DateTime::parse_rfc3339_str(format!("{}:00Z", value)).ok())
        .or_else(|| DateTime::parse_rfc3339_str(format!("{}Z", value)).ok())
}

fn flash_sale_products_from_value(value: Value) -> Result<Vec<FlashSaleProductPayload>, Response> {
    let Value::Array(values) = value else {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Format produk flash sale tidak valid",
        ));
    };
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|_| {
                status_message(
                    axum::http::StatusCode::BAD_REQUEST,
                    "Format produk flash sale tidak valid",
                )
            })
        })
        .collect()
}

pub(super) fn current_flash_sale_products(current: &Document) -> Vec<FlashSaleProductPayload> {
    current
        .get_array("products")
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let document = item.as_document()?;
            Some(FlashSaleProductPayload {
                product_id: object_id_from_bson(document.get("productId"))
                    .map(|id| Value::String(id.to_hex())),
                discount_type: Some(Value::String(read_string(document, "discountType"))),
                discount_value: number_from_bson(document.get("discountValue"))
                    .map(|value| Value::Number(value.into())),
                stock: number_from_bson(document.get("stock"))
                    .map(|value| Value::Number(value.into())),
                sold_count: number_from_bson(document.get("soldCount"))
                    .map(|value| Value::Number(value.into())),
            })
        })
        .collect()
}

pub(super) async fn validate_flash_sale_products(
    db: &mongodb::Database,
    products: Vec<FlashSaleProductPayload>,
    start_date: DateTime,
    end_date: DateTime,
    is_active: bool,
    exclude_flash_sale_id: Option<ObjectId>,
) -> Result<Vec<NormalizedFlashSaleProduct>, Response> {
    if products.is_empty() {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    for (index, item) in products.iter().enumerate() {
        let product_id = text_value(item.product_id.clone()).unwrap_or_default();
        let Ok(object_id) = ObjectId::parse_str(product_id.trim()) else {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Produk pada item #{} tidak valid", index + 1),
            ));
        };
        if ids.contains(&object_id) {
            return Err(status_message(
                axum::http::StatusCode::BAD_REQUEST,
                "Satu produk tidak boleh muncul lebih dari sekali dalam flash sale yang sama",
            ));
        }
        ids.push(object_id);
    }
    let product_docs = db
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": ids.clone() } })
        .await
        .map_err(|_| internal_error())?
        .try_collect::<Vec<_>>()
        .await
        .unwrap_or_default();
    if product_docs.len() != ids.len() {
        return Err(status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Ada produk yang tidak ditemukan",
        ));
    }
    let product_map = product_docs
        .into_iter()
        .filter_map(product_validation_snapshot_from_doc)
        .map(|product| (product.id, product))
        .collect::<HashMap<_, _>>();
    let mut normalized = Vec::with_capacity(products.len());
    for (index, item) in products.into_iter().enumerate() {
        let product_id = text_value(item.product_id).unwrap_or_default();
        let object_id = ObjectId::parse_str(product_id.trim()).map_err(|_| {
            string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Produk pada item #{} tidak valid", index + 1),
            )
        })?;
        let Some(product) = product_map.get(&object_id) else {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Produk pada item #{} tidak ditemukan", index + 1),
            ));
        };
        if !product.status {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!(
                    "{} sedang nonaktif dan tidak bisa dipakai di flash sale",
                    product.name
                ),
            ));
        }
        let discount_type = text_value(item.discount_type).unwrap_or_default();
        if discount_type != "percentage" && discount_type != "fixed" {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Jenis diskon untuk {} tidak valid", product.name),
            ));
        }
        let discount_value = i64_value(item.discount_value).unwrap_or(i64::MIN);
        let stock = i64_value(item.stock).unwrap_or(i64::MIN);
        let sold_count = i64_value(item.sold_count).unwrap_or(0);
        if product.base_price <= 0 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Harga dasar {} tidak valid", product.name),
            ));
        }
        if discount_value <= 0 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Diskon {} harus lebih besar dari 0", product.name),
            ));
        }
        if stock < 1 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Stok flash sale {} minimal 1", product.name),
            ));
        }
        if sold_count < 0 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Jumlah terjual {} tidak valid", product.name),
            ));
        }
        if sold_count > stock {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Jumlah terjual {} tidak boleh melebihi stok", product.name),
            ));
        }
        if discount_type == "percentage" && discount_value > 100 {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Diskon persentase {} maksimal 100%", product.name),
            ));
        }
        if discount_type == "fixed" && discount_value > product.base_price {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!(
                    "Potongan tetap {} tidak boleh melebihi harga normal",
                    product.name
                ),
            ));
        }
        let flash_price = calculate_flash_price(product.base_price, &discount_type, discount_value);
        if flash_price >= product.base_price {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!(
                    "{} harus punya harga promo yang lebih rendah dari harga normal",
                    product.name
                ),
            ));
        }
        if product.cost_price > 0 && flash_price < product.cost_price {
            return Err(string_message(
                axum::http::StatusCode::BAD_REQUEST,
                format!("Harga promo {} tidak boleh di bawah modal", product.name),
            ));
        }
        normalized.push(NormalizedFlashSaleProduct {
            product_id: object_id,
            discount_type,
            discount_value,
            stock,
            sold_count,
        });
    }
    if is_active {
        ensure_no_active_flash_sale_overlap(
            db,
            &normalized,
            start_date,
            end_date,
            exclude_flash_sale_id,
        )
        .await?;
    }
    Ok(normalized)
}

async fn ensure_no_active_flash_sale_overlap(
    db: &mongodb::Database,
    products: &[NormalizedFlashSaleProduct],
    start_date: DateTime,
    end_date: DateTime,
    exclude_flash_sale_id: Option<ObjectId>,
) -> Result<(), Response> {
    if products.is_empty() {
        return Ok(());
    }
    let product_ids = products
        .iter()
        .map(|product| product.product_id)
        .collect::<Vec<_>>();
    let mut query = doc! {
        "isActive": true,
        "startDate": { "$lt": end_date },
        "endDate": { "$gt": start_date },
        "products.productId": { "$in": product_ids.clone() },
    };
    if let Some(id) = exclude_flash_sale_id {
        query.insert("_id", doc! { "$ne": id });
    }
    let sales = db
        .collection::<Document>("flashsales")
        .find(query)
        .await
        .map_err(|_| internal_error())?
        .try_collect::<Vec<_>>()
        .await
        .unwrap_or_default();
    if sales.is_empty() {
        return Ok(());
    }
    let product_map = product_validation_map(db, product_ids).await;
    let requested = products
        .iter()
        .map(|product| product.product_id)
        .collect::<Vec<_>>();
    let mut conflicts = BTreeSet::new();
    for sale in sales {
        let sale_name = read_string(&sale, "name");
        for item in sale.get_array("products").cloned().unwrap_or_default() {
            let Some(document) = item.as_document() else {
                continue;
            };
            let Some(product_id) = object_id_from_bson(document.get("productId")) else {
                continue;
            };
            if !requested.contains(&product_id) {
                continue;
            }
            let label = product_map
                .get(&product_id)
                .map(|product| {
                    format_product_label_text(&product.name, &product.code, &product_id.to_hex())
                })
                .unwrap_or_else(|| format_product_label_text("", "", &product_id.to_hex()));
            conflicts.insert(format!("{} di \"{}\"", label, sale_name));
        }
    }
    if conflicts.is_empty() {
        return Ok(());
    }
    Err(string_message(
        axum::http::StatusCode::BAD_REQUEST,
        format!(
            "Beberapa produk sudah dipakai di flash sale aktif lain pada rentang waktu yang overlap: {}",
            conflicts.into_iter().take(4).collect::<Vec<_>>().join(", ")
        ),
    ))
}

async fn product_validation_map(
    db: &mongodb::Database,
    product_ids: Vec<ObjectId>,
) -> HashMap<ObjectId, ProductValidationSnapshot> {
    match db
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": product_ids } })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(product_validation_snapshot_from_doc)
            .map(|product| (product.id, product))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

fn product_validation_snapshot_from_doc(document: Document) -> Option<ProductValidationSnapshot> {
    let id = document.get_object_id("_id").ok()?;
    let base_price = document
        .get_document("price")
        .map(|price| read_i64(price, "basic"))
        .unwrap_or_default();
    Some(ProductValidationSnapshot {
        id,
        name: read_string(&document, "name"),
        code: read_string(&document, "code"),
        base_price,
        cost_price: read_i64(&document, "costPrice"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

pub(super) fn flash_sale_document(
    payload: NormalizedFlashSalePayload,
    created_at: DateTime,
    updated_at: DateTime,
) -> Document {
    doc! {
        "name": payload.name,
        "description": payload.description,
        "startDate": payload.start_date,
        "endDate": payload.end_date,
        "products": normalized_products_bson(payload.products),
        "isActive": payload.is_active,
        "banner": payload.banner,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "__v": 0,
    }
}

pub(super) fn normalized_products_bson(products: Vec<NormalizedFlashSaleProduct>) -> Vec<Bson> {
    products
        .into_iter()
        .map(|product| {
            Bson::Document(doc! {
                "productId": product.product_id,
                "discountType": product.discount_type,
                "discountValue": product.discount_value,
                "stock": product.stock,
                "soldCount": product.sold_count,
            })
        })
        .collect()
}

pub(super) fn calculate_flash_price(
    base_price: i64,
    discount_type: &str,
    discount_value: i64,
) -> i64 {
    if discount_type == "percentage" {
        return (base_price - (base_price * discount_value) / 100).max(0);
    }
    (base_price - discount_value).max(0)
}

fn format_product_label_text(name: &str, code: &str, fallback_id: &str) -> String {
    let name = name.trim();
    let code = code.trim();
    if !name.is_empty() && !code.is_empty() {
        return format!("{} ({})", name, code);
    }
    if !name.is_empty() {
        return name.to_string();
    }
    if !code.is_empty() {
        return code.to_string();
    }
    format!(
        "Produk {}",
        fallback_id
            .chars()
            .rev()
            .take(6)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )
}
