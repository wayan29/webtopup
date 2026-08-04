use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::Value;

use crate::utils::bson::read_i64;

use super::types::{CategoryDependencyCounts, OperatorDependencyCounts};

pub(super) async fn group_counts(
    db: &mongodb::Database,
    collection: &str,
    field: &str,
    filter: Document,
) -> HashMap<String, i64> {
    let pipeline = vec![
        doc! { "$match": filter },
        doc! { "$group": { "_id": format!("${field}"), "count": { "$sum": 1 } } },
    ];
    match db
        .collection::<Document>(collection)
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| Some((d.get_object_id("_id").ok()?.to_hex(), read_i64(&d, "count"))))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn group_string_counts(
    db: &mongodb::Database,
    collection: &str,
    field: &str,
    filter: Document,
) -> HashMap<String, i64> {
    let pipeline = vec![
        doc! { "$match": filter },
        doc! { "$group": { "_id": format!("${field}"), "count": { "$sum": 1 } } },
    ];
    match db
        .collection::<Document>(collection)
        .aggregate(pipeline)
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| Some((d.get_str("_id").ok()?.to_string(), read_i64(&d, "count"))))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn category_dependencies(
    db: &mongodb::Database,
    category_id: &ObjectId,
    category_name: &str,
) -> serde_json::Map<String, Value> {
    let counts = category_dependency_counts(db, category_id, category_name).await;
    dependencies_map(&counts)
}

pub(super) async fn category_dependency_counts(
    db: &mongodb::Database,
    category_id: &ObjectId,
    category_name: &str,
) -> CategoryDependencyCounts {
    let direct_product_count = db
        .collection::<Document>("products")
        .count_documents(doc! { "categoryId": category_id })
        .await
        .unwrap_or(0) as i64;
    let legacy_product_count = db
        .collection::<Document>("products")
        .count_documents(doc! {
            "category": category_name,
            "$or": [{ "categoryId": { "$exists": false } }, { "categoryId": Bson::Null }]
        })
        .await
        .unwrap_or(0) as i64;
    let operator_count = db
        .collection::<Document>("operators")
        .count_documents(doc! { "categoryId": category_id })
        .await
        .unwrap_or(0) as i64;
    let product_type_count = db
        .collection::<Document>("producttypes")
        .count_documents(doc! { "categoryId": category_id })
        .await
        .unwrap_or(0) as i64;
    let product_count = direct_product_count + legacy_product_count;
    let dependency_count = product_count + operator_count + product_type_count;
    CategoryDependencyCounts {
        direct_product_count,
        legacy_product_count,
        product_count,
        operator_count,
        product_type_count,
        dependency_count,
    }
}

fn dependencies_map(counts: &CategoryDependencyCounts) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(
        "directProductCount".to_string(),
        serde_json::json!(counts.direct_product_count),
    );
    map.insert(
        "legacyProductCount".to_string(),
        serde_json::json!(counts.legacy_product_count),
    );
    map.insert(
        "productCount".to_string(),
        serde_json::json!(counts.product_count),
    );
    map.insert(
        "operatorCount".to_string(),
        serde_json::json!(counts.operator_count),
    );
    map.insert(
        "productTypeCount".to_string(),
        serde_json::json!(counts.product_type_count),
    );
    map.insert(
        "dependencyCount".to_string(),
        serde_json::json!(counts.dependency_count),
    );
    map.insert(
        "canDelete".to_string(),
        serde_json::json!(counts.dependency_count == 0),
    );
    map
}

pub(super) fn dependencies_json(counts: &CategoryDependencyCounts) -> Value {
    Value::Object(dependencies_map(counts))
}

pub(super) fn dependency_message(counts: &CategoryDependencyCounts) -> String {
    let mut parts = Vec::new();
    if counts.direct_product_count > 0 {
        parts.push(format!("{} produk", counts.direct_product_count));
    }
    if counts.legacy_product_count > 0 {
        parts.push(format!("{} referensi legacy", counts.legacy_product_count));
    }
    if counts.operator_count > 0 {
        parts.push(format!("{} operator", counts.operator_count));
    }
    if counts.product_type_count > 0 {
        parts.push(format!("{} tipe produk", counts.product_type_count));
    }
    if parts.is_empty() {
        "Kategori masih dipakai dan tidak dapat dihapus.".to_string()
    } else {
        format!(
            "Kategori masih dipakai oleh {}. Nonaktifkan kategori jika belum ingin ditampilkan.",
            parts.join(", ")
        )
    }
}

pub(super) async fn operator_dependency_counts(
    db: &mongodb::Database,
    operator_id: &ObjectId,
    operator_name: &str,
    category_id: &ObjectId,
    category_name: &str,
) -> OperatorDependencyCounts {
    let direct_product_count = db
        .collection::<Document>("products")
        .count_documents(doc! { "operatorId": operator_id })
        .await
        .unwrap_or(0) as i64;
    let legacy_product_count = db
        .collection::<Document>("products")
        .count_documents(doc! {
            "brand": operator_name,
            "$and": [
                { "$or": [{ "operatorId": { "$exists": false } }, { "operatorId": Bson::Null }] },
                { "$or": [{ "categoryId": category_id }, { "category": category_name }] }
            ]
        })
        .await
        .unwrap_or(0) as i64;
    let product_type_count = db
        .collection::<Document>("producttypes")
        .count_documents(doc! { "operatorId": operator_id })
        .await
        .unwrap_or(0) as i64;
    let product_count = direct_product_count + legacy_product_count;
    let dependency_count = product_count + product_type_count;
    OperatorDependencyCounts {
        direct_product_count,
        legacy_product_count,
        product_count,
        product_type_count,
        dependency_count,
    }
}

pub(super) fn operator_dependencies_map(
    counts: &OperatorDependencyCounts,
) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(
        "directProductCount".to_string(),
        serde_json::json!(counts.direct_product_count),
    );
    map.insert(
        "legacyProductCount".to_string(),
        serde_json::json!(counts.legacy_product_count),
    );
    map.insert(
        "productCount".to_string(),
        serde_json::json!(counts.product_count),
    );
    map.insert(
        "productTypeCount".to_string(),
        serde_json::json!(counts.product_type_count),
    );
    map.insert(
        "dependencyCount".to_string(),
        serde_json::json!(counts.dependency_count),
    );
    map.insert(
        "canDelete".to_string(),
        serde_json::json!(counts.dependency_count == 0),
    );
    map
}

pub(super) fn operator_dependencies_json(counts: &OperatorDependencyCounts) -> Value {
    Value::Object(operator_dependencies_map(counts))
}

pub(super) fn operator_dependency_message(counts: &OperatorDependencyCounts) -> String {
    let mut parts = Vec::new();
    if counts.direct_product_count > 0 {
        parts.push(format!("{} produk", counts.direct_product_count));
    }
    if counts.legacy_product_count > 0 {
        parts.push(format!("{} referensi legacy", counts.legacy_product_count));
    }
    if counts.product_type_count > 0 {
        parts.push(format!("{} tipe produk", counts.product_type_count));
    }
    if parts.is_empty() {
        "Operator masih dipakai dan tidak dapat dihapus.".to_string()
    } else {
        format!(
            "Operator masih dipakai oleh {}. Nonaktifkan operator jika belum ingin ditampilkan.",
            parts.join(", ")
        )
    }
}

pub(super) fn product_type_dependencies_json(product_count: i64) -> Value {
    serde_json::json!({
        "productCount": product_count,
        "dependencyCount": product_count,
        "canDelete": product_count == 0,
    })
}

pub(super) fn product_type_dependency_message(product_count: i64) -> String {
    if product_count > 0 {
        format!(
            "Jenis produk masih dipakai oleh {product_count} produk. Nonaktifkan jenis produk jika belum ingin ditampilkan."
        )
    } else {
        "Jenis produk masih dipakai dan tidak dapat dihapus.".to_string()
    }
}
