use mongodb::bson::{doc, oid::ObjectId, Bson, Document};

use crate::utils::bson::{escape_regex, read_string};

use super::{
    id_from_bson, id_from_document, lookup_stage, object_id, unwind_stage, AdminProductsQuery,
    ResolvedCategory, ResolvedOperator, ResolvedProductType,
};

pub(super) fn build_pipeline(query: &AdminProductsQuery) -> Vec<Document> {
    let mut filter = Document::new();
    let status = query.status.as_deref().map(str::trim).unwrap_or_default();
    if !status.is_empty() && status != "all" {
        filter.insert("status", status == "true" || status == "active");
    }
    if let Some(category) = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filter.insert("category", category);
    }
    if let Some(id) = object_id(query.category_id.as_deref()) {
        filter.insert("categoryId", id);
    }
    if let Some(id) = object_id(query.operator_id.as_deref()) {
        filter.insert("operatorId", id);
    }
    if let Some(id) = object_id(query.product_type_id.as_deref()) {
        filter.insert("productTypeId", id);
    }
    if let Some(brand) = query
        .brand
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filter.insert(
            "brand",
            doc! { "$regex": format!("^{}$", escape_regex(brand)), "$options": "i" },
        );
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        filter.insert(
            "$or",
            vec![
                doc! { "name": regex.clone() },
                doc! { "code": regex.clone() },
                doc! { "brand": regex.clone() },
                doc! { "vendor.sku": regex },
            ],
        );
    }

    let mut pipeline = Vec::new();
    if !filter.is_empty() {
        pipeline.push(doc! { "$match": filter });
    }
    pipeline.extend([
        lookup_stage("categories", "categoryId", "categoryData"),
        unwind_stage("$categoryData"),
        lookup_stage("operators", "operatorId", "operatorData"),
        unwind_stage("$operatorData"),
        lookup_stage("producttypes", "productTypeId", "productTypeData"),
        unwind_stage("$productTypeData"),
        doc! { "$sort": { "createdAt": -1 } },
    ]);
    pipeline
}

pub(super) async fn build_public_products_filter(
    db: &mongodb::Database,
    query: &AdminProductsQuery,
) -> Document {
    let mut filters = Vec::new();
    match query.status.as_deref() {
        None => filters.push(doc! { "status": true }),
        Some("all") => {}
        Some(value) => filters.push(doc! { "status": value == "true" }),
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let regex = doc! { "$regex": escape_regex(search), "$options": "i" };
        filters.push(doc! { "$or": [
            { "name": regex.clone() },
            { "code": regex.clone() },
            { "brand": regex }
        ] });
    }

    let resolved_category = resolve_category(db, query).await;
    let resolved_operator = resolve_operator(db, query, resolved_category.as_ref()).await;
    let resolved_product_type = resolve_product_type(db, query).await;
    let mut scoped_operator = resolved_operator.clone();
    let mut scoped_category = resolved_category.clone();
    if scoped_operator.is_none() {
        if let Some(product_type) = &resolved_product_type {
            scoped_operator = resolve_operator_by_id(db, &product_type.operator_id).await;
        }
    }
    if scoped_category.is_none() {
        if let Some(product_type) = &resolved_product_type {
            scoped_category = resolve_category_by_id(db, &product_type.category_id).await;
        }
    }
    if scoped_category.is_none() {
        if let Some(operator) = &scoped_operator {
            scoped_category = resolve_category_by_id(db, &operator.category_id).await;
        }
    }

    if let (Some(product_type), Some(operator)) = (&resolved_product_type, &scoped_operator) {
        let category_id = scoped_category
            .as_ref()
            .map(|value| value.id.as_str())
            .unwrap_or_default();
        let category_name = scoped_category
            .as_ref()
            .map(|value| value.name.as_str())
            .unwrap_or_default();
        filters.push(doc! { "$or": [
            { "productTypeId": product_type.object_id },
            { "$and": [missing_relation_filter("productTypeId"), { "operatorId": operator.object_id }] },
            { "$and": [missing_relation_filter("productTypeId"), legacy_operator_filter(&operator.name, category_id, category_name)] }
        ] });
    } else if let Some(operator) = &scoped_operator {
        let category_id = scoped_category
            .as_ref()
            .map(|value| value.id.as_str())
            .unwrap_or(operator.category_id.as_str());
        let category_name = scoped_category
            .as_ref()
            .map(|value| value.name.as_str())
            .unwrap_or_default();
        filters.push(doc! { "$or": [
            { "operatorId": operator.object_id },
            legacy_operator_filter(&operator.name, category_id, category_name)
        ] });
    } else if let Some(brand) = query
        .brand
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        filters.push(doc! { "brand": exact_name_query(brand) });
    }

    if resolved_product_type.is_none() && scoped_operator.is_none() {
        let category_id = resolved_category
            .as_ref()
            .map(|value| value.id.as_str())
            .unwrap_or_else(|| query.category_id.as_deref().unwrap_or_default());
        let category_name = resolved_category
            .as_ref()
            .map(|value| value.name.as_str())
            .unwrap_or_else(|| query.category.as_deref().unwrap_or_default());
        if let Some(category_filter) = legacy_category_filter(category_id, category_name) {
            filters.push(category_filter);
        }
    }

    match filters.len() {
        0 => Document::new(),
        1 => filters.pop().unwrap_or_default(),
        _ => doc! { "$and": filters },
    }
}

pub(super) async fn resolve_category_by_name(
    db: &mongodb::Database,
    name: &str,
) -> Option<ResolvedCategory> {
    let document = db
        .collection::<Document>("categories")
        .find_one(doc! { "name": exact_name_query(name) })
        .projection(doc! { "name": 1 })
        .await
        .ok()??;
    Some(ResolvedCategory {
        id: id_from_document(&document),
        name: read_string(&document, "name"),
    })
}

pub(super) async fn resolve_category_by_id(
    db: &mongodb::Database,
    id: &str,
) -> Option<ResolvedCategory> {
    resolve_category_by_object_id(db, ObjectId::parse_str(id).ok()?).await
}

pub(super) async fn resolve_category_by_object_id(
    db: &mongodb::Database,
    id: ObjectId,
) -> Option<ResolvedCategory> {
    let document = db
        .collection::<Document>("categories")
        .find_one(doc! { "_id": id })
        .projection(doc! { "name": 1 })
        .await
        .ok()??;
    Some(ResolvedCategory {
        id: id_from_document(&document),
        name: read_string(&document, "name"),
    })
}

pub(super) async fn resolve_operator_by_name(
    db: &mongodb::Database,
    name: &str,
    category: Option<&ResolvedCategory>,
) -> Option<ResolvedOperator> {
    let mut filter = doc! { "name": exact_name_query(name) };
    if let Some(category) = category.and_then(|value| ObjectId::parse_str(&value.id).ok()) {
        filter.insert("categoryId", category);
    }
    let document = db
        .collection::<Document>("operators")
        .find_one(filter)
        .projection(doc! { "name": 1, "categoryId": 1 })
        .sort(doc! { "sortOrder": 1, "name": 1 })
        .await
        .ok()??;
    resolved_operator_from_doc(document)
}

pub(super) async fn resolve_operator_by_id(
    db: &mongodb::Database,
    id: &str,
) -> Option<ResolvedOperator> {
    resolve_operator_by_object_id(db, ObjectId::parse_str(id).ok()?).await
}

pub(super) async fn resolve_operator_by_object_id(
    db: &mongodb::Database,
    id: ObjectId,
) -> Option<ResolvedOperator> {
    let document = db
        .collection::<Document>("operators")
        .find_one(doc! { "_id": id })
        .projection(doc! { "name": 1, "categoryId": 1 })
        .await
        .ok()??;
    resolved_operator_from_doc(document)
}

pub(super) async fn resolve_product_type(
    db: &mongodb::Database,
    query: &AdminProductsQuery,
) -> Option<ResolvedProductType> {
    let id = object_id(query.product_type_id.as_deref())?;
    let document = db
        .collection::<Document>("producttypes")
        .find_one(doc! { "_id": id })
        .projection(doc! { "categoryId": 1, "operatorId": 1 })
        .await
        .ok()??;
    Some(ResolvedProductType {
        object_id: document.get_object_id("_id").ok()?,
        category_id: id_from_bson(document.get("categoryId")),
        operator_id: id_from_bson(document.get("operatorId")),
    })
}

pub(super) fn exact_name_query(value: &str) -> Document {
    doc! { "$regex": format!("^{}$", escape_regex(value)), "$options": "i" }
}

fn resolve_category<'a>(
    db: &'a mongodb::Database,
    query: &'a AdminProductsQuery,
) -> impl std::future::Future<Output = Option<ResolvedCategory>> + 'a {
    async move {
        if let Some(id) = object_id(query.category_id.as_deref()) {
            return resolve_category_by_object_id(db, id).await;
        }
        let name = query.category.as_deref()?.trim();
        if name.is_empty() {
            return None;
        }
        resolve_category_by_name(db, name).await
    }
}

async fn resolve_operator(
    db: &mongodb::Database,
    query: &AdminProductsQuery,
    category: Option<&ResolvedCategory>,
) -> Option<ResolvedOperator> {
    if let Some(id) = object_id(query.operator_id.as_deref()) {
        return resolve_operator_by_object_id(db, id).await;
    }
    let brand = query.brand.as_deref()?.trim();
    if brand.is_empty() {
        return None;
    }
    resolve_operator_by_name(db, brand, category).await
}

fn resolved_operator_from_doc(document: Document) -> Option<ResolvedOperator> {
    let object_id = document.get_object_id("_id").ok()?;
    Some(ResolvedOperator {
        object_id,
        name: read_string(&document, "name"),
        category_id: id_from_bson(document.get("categoryId")),
    })
}

fn missing_relation_filter(field: &str) -> Document {
    doc! { "$or": [{ field: { "$exists": false } }, { field: Bson::Null }] }
}

fn legacy_category_filter(category_id: &str, category_name: &str) -> Option<Document> {
    let mut clauses = Vec::new();
    if !category_id.trim().is_empty() {
        clauses.push(doc! { "categoryId": category_id.trim() });
    }
    if !category_name.trim().is_empty() {
        clauses.push(doc! { "category": exact_name_query(category_name.trim()) });
    }
    match clauses.len() {
        0 => None,
        1 => clauses.into_iter().next(),
        _ => Some(doc! { "$or": clauses }),
    }
}

fn legacy_operator_filter(operator_name: &str, category_id: &str, category_name: &str) -> Document {
    let mut clauses = vec![
        doc! { "brand": exact_name_query(operator_name) },
        missing_relation_filter("operatorId"),
    ];
    if let Some(category_filter) = legacy_category_filter(category_id, category_name) {
        clauses.push(category_filter);
    }
    doc! { "$and": clauses }
}
