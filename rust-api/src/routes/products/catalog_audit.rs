use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, Document};

use crate::utils::bson::read_string;

use super::{
    get_non_empty, id_from_bson, id_from_document, normalize, CatalogAuditEntityItem,
    CatalogAuditItem, CatalogAuditReport, CatalogAuditSummary, CatalogCategory, CatalogOperator,
    CatalogProduct, CatalogProductType,
};

pub(super) async fn load_documents(collection: mongodb::Collection<Document>) -> Vec<Document> {
    match collection.find(doc! {}).await {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(super) fn run_catalog_audit(
    limit: usize,
    categories: Vec<CatalogCategory>,
    operators: Vec<CatalogOperator>,
    product_types: Vec<CatalogProductType>,
    products: Vec<CatalogProduct>,
) -> CatalogAuditReport {
    let categories_by_id = categories
        .iter()
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<HashMap<_, _>>();
    let operators_by_id = operators
        .iter()
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<HashMap<_, _>>();
    let product_types_by_id = product_types
        .iter()
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<HashMap<_, _>>();

    let mut categories_by_name: HashMap<String, Vec<CatalogCategory>> = HashMap::new();
    for category in &categories {
        categories_by_name
            .entry(normalize(&category.name))
            .or_default()
            .push(category.clone());
    }
    let mut operators_by_name: HashMap<String, Vec<CatalogOperator>> = HashMap::new();
    for operator in &operators {
        operators_by_name
            .entry(normalize(&operator.name))
            .or_default()
            .push(operator.clone());
    }

    let audited_products = products
        .iter()
        .map(|product| {
            let category =
                get_non_empty(&product.category_id).and_then(|id| categories_by_id.get(id));
            let operator =
                get_non_empty(&product.operator_id).and_then(|id| operators_by_id.get(id));
            let product_type =
                get_non_empty(&product.product_type_id).and_then(|id| product_types_by_id.get(id));
            let mut issues = Vec::new();

            if product.category_id.is_empty() {
                issues.push("missing_category_id".to_string());
            }
            if product.operator_id.is_empty() {
                issues.push("missing_operator_id".to_string());
            }
            if product.product_type_id.is_empty() {
                issues.push("missing_product_type_id".to_string());
            }
            if !product.category_id.is_empty() && category.is_none() {
                issues.push("missing_category_ref".to_string());
            }
            if !product.operator_id.is_empty() && operator.is_none() {
                issues.push("missing_operator_ref".to_string());
            }
            if !product.product_type_id.is_empty() && product_type.is_none() {
                issues.push("missing_product_type_ref".to_string());
            }
            if category.is_some_and(|value| !value.status) {
                issues.push("inactive_category".to_string());
            }
            if operator.is_some_and(|value| !value.status) {
                issues.push("inactive_operator".to_string());
            }
            if product_type.is_some_and(|value| !value.status) {
                issues.push("inactive_product_type".to_string());
            }
            if let (Some(category), Some(operator)) = (category, operator) {
                if operator.category_id != category.id {
                    issues.push("operator_category_mismatch".to_string());
                }
            }
            if let (Some(product_type), Some(operator)) = (product_type, operator) {
                if product_type.operator_id != operator.id {
                    issues.push("type_operator_mismatch".to_string());
                }
            }
            if let (Some(product_type), Some(category)) = (product_type, category) {
                if product_type.category_id != category.id {
                    issues.push("type_category_mismatch".to_string());
                }
            }
            if let Some(category) = category {
                if !normalize(&product.category).is_empty()
                    && normalize(&product.category) != normalize(&category.name)
                {
                    issues.push("legacy_category_text_mismatch".to_string());
                }
            }
            if let Some(operator) = operator {
                if !normalize(&product.brand).is_empty()
                    && normalize(&product.brand) != normalize(&operator.name)
                {
                    issues.push("legacy_brand_mismatch".to_string());
                }
            }
            if product.category_id.is_empty() && !normalize(&product.category).is_empty() {
                let matches = categories_by_name
                    .get(&normalize(&product.category))
                    .map(Vec::len)
                    .unwrap_or_default();
                if matches == 0 {
                    issues.push("unresolved_legacy_category".to_string());
                }
            }
            if product.operator_id.is_empty() && !normalize(&product.brand).is_empty() {
                let matches = operators_by_name
                    .get(&normalize(&product.brand))
                    .map(Vec::len)
                    .unwrap_or_default();
                if matches == 0 {
                    issues.push("unresolved_legacy_brand".to_string());
                } else if matches > 1 {
                    issues.push("ambiguous_legacy_brand".to_string());
                }
            }

            CatalogAuditItem {
                id: product.id.clone(),
                code: product.code.clone(),
                name: product.name.clone(),
                status: product.status,
                category: product.category.clone(),
                brand: product.brand.clone(),
                category_id: product.category_id.clone(),
                operator_id: product.operator_id.clone(),
                product_type_id: product.product_type_id.clone(),
                issues,
            }
        })
        .collect::<Vec<_>>();

    let mut issue_counts = HashMap::new();
    for product in &audited_products {
        for issue in &product.issues {
            *issue_counts.entry(issue.clone()).or_insert(0) += 1;
        }
    }

    let products_with_issues = audited_products
        .iter()
        .filter(|item| !item.issues.is_empty())
        .cloned()
        .collect::<Vec<_>>();

    let mut product_counts_by_category: HashMap<String, i64> = HashMap::new();
    let mut product_counts_by_operator: HashMap<String, i64> = HashMap::new();
    let mut product_counts_by_type: HashMap<String, i64> = HashMap::new();
    for product in &products {
        if !product.category_id.is_empty() {
            *product_counts_by_category
                .entry(product.category_id.clone())
                .or_default() += 1;
        }
        if !product.operator_id.is_empty() {
            *product_counts_by_operator
                .entry(product.operator_id.clone())
                .or_default() += 1;
        }
        if !product.product_type_id.is_empty() {
            *product_counts_by_type
                .entry(product.product_type_id.clone())
                .or_default() += 1;
        }
    }

    let empty_active_categories = categories
        .iter()
        .filter(|item| item.status && !product_counts_by_category.contains_key(&item.id))
        .map(|item| CatalogAuditEntityItem {
            name: item.name.clone(),
            slug: item.slug.clone(),
            category_id: None,
            operator_id: None,
        })
        .collect::<Vec<_>>();
    let empty_active_operators = operators
        .iter()
        .filter(|item| item.status && !product_counts_by_operator.contains_key(&item.id))
        .map(|item| CatalogAuditEntityItem {
            name: item.name.clone(),
            slug: item.slug.clone(),
            category_id: Some(item.category_id.clone()),
            operator_id: None,
        })
        .collect::<Vec<_>>();
    let empty_active_product_types = product_types
        .iter()
        .filter(|item| item.status && !product_counts_by_type.contains_key(&item.id))
        .map(|item| CatalogAuditEntityItem {
            name: item.name.clone(),
            slug: item.slug.clone(),
            category_id: Some(item.category_id.clone()),
            operator_id: Some(item.operator_id.clone()),
        })
        .collect::<Vec<_>>();

    CatalogAuditReport {
        generated_at: mongodb::bson::DateTime::now()
            .try_to_rfc3339_string()
            .unwrap_or_default(),
        summary: CatalogAuditSummary {
            categories: categories.len(),
            operators: operators.len(),
            product_types: product_types.len(),
            products: products.len(),
            products_with_issues: products_with_issues.len(),
            empty_active_categories: empty_active_categories.len(),
            empty_active_operators: empty_active_operators.len(),
            empty_active_product_types: empty_active_product_types.len(),
        },
        issue_counts,
        examples: products_with_issues.into_iter().take(limit).collect(),
        empty_active_categories: empty_active_categories.into_iter().take(limit).collect(),
        empty_active_operators: empty_active_operators.into_iter().take(limit).collect(),
        empty_active_product_types: empty_active_product_types.into_iter().take(limit).collect(),
    }
}

pub(super) fn catalog_category_from_doc(document: Document) -> CatalogCategory {
    CatalogCategory {
        id: id_from_document(&document),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
    }
}

pub(super) fn catalog_operator_from_doc(document: Document) -> CatalogOperator {
    CatalogOperator {
        id: id_from_document(&document),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
        category_id: id_from_bson(document.get("categoryId")),
    }
}

pub(super) fn catalog_product_type_from_doc(document: Document) -> CatalogProductType {
    CatalogProductType {
        id: id_from_document(&document),
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        status: document.get_bool("status").unwrap_or(true),
        operator_id: id_from_bson(document.get("operatorId")),
        category_id: id_from_bson(document.get("categoryId")),
    }
}

pub(super) fn catalog_product_from_doc(document: Document) -> CatalogProduct {
    CatalogProduct {
        id: id_from_document(&document),
        code: read_string(&document, "code"),
        name: read_string(&document, "name"),
        status: document.get_bool("status").unwrap_or(false),
        category: read_string(&document, "category"),
        brand: read_string(&document, "brand"),
        category_id: id_from_bson(document.get("categoryId")),
        operator_id: id_from_bson(document.get("operatorId")),
        product_type_id: id_from_bson(document.get("productTypeId")),
    }
}
