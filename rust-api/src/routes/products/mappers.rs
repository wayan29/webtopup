use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::Value;

use crate::utils::bson::{read_i64, read_string};

use super::{
    date_string, document_to_json, id_from_document, lookup_stage, optional_string, unwind_stage,
    CategoryBrief, EmptyStringFallback, OperatorBrief, ProductItem, ProductPrice, ProductTypeBrief,
    ProductValidationConfig, ProductVendor, SortingProductItem,
};

pub(in crate::routes) async fn populated_product_json(
    db: &mongodb::Database,
    id: ObjectId,
) -> Option<Value> {
    let mut pipeline = vec![doc! { "$match": { "_id": id } }];
    pipeline.extend([
        lookup_stage("categories", "categoryId", "categoryData"),
        unwind_stage("$categoryData"),
        lookup_stage("operators", "operatorId", "operatorData"),
        unwind_stage("$operatorData"),
        lookup_stage("producttypes", "productTypeId", "productTypeData"),
        unwind_stage("$productTypeData"),
    ]);
    let mut document = db
        .collection::<Document>("products")
        .aggregate(pipeline)
        .await
        .ok()?
        .try_collect::<Vec<_>>()
        .await
        .ok()?
        .into_iter()
        .next()?;
    replace_product_populate(
        &mut document,
        "categoryId",
        "categoryData",
        &["_id", "name", "icon", "slug", "status"],
    );
    replace_product_populate(
        &mut document,
        "operatorId",
        "operatorData",
        &["_id", "name", "status"],
    );
    replace_product_populate(
        &mut document,
        "productTypeId",
        "productTypeData",
        &["_id", "name", "status"],
    );
    Some(document_to_json(document))
}

pub(super) fn product_item_from_doc(
    mut document: Document,
    inactive_operator_names: &[String],
) -> ProductItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let category = document
        .get_document("categoryData")
        .ok()
        .and_then(category_from_doc);
    let operator = document
        .get_document("operatorData")
        .ok()
        .and_then(operator_from_doc);
    let product_type = document
        .get_document("productTypeData")
        .ok()
        .and_then(product_type_from_doc);
    let mut visibility_issues = Vec::new();
    if category.as_ref().is_some_and(|value| !value.status) {
        visibility_issues.push("Kategori nonaktif".to_string());
    }
    if operator.as_ref().is_some_and(|value| !value.status) {
        visibility_issues.push("Operator nonaktif".to_string());
    } else if operator.is_none()
        && inactive_operator_names.contains(&read_string(&document, "brand").to_lowercase())
    {
        visibility_issues.push("Operator nonaktif".to_string());
    }
    if product_type.as_ref().is_some_and(|value| !value.status) {
        visibility_issues.push("Jenis produk nonaktif".to_string());
    }

    ProductItem {
        id,
        product_id: read_i64(&document, "productId"),
        code: read_string(&document, "code"),
        name: read_string(&document, "name"),
        category: read_string(&document, "category"),
        category_id: category,
        operator_id: operator,
        product_type_id: product_type,
        payment_type: read_string(&document, "paymentType").if_empty("prabayar"),
        icon: optional_string(&document, "icon"),
        reward_points: read_i64(&document, "rewardPoints"),
        brand: read_string(&document, "brand"),
        cost_price: read_i64(&document, "costPrice"),
        price: document
            .get_document("price")
            .map(price_from_doc)
            .unwrap_or_default(),
        vendor: document
            .get_document("vendor")
            .map(vendor_from_doc)
            .unwrap_or_default(),
        validation: map_validation_config(&document),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
        created_at: date_string(&document, "createdAt").unwrap_or_default(),
        updated_at: date_string(&document, "updatedAt").unwrap_or_default(),
        can_purchase: visibility_issues.is_empty(),
        visibility_issues,
    }
}

pub(super) fn public_product_from_doc(
    mut document: Document,
    inactive_category_ids: &[String],
    inactive_operator_ids: &[String],
    inactive_operator_names: &[String],
    inactive_product_type_ids: &[String],
) -> Value {
    let mut visibility_issues = Vec::new();
    let category_id = document
        .get_document("categoryData")
        .ok()
        .and_then(|category| category.get_object_id("_id").ok().map(|id| id.to_hex()));
    let operator_id = document
        .get_document("operatorData")
        .ok()
        .and_then(|operator| operator.get_object_id("_id").ok().map(|id| id.to_hex()));
    let product_type_id = document
        .get_document("productTypeData")
        .ok()
        .and_then(|product_type| product_type.get_object_id("_id").ok().map(|id| id.to_hex()));
    if category_id
        .as_ref()
        .is_some_and(|id| inactive_category_ids.contains(id))
    {
        visibility_issues.push("Kategori nonaktif".to_string());
    }
    if operator_id
        .as_ref()
        .is_some_and(|id| inactive_operator_ids.contains(id))
    {
        visibility_issues.push("Operator nonaktif".to_string());
    } else if operator_id.is_none()
        && inactive_operator_names.contains(&read_string(&document, "brand").to_lowercase())
    {
        visibility_issues.push("Operator nonaktif".to_string());
    }
    if product_type_id
        .as_ref()
        .is_some_and(|id| inactive_product_type_ids.contains(id))
    {
        visibility_issues.push("Jenis produk nonaktif".to_string());
    }
    replace_product_populate(
        &mut document,
        "categoryId",
        "categoryData",
        &["_id", "name", "icon", "slug", "status"],
    );
    replace_product_populate(
        &mut document,
        "operatorId",
        "operatorData",
        &["_id", "name", "status"],
    );
    replace_product_populate(
        &mut document,
        "productTypeId",
        "productTypeData",
        &["_id", "name", "status"],
    );
    if !document.contains_key("sortOrder") {
        document.insert("sortOrder", 0);
    }
    normalize_validation_config(&mut document);
    document.insert("canPurchase", visibility_issues.is_empty());
    document.insert("visibilityIssues", visibility_issues);
    document_to_json(document)
}

pub(super) fn normalize_validation_config(document: &mut Document) {
    let product_name = read_string(document, "name").to_lowercase();
    let Ok(validation) = document.get_document_mut("validation") else {
        return;
    };
    if !validation.get_bool("enabled").unwrap_or(false) {
        return;
    }
    let target_label = read_string(validation, "targetLabel").to_lowercase();
    let result_label = read_string(validation, "resultLabel").to_lowercase();
    if read_string(validation, "type") == "nickname"
        && (product_name.contains("operator")
            || target_label.contains("nomor")
            || result_label.contains("operator"))
    {
        validation.insert("type", "operator");
        validation.insert("game", "");
        validation.insert("targetLabel", "Nomor HP");
        validation.insert("secondaryTargetLabel", "");
        validation.insert("resultLabel", "Operator");
        return;
    }
    if read_string(validation, "type") == "nickname"
        && read_string(validation, "game") != "mobilelegends"
        && read_string(validation, "secondaryTargetLabel")
            .to_lowercase()
            .contains("zone")
    {
        validation.insert("game", "mobilelegends");
    }
}

pub(super) fn sorting_product_from_doc(document: Document) -> SortingProductItem {
    SortingProductItem {
        id: id_from_document(&document),
        code: read_string(&document, "code"),
        name: read_string(&document, "name"),
        price: document
            .get_document("price")
            .map(price_from_doc)
            .unwrap_or_default(),
        sort_order: read_i64(&document, "sortOrder"),
        status: document.get_bool("status").unwrap_or(true),
    }
}

fn map_validation_config(document: &Document) -> Option<ProductValidationConfig> {
    let validation = document.get_document("validation").ok()?;
    if !validation.get_bool("enabled").unwrap_or(false) {
        return None;
    }
    let mut validation_type = read_string(validation, "type");
    let mut target_label = read_string(validation, "targetLabel");
    let mut secondary_target_label = read_string(validation, "secondaryTargetLabel");
    let mut result_label = read_string(validation, "resultLabel");
    let mut game = read_string(validation, "game");
    if validation_type == "nickname"
        && (read_string(document, "name")
            .to_lowercase()
            .contains("operator")
            || target_label.to_lowercase().contains("nomor")
            || result_label.to_lowercase().contains("operator"))
    {
        validation_type = "operator".to_string();
        game.clear();
        target_label = "Nomor HP".to_string();
        secondary_target_label.clear();
        result_label = "Operator".to_string();
    } else if validation_type == "nickname"
        && game != "mobilelegends"
        && secondary_target_label.to_lowercase().contains("zone")
    {
        game = "mobilelegends".to_string();
    }
    Some(ProductValidationConfig {
        enabled: true,
        validation_type,
        game,
        target_label,
        secondary_target_label,
        result_label,
    })
}

fn replace_product_populate(document: &mut Document, field: &str, data_field: &str, keys: &[&str]) {
    if let Ok(data) = document.get_document(data_field) {
        let mut populated = Document::new();
        for key in keys {
            if let Some(value) = data.get(*key) {
                populated.insert(*key, value.clone());
            }
        }
        if !populated.is_empty() {
            document.insert(field, Bson::Document(populated));
        }
    }
    document.remove(data_field);
}

fn category_from_doc(document: &Document) -> Option<CategoryBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(CategoryBrief {
        id,
        name: read_string(document, "name"),
        icon: read_string(document, "icon"),
        slug: read_string(document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

fn operator_from_doc(document: &Document) -> Option<OperatorBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(OperatorBrief {
        id,
        name: read_string(document, "name"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

fn product_type_from_doc(document: &Document) -> Option<ProductTypeBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(ProductTypeBrief {
        id,
        name: read_string(document, "name"),
        status: document.get_bool("status").unwrap_or(true),
    })
}

pub(super) fn price_from_doc(document: &Document) -> ProductPrice {
    ProductPrice {
        basic: read_i64(document, "basic"),
        gold: read_i64(document, "gold"),
        platinum: read_i64(document, "platinum"),
    }
}

pub(super) fn vendor_from_doc(document: &Document) -> ProductVendor {
    ProductVendor {
        name: read_string(document, "name"),
        sku: read_string(document, "sku"),
    }
}
