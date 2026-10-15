use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, PgPool, Row};
use uuid::Uuid;

use crate::{
    services::flash_sales::{active_flash_offer, flash_price, mongoose_timestamp, FlashProductKey},
    state::AppState,
};

use super::{internal_error, status_message};

pub async fn flash_sales_active(State(state): State<Arc<AppState>>) -> Response {
    let sales = match sqlx::query(
        "SELECT id, name, description, start_date, end_date, is_active, banner, created_at, updated_at \
           FROM content_flash_sales \
          WHERE is_active AND start_date <= now() AND end_date >= now() \
          ORDER BY start_date, id",
    )
    .fetch_all(&state.pg_pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return internal_error(),
    };
    let sale_ids: Vec<Uuid> = sales.iter().map(|row| row.get("id")).collect();
    let products = match public_flash_products(&state.pg_pool, &sale_ids).await {
        Ok(products) => products,
        Err(_) => return internal_error(),
    };
    let items = sales
        .into_iter()
        .filter_map(|sale| {
            let id: Uuid = sale.get("id");
            let sale_products = products.get(&id)?;
            Some(json!({
                "_id": id.to_string(),
                "name": sale.get::<String, _>("name"),
                "description": sale.get::<String, _>("description"),
                "startDate": mongoose_timestamp(sale.get::<DateTime<Utc>, _>("start_date")),
                "endDate": mongoose_timestamp(sale.get::<DateTime<Utc>, _>("end_date")),
                "isActive": sale.get::<bool, _>("is_active"),
                "banner": sale.get::<String, _>("banner"),
                "createdAt": mongoose_timestamp(sale.get::<DateTime<Utc>, _>("created_at")),
                "updatedAt": mongoose_timestamp(sale.get::<DateTime<Utc>, _>("updated_at")),
                "products": sale_products,
            }))
        })
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn flash_sale_price(
    State(state): State<Arc<AppState>>,
    Path(product_id): Path<String>,
) -> Response {
    let Ok(product_id) = Uuid::parse_str(product_id.trim()) else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };
    let offer = match active_flash_offer(&state.pg_pool, FlashProductKey::Id(product_id)).await {
        Ok(offer) => offer,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    };
    let Some(offer) = offer else {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    };
    Json(json!({
        "hasFlashSale": true,
        "flashSaleId": offer.flash_sale_id.to_string(),
        "flashSaleName": offer.flash_sale_name,
        "originalPrice": offer.base_price,
        "flashPrice": flash_price(offer.base_price, &offer.discount_type, offer.discount_value),
        "discountType": offer.discount_type,
        "discountValue": offer.discount_value,
        "stock": offer.stock,
        "soldCount": offer.sold_count,
        "remainingStock": offer.stock - offer.sold_count,
        "endDate": mongoose_timestamp(offer.end_date),
    }))
    .into_response()
}

/// Visible flash products per sale. INNER JOINs replicate the legacy public
/// populate filter: the product and its category/operator/product type must all
/// exist with `status = true`; otherwise the entry is hidden.
async fn public_flash_products(
    pool: &PgPool,
    sale_ids: &[Uuid],
) -> sqlx::Result<HashMap<Uuid, Vec<Value>>> {
    let mut products: HashMap<Uuid, Vec<Value>> = HashMap::new();
    if sale_ids.is_empty() {
        return Ok(products);
    }
    let rows = sqlx::query(
        "SELECT fp.flash_sale_id, fp.product_id, fp.discount_type, fp.discount_value, \
                fp.stock, fp.sold_count, \
                p.name, p.code, p.price_basic, p.price_gold, p.price_platinum, p.icon, \
                p.status AS product_status, \
                c.id AS category_id, c.name AS category_name, c.slug AS category_slug, \
                c.status AS category_status, c.is_active AS category_is_active, \
                o.id AS operator_id, o.name AS operator_name, o.slug AS operator_slug, \
                o.icon AS operator_icon, o.status AS operator_status, \
                t.id AS product_type_id, t.name AS product_type_name, t.slug AS product_type_slug, \
                t.status AS product_type_status \
           FROM content_flash_products fp \
           JOIN products p ON p.id = fp.product_id AND p.status \
           JOIN categories c ON c.id = p.category_id AND c.status \
           JOIN operators o ON o.id = p.operator_id AND o.status \
           JOIN product_types t ON t.id = p.product_type_id AND t.status \
          WHERE fp.flash_sale_id = ANY($1) \
          ORDER BY fp.flash_sale_id, fp.product_id",
    )
    .bind(sale_ids)
    .fetch_all(pool)
    .await?;
    for row in &rows {
        let sale_id: Uuid = row.get("flash_sale_id");
        products
            .entry(sale_id)
            .or_default()
            .push(public_flash_product_json(row));
    }
    Ok(products)
}

fn public_flash_product_json(row: &PgRow) -> Value {
    json!({
        "productId": {
            "_id": row.get::<Uuid, _>("product_id").to_string(),
            "name": row.get::<String, _>("name"),
            "code": row.get::<String, _>("code"),
            "price": {
                "basic": row.get::<i64, _>("price_basic"),
                "gold": row.get::<i64, _>("price_gold"),
                "platinum": row.get::<i64, _>("price_platinum"),
            },
            "icon": row.get::<Option<String>, _>("icon"),
            "status": row.get::<bool, _>("product_status"),
            "categoryId": {
                "_id": row.get::<Uuid, _>("category_id").to_string(),
                "name": row.get::<String, _>("category_name"),
                "slug": row.get::<String, _>("category_slug"),
                "status": row.get::<bool, _>("category_status"),
                "isActive": row.get::<bool, _>("category_is_active"),
            },
            "operatorId": {
                "_id": row.get::<Uuid, _>("operator_id").to_string(),
                "name": row.get::<String, _>("operator_name"),
                "slug": row.get::<String, _>("operator_slug"),
                "icon": row.get::<String, _>("operator_icon"),
                "status": row.get::<bool, _>("operator_status"),
            },
            "productTypeId": {
                "_id": row.get::<Uuid, _>("product_type_id").to_string(),
                "name": row.get::<String, _>("product_type_name"),
                "slug": row.get::<String, _>("product_type_slug"),
                "status": row.get::<bool, _>("product_type_status"),
            },
        },
        "discountType": row.get::<String, _>("discount_type"),
        "discountValue": row.get::<i64, _>("discount_value"),
        "stock": row.get::<i64, _>("stock"),
        "soldCount": row.get::<i64, _>("sold_count"),
    })
}
