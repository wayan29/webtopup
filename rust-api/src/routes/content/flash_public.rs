use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::{Map, Value};

use crate::{
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    calculate_flash_price, collect_flash_sale_product_ids, date_time_to_mongoose_string,
    document_to_json, json_to_bson, number_from_bson, object_id_from_bson, status_message,
    unavailable,
};

pub async fn flash_sales_active(State(state): State<Arc<AppState>>) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let sales = match db
        .collection::<Document>("flashsales")
        .find(doc! { "isActive": true, "startDate": { "$lte": now }, "endDate": { "$gte": now } })
        .sort(doc! { "startDate": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let product_ids = collect_flash_sale_product_ids(&sales);
    let products = public_product_populate_map(client, &state.mongo_db, product_ids).await;
    let items = sales
        .into_iter()
        .filter_map(|sale| public_flash_sale_from_doc(sale, &products))
        .collect::<Vec<_>>();
    Json(items).into_response()
}

pub async fn flash_sale_price(
    State(state): State<Arc<AppState>>,
    Path(product_id): Path<String>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Ok(product_object_id) = ObjectId::parse_str(product_id.trim()) else {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    };
    let db = client.database(&state.mongo_db);
    let now = DateTime::now();
    let sale = match db
        .collection::<Document>("flashsales")
        .find_one(doc! { "isActive": true, "startDate": { "$lte": now }, "endDate": { "$gte": now }, "products.productId": product_object_id })
        .await
    {
        Ok(value) => value,
        Err(_) => {
            return status_message(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
            );
        }
    };
    let Some(sale) = sale else {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    };
    let flash_product = sale.get_array("products").ok().and_then(|products| {
        products
            .iter()
            .filter_map(Bson::as_document)
            .find(|product| {
                object_id_from_bson(product.get("productId")) == Some(product_object_id)
            })
    });
    let Some(flash_product) = flash_product else {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    };
    let stock = number_from_bson(flash_product.get("stock")).unwrap_or_default();
    let sold_count = number_from_bson(flash_product.get("soldCount")).unwrap_or_default();
    if sold_count >= stock {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    }
    let product = match db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_object_id })
        .await
    {
        Ok(value) => value,
        Err(_) => None,
    };
    let Some(product) = product else {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    };
    if !product.get_bool("status").unwrap_or(true) {
        return Json(serde_json::json!({ "hasFlashSale": false })).into_response();
    }
    let original_price = product
        .get_document("price")
        .map(|price| read_i64(price, "basic"))
        .unwrap_or_default();
    let discount_type = read_string(flash_product, "discountType");
    let discount_value = number_from_bson(flash_product.get("discountValue")).unwrap_or_default();
    Json(serde_json::json!({
        "hasFlashSale": true,
        "flashSaleId": sale.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default(),
        "flashSaleName": read_string(&sale, "name"),
        "originalPrice": original_price,
        "flashPrice": calculate_flash_price(original_price, &discount_type, discount_value),
        "discountType": discount_type,
        "discountValue": discount_value,
        "stock": stock,
        "soldCount": sold_count,
        "remainingStock": stock - sold_count,
        "endDate": sale.get_datetime("endDate").map(|value| date_time_to_mongoose_string(*value)).unwrap_or_default(),
    }))
    .into_response()
}

async fn public_product_populate_map(
    client: &mongodb::Client,
    db_name: &str,
    product_ids: Vec<ObjectId>,
) -> HashMap<String, Value> {
    if product_ids.is_empty() {
        return HashMap::new();
    }
    let db = client.database(db_name);
    let pipeline = vec![
        doc! { "$match": { "_id": { "$in": product_ids } } },
        doc! { "$lookup": { "from": "categories", "localField": "categoryId", "foreignField": "_id", "as": "categoryId" } },
        doc! { "$unwind": { "path": "$categoryId", "preserveNullAndEmptyArrays": true } },
        doc! { "$lookup": { "from": "operators", "localField": "operatorId", "foreignField": "_id", "as": "operatorId" } },
        doc! { "$unwind": { "path": "$operatorId", "preserveNullAndEmptyArrays": true } },
        doc! { "$lookup": { "from": "producttypes", "localField": "productTypeId", "foreignField": "_id", "as": "productTypeId" } },
        doc! { "$unwind": { "path": "$productTypeId", "preserveNullAndEmptyArrays": true } },
        doc! { "$project": {
            "name": 1,
            "code": 1,
            "price": 1,
            "icon": 1,
            "status": 1,
            "categoryId": { "_id": 1, "name": 1, "slug": 1, "status": 1, "isActive": 1 },
            "operatorId": { "_id": 1, "name": 1, "slug": 1, "icon": 1, "status": 1 },
            "productTypeId": { "_id": 1, "name": 1, "slug": 1, "status": 1 },
        } },
    ];
    match db
        .collection::<Document>("products")
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|document| {
                let id = document.get_object_id("_id").ok()?.to_hex();
                Some((id, document_to_json(document)))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

fn public_flash_sale_from_doc(
    mut sale: Document,
    products: &HashMap<String, Value>,
) -> Option<Value> {
    let source_products = sale.get_array("products").cloned().unwrap_or_default();
    let mut visible_products = Vec::new();
    for item in source_products {
        let Some(item_doc) = item.as_document() else {
            continue;
        };
        let Some(product_ref_id) =
            object_id_from_bson(item_doc.get("productId")).map(|id| id.to_hex())
        else {
            continue;
        };
        let Some(product) = products.get(&product_ref_id) else {
            continue;
        };
        if product.get("status").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if !public_entity_active(product.get("categoryId"))
            || !public_entity_active(product.get("operatorId"))
            || !public_entity_active(product.get("productTypeId"))
        {
            continue;
        }
        let mut item_map = Map::new();
        item_map.insert("productId".to_string(), product.clone());
        item_map.insert(
            "discountType".to_string(),
            Value::String(read_string(item_doc, "discountType")),
        );
        item_map.insert(
            "discountValue".to_string(),
            Value::Number(
                number_from_bson(item_doc.get("discountValue"))
                    .unwrap_or_default()
                    .into(),
            ),
        );
        item_map.insert(
            "stock".to_string(),
            Value::Number(
                number_from_bson(item_doc.get("stock"))
                    .unwrap_or_default()
                    .into(),
            ),
        );
        item_map.insert(
            "soldCount".to_string(),
            Value::Number(
                number_from_bson(item_doc.get("soldCount"))
                    .unwrap_or_default()
                    .into(),
            ),
        );
        visible_products.push(Value::Object(item_map));
    }
    if visible_products.is_empty() {
        return None;
    }
    sale.insert(
        "products",
        Bson::Array(visible_products.into_iter().map(json_to_bson).collect()),
    );
    Some(document_to_json(sale))
}

fn public_entity_active(value: Option<&Value>) -> bool {
    let Some(Value::Object(map)) = value else {
        return false;
    };
    if let Some(Value::Bool(status)) = map.get("status") {
        return *status;
    }
    if let Some(Value::Bool(is_active)) = map.get("isActive") {
        return *is_active;
    }
    true
}
