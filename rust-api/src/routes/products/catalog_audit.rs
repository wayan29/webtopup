use std::sync::Arc;

use axum::{extract::{Query, State}, response::IntoResponse, Json};
use serde::Serialize;
use sqlx::Row;

use crate::{security::require_sql_permission, state::AppState};
use super::types::CatalogAuditQuery;

#[derive(Serialize)]
struct AuditSummary { categories: i64, operators: i64, product_types: i64, products: i64, products_with_issues: i64, empty_active_categories: i64, empty_active_operators: i64, empty_active_product_types: i64 }
#[derive(Serialize)]
struct AuditIssue { id: String, code: String, name: String, status: bool, category: String, brand: String, category_id: Option<String>, operator_id: Option<String>, product_type_id: Option<String>, issues: Vec<String> }
#[derive(Serialize)]
struct EmptyEntity { name: String, slug: String, category_id: Option<String>, operator_id: Option<String> }
#[derive(Serialize)]
struct AuditReport { generated_at: chrono::DateTime<chrono::Utc>, summary: AuditSummary, issue_counts: std::collections::BTreeMap<String, i64>, examples: Vec<AuditIssue>, empty_active_categories: Vec<EmptyEntity>, empty_active_operators: Vec<EmptyEntity>, empty_active_product_types: Vec<EmptyEntity> }

pub async fn catalog_audit(headers: axum::http::HeaderMap, State(state): State<Arc<AppState>>, Query(query): Query<CatalogAuditQuery>) -> impl IntoResponse {
    if let Err(response) = require_sql_permission(&headers, &state, "manageProducts").await { return response; }
    let limit = query.limit.unwrap_or(100).clamp(1, 500) as i64;
    let counts = sqlx::query("SELECT (SELECT count(*) FROM categories) categories,(SELECT count(*) FROM operators) operators,(SELECT count(*) FROM product_types) product_types,(SELECT count(*) FROM products) products,(SELECT count(*) FROM categories c WHERE c.status AND NOT EXISTS(SELECT 1 FROM operators o WHERE o.category_id=c.id)) empty_active_categories,(SELECT count(*) FROM operators o WHERE o.status AND NOT EXISTS(SELECT 1 FROM products p WHERE p.operator_id=o.id)) empty_active_operators,(SELECT count(*) FROM product_types t WHERE t.status AND NOT EXISTS(SELECT 1 FROM products p WHERE p.product_type_id=t.id)) empty_active_product_types")
        .fetch_one(&state.pg_pool).await;
    let counts = match counts { Ok(row) => row, Err(_) => return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"message":"Database unavailable"}))).into_response() };
    let issue_rows = sqlx::query("SELECT p.id::text id,p.code,p.name,p.status,p.category,p.brand,p.category_id::text category_id,p.operator_id::text operator_id,p.product_type_id::text product_type_id,ARRAY_REMOVE(ARRAY[CASE WHEN p.category_id IS NULL THEN 'missing_category_id' END,CASE WHEN p.operator_id IS NULL THEN 'missing_operator_id' END,CASE WHEN p.product_type_id IS NULL THEN 'missing_product_type_id' END,CASE WHEN p.category_id IS NOT NULL AND c.id IS NULL THEN 'missing_category_ref' END,CASE WHEN p.operator_id IS NOT NULL AND o.id IS NULL THEN 'missing_operator_ref' END,CASE WHEN p.product_type_id IS NOT NULL AND t.id IS NULL THEN 'missing_product_type_ref' END,CASE WHEN c.id IS NOT NULL AND NOT c.status THEN 'inactive_category' END,CASE WHEN o.id IS NOT NULL AND NOT o.status THEN 'inactive_operator' END,CASE WHEN t.id IS NOT NULL AND NOT t.status THEN 'inactive_product_type' END,CASE WHEN o.id IS NOT NULL AND c.id IS NOT NULL AND o.category_id<>c.id THEN 'operator_category_mismatch' END,CASE WHEN t.id IS NOT NULL AND o.id IS NOT NULL AND t.operator_id<>o.id THEN 'type_operator_mismatch' END,CASE WHEN t.id IS NOT NULL AND c.id IS NOT NULL AND t.category_id<>c.id THEN 'type_category_mismatch' END],NULL) issues FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id LEFT JOIN product_types t ON t.id=p.product_type_id WHERE p.category_id IS NULL OR p.operator_id IS NULL OR p.product_type_id IS NULL OR c.id IS NULL OR o.id IS NULL OR t.id IS NULL OR NOT c.status OR NOT o.status OR NOT t.status OR (c.id IS NOT NULL AND o.id IS NOT NULL AND o.category_id<>c.id) OR (t.id IS NOT NULL AND o.id IS NOT NULL AND t.operator_id<>o.id) OR (t.id IS NOT NULL AND c.id IS NOT NULL AND t.category_id<>c.id) ORDER BY p.id LIMIT $1")
        .bind(limit).fetch_all(&state.pg_pool).await;
    let rows = match issue_rows { Ok(rows) => rows, Err(_) => return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"message":"Database unavailable"}))).into_response() };
    let examples: Vec<AuditIssue> = rows.iter().map(|r| { let issues:Vec<String>=r.get("issues"); AuditIssue{id:r.get("id"),code:r.get("code"),name:r.get("name"),status:r.get("status"),category:r.get("category"),brand:r.get("brand"),category_id:r.get("category_id"),operator_id:r.get("operator_id"),product_type_id:r.get("product_type_id"),issues} }).collect();
    let mut issue_counts=std::collections::BTreeMap::new(); for item in &examples { for issue in &item.issues { *issue_counts.entry(issue.clone()).or_insert(0)+=1; } }
    let categories=sqlx::query("SELECT c.name,c.slug FROM categories c WHERE c.status AND NOT EXISTS(SELECT 1 FROM operators o WHERE o.category_id=c.id) ORDER BY c.name LIMIT $1").bind(limit).fetch_all(&state.pg_pool).await;
    let operators=sqlx::query("SELECT o.name,o.slug,o.category_id::text category_id FROM operators o WHERE o.status AND NOT EXISTS(SELECT 1 FROM products p WHERE p.operator_id=o.id) ORDER BY o.name LIMIT $1").bind(limit).fetch_all(&state.pg_pool).await;
    let types=sqlx::query("SELECT t.name,t.slug,t.category_id::text category_id,t.operator_id::text operator_id FROM product_types t WHERE t.status AND NOT EXISTS(SELECT 1 FROM products p WHERE p.product_type_id=t.id) ORDER BY t.name LIMIT $1").bind(limit).fetch_all(&state.pg_pool).await;
    let (Ok(categories),Ok(operators),Ok(types))=(categories,operators,types) else { return (axum::http::StatusCode::SERVICE_UNAVAILABLE,Json(serde_json::json!({"message":"Database unavailable"}))).into_response(); };
    let empty_active_categories=categories.iter().map(|r|EmptyEntity{name:r.get("name"),slug:r.get("slug"),category_id:None,operator_id:None}).collect();
    let empty_active_operators=operators.iter().map(|r|EmptyEntity{name:r.get("name"),slug:r.get("slug"),category_id:r.get("category_id"),operator_id:None}).collect();
    let empty_active_product_types=types.iter().map(|r|EmptyEntity{name:r.get("name"),slug:r.get("slug"),category_id:r.get("category_id"),operator_id:r.get("operator_id")}).collect();
    let product_count:i64=counts.get("products"); let issue_count=examples.len() as i64;
    Json(AuditReport{generated_at:chrono::Utc::now(),summary:AuditSummary{categories:counts.get("categories"),operators:counts.get("operators"),product_types:counts.get("product_types"),products:product_count,products_with_issues:issue_count,empty_active_categories:counts.get("empty_active_categories"),empty_active_operators:counts.get("empty_active_operators"),empty_active_product_types:counts.get("empty_active_product_types")},issue_counts,examples,empty_active_categories,empty_active_operators,empty_active_product_types}).into_response()
}
