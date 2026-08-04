use std::collections::HashMap;

use mongodb::bson::Document;

use crate::utils::bson::{read_i64, read_string};

use super::{
    types::{
        ApiCategoryItem, ApiOperatorItem, ApiProductItem, ApiProductTypeItem, ApiTransactionDetail,
        ApiTransactionItem,
    },
    utils::{date_string, id_value, object_id_from_bson, optional_string},
};

pub fn api_category_item(doc: Document) -> ApiCategoryItem {
    ApiCategoryItem {
        id: object_id_from_bson(doc.get("_id"))
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&doc, "name"),
        slug: read_string(&doc, "slug"),
    }
}

pub fn api_operator_item(doc: Document, categories: &HashMap<String, String>) -> ApiOperatorItem {
    let category_id = object_id_from_bson(doc.get("categoryId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    ApiOperatorItem {
        id: object_id_from_bson(doc.get("_id"))
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&doc, "name"),
        slug: read_string(&doc, "slug"),
        category: categories.get(&category_id).cloned().unwrap_or_default(),
    }
}

pub fn api_product_type_item(
    doc: Document,
    categories: &HashMap<String, String>,
    operators: &HashMap<String, String>,
) -> ApiProductTypeItem {
    let category_id = object_id_from_bson(doc.get("categoryId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let operator_id = object_id_from_bson(doc.get("operatorId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    ApiProductTypeItem {
        id: object_id_from_bson(doc.get("_id"))
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&doc, "name"),
        slug: read_string(&doc, "slug"),
        category: categories.get(&category_id).cloned().unwrap_or_default(),
        operator: operators.get(&operator_id).cloned().unwrap_or_default(),
    }
}

pub fn api_product_item(
    doc: Document,
    level: &str,
    categories: &HashMap<String, String>,
    operators: &HashMap<String, String>,
    product_types: &HashMap<String, String>,
) -> ApiProductItem {
    let category_id = object_id_from_bson(doc.get("categoryId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let operator_id = object_id_from_bson(doc.get("operatorId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product_type_id = object_id_from_bson(doc.get("productTypeId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let code = read_string(&doc, "code");
    let name = read_string(&doc, "name");
    let category = categories
        .get(&category_id)
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| read_string(&doc, "category"));
    let operator = operators.get(&operator_id).cloned().unwrap_or_default();
    let product_type = product_types
        .get(&product_type_id)
        .cloned()
        .unwrap_or_default();
    ApiProductItem {
        code: code.clone(),
        name: name.clone(),
        category: category.clone(),
        operator: operator.clone(),
        product_type: product_type.clone(),
        product_code_alias: code,
        product_name_alias: name,
        category_name: category,
        operator_name: operator,
        jenis_name: product_type,
        price: doc
            .get_document("price")
            .ok()
            .map(|price| read_i64(price, level))
            .unwrap_or_default(),
        status: if doc.get_bool("status").unwrap_or(false) {
            "available"
        } else {
            "unavailable"
        },
    }
}

pub fn api_transaction_item(
    doc: Document,
    products: &HashMap<String, (String, String)>,
) -> ApiTransactionItem {
    let product_id = object_id_from_bson(doc.get("product"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product = products.get(&product_id);
    ApiTransactionItem {
        trx_id: id_value(&doc),
        ref_id: optional_string(&doc, "customerRefId"),
        product_code: product.map(|value| value.0.clone()),
        product_name: product.map(|value| value.1.clone()),
        target: read_string(&doc, "target"),
        price: read_i64(&doc, "amount"),
        status: read_string(&doc, "status"),
        sn: optional_string(&doc, "sn"),
        created_at: date_string(&doc, "createdAt"),
    }
}

pub fn api_transaction_detail(
    doc: Document,
    products: &HashMap<String, (String, String)>,
) -> ApiTransactionDetail {
    let product_id = object_id_from_bson(doc.get("product"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product = products.get(&product_id);
    ApiTransactionDetail {
        trx_id: id_value(&doc),
        ref_id: optional_string(&doc, "customerRefId"),
        product_code: product.map(|value| value.0.clone()),
        product_name: product.map(|value| value.1.clone()),
        target: read_string(&doc, "target"),
        price: read_i64(&doc, "amount"),
        status: read_string(&doc, "status"),
        sn: optional_string(&doc, "sn"),
        created_at: date_string(&doc, "createdAt"),
        updated_at: date_string(&doc, "updatedAt"),
    }
}
