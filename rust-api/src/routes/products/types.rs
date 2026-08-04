use std::collections::HashMap;

use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct AdminProductsQuery {
    pub(super) category: Option<String>,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<String>,
    #[serde(rename = "productTypeId")]
    pub(super) product_type_id: Option<String>,
    pub(super) brand: Option<String>,
    pub(super) search: Option<String>,
    pub(super) status: Option<String>,
}

#[derive(Deserialize)]
pub struct CatalogAuditQuery {
    pub(super) limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct ProductSortingQuery {
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<String>,
    #[serde(rename = "productTypeId")]
    pub(super) product_type_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SortOrderPayload {
    pub(super) products: Option<Vec<SortOrderProduct>>,
}

#[derive(Deserialize)]
pub struct ProductPayload(pub(super) Value);

#[derive(Deserialize)]
pub struct SortByPricePayload {
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<String>,
    #[serde(rename = "productTypeId")]
    pub(super) product_type_id: Option<String>,
    pub(super) order: Option<String>,
}

#[derive(Deserialize)]
pub struct SortOrderProduct {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
}

#[derive(Serialize)]
pub(super) struct ProductItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "productId")]
    pub(super) product_id: i64,
    pub(super) code: String,
    pub(super) name: String,
    pub(super) category: String,
    #[serde(rename = "categoryId", skip_serializing_if = "Option::is_none")]
    pub(super) category_id: Option<CategoryBrief>,
    #[serde(rename = "operatorId", skip_serializing_if = "Option::is_none")]
    pub(super) operator_id: Option<OperatorBrief>,
    #[serde(rename = "productTypeId", skip_serializing_if = "Option::is_none")]
    pub(super) product_type_id: Option<ProductTypeBrief>,
    #[serde(rename = "paymentType")]
    pub(super) payment_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) icon: Option<String>,
    #[serde(rename = "rewardPoints")]
    pub(super) reward_points: i64,
    pub(super) brand: String,
    #[serde(rename = "costPrice")]
    pub(super) cost_price: i64,
    pub(super) price: ProductPrice,
    pub(super) vendor: ProductVendor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) validation: Option<ProductValidationConfig>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "canPurchase")]
    pub(super) can_purchase: bool,
    #[serde(rename = "visibilityIssues")]
    pub(super) visibility_issues: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct CategoryBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) icon: String,
    pub(super) slug: String,
    pub(super) status: bool,
}

#[derive(Serialize)]
pub(super) struct OperatorBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) status: bool,
}

#[derive(Serialize)]
pub(super) struct ProductTypeBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) status: bool,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct ProductPrice {
    pub(super) basic: i64,
    pub(super) gold: i64,
    pub(super) platinum: i64,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct ProductVendor {
    pub(super) name: String,
    pub(super) sku: String,
}

#[derive(Default, Serialize)]
pub(super) struct ProductValidationConfig {
    pub(super) enabled: bool,
    #[serde(rename = "type")]
    pub(super) validation_type: String,
    pub(super) game: String,
    #[serde(rename = "targetLabel")]
    pub(super) target_label: String,
    #[serde(rename = "secondaryTargetLabel")]
    pub(super) secondary_target_label: String,
    #[serde(rename = "resultLabel")]
    pub(super) result_label: String,
}

#[derive(Serialize)]
pub(super) struct SortingProductItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) code: String,
    pub(super) name: String,
    pub(super) price: ProductPrice,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
}

#[derive(Serialize)]
pub(super) struct SortOrderResponse {
    pub(super) success: bool,
    pub(super) message: String,
}

#[derive(Serialize)]
pub(super) struct ProductMutationResponse {
    pub(super) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) product: Option<Value>,
    #[serde(rename = "productId", skip_serializing_if = "Option::is_none")]
    pub(super) product_id: Option<String>,
}

#[derive(Clone)]
pub(super) struct CatalogCategory {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) status: bool,
}

#[derive(Clone)]
pub(super) struct CatalogOperator {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) status: bool,
    pub(super) category_id: String,
}

#[derive(Clone)]
pub(super) struct CatalogProductType {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) status: bool,
    pub(super) operator_id: String,
    pub(super) category_id: String,
}

#[derive(Clone)]
pub(super) struct CatalogProduct {
    pub(super) id: String,
    pub(super) code: String,
    pub(super) name: String,
    pub(super) status: bool,
    pub(super) category: String,
    pub(super) brand: String,
    pub(super) category_id: String,
    pub(super) operator_id: String,
    pub(super) product_type_id: String,
}

#[derive(Clone, Serialize)]
pub(super) struct CatalogAuditItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) code: String,
    pub(super) name: String,
    pub(super) status: bool,
    pub(super) category: String,
    pub(super) brand: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: String,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: String,
    #[serde(rename = "productTypeId")]
    pub(super) product_type_id: String,
    pub(super) issues: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct CatalogAuditEntityItem {
    pub(super) name: String,
    pub(super) slug: String,
    #[serde(rename = "categoryId", skip_serializing_if = "Option::is_none")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId", skip_serializing_if = "Option::is_none")]
    pub(super) operator_id: Option<String>,
}

#[derive(Serialize)]
pub(super) struct CatalogAuditSummary {
    pub(super) categories: usize,
    pub(super) operators: usize,
    #[serde(rename = "productTypes")]
    pub(super) product_types: usize,
    pub(super) products: usize,
    #[serde(rename = "productsWithIssues")]
    pub(super) products_with_issues: usize,
    #[serde(rename = "emptyActiveCategories")]
    pub(super) empty_active_categories: usize,
    #[serde(rename = "emptyActiveOperators")]
    pub(super) empty_active_operators: usize,
    #[serde(rename = "emptyActiveProductTypes")]
    pub(super) empty_active_product_types: usize,
}

#[derive(Serialize)]
pub(super) struct CatalogAuditReport {
    #[serde(rename = "generatedAt")]
    pub(super) generated_at: String,
    pub(super) summary: CatalogAuditSummary,
    #[serde(rename = "issueCounts")]
    pub(super) issue_counts: HashMap<String, i64>,
    pub(super) examples: Vec<CatalogAuditItem>,
    #[serde(rename = "emptyActiveCategories")]
    pub(super) empty_active_categories: Vec<CatalogAuditEntityItem>,
    #[serde(rename = "emptyActiveOperators")]
    pub(super) empty_active_operators: Vec<CatalogAuditEntityItem>,
    #[serde(rename = "emptyActiveProductTypes")]
    pub(super) empty_active_product_types: Vec<CatalogAuditEntityItem>,
}

#[derive(Clone)]
pub(super) struct ResolvedCategory {
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Clone)]
pub(super) struct ResolvedOperator {
    pub(super) object_id: ObjectId,
    pub(super) name: String,
    pub(super) category_id: String,
}

#[derive(Clone)]
pub(super) struct ResolvedProductType {
    pub(super) object_id: ObjectId,
    pub(super) category_id: String,
    pub(super) operator_id: String,
}

#[derive(Clone)]
pub(super) struct ProductNormalizedPayload {
    pub(super) name: String,
    pub(super) code: String,
    pub(super) category: String,
    pub(super) category_id: ObjectId,
    pub(super) operator_id: ObjectId,
    pub(super) product_type_id: ObjectId,
    pub(super) payment_type: String,
    pub(super) brand: String,
    pub(super) cost_price: i64,
    pub(super) price: ProductPrice,
    pub(super) reward_points: i64,
    pub(super) icon: String,
    pub(super) vendor: ProductVendor,
    pub(super) status: bool,
    pub(super) sort_order: Option<i64>,
}

impl ProductNormalizedPayload {
    pub(super) fn into_document(
        self,
        product_id: i64,
        sort_order: i64,
        created_at: DateTime,
        updated_at: DateTime,
    ) -> Document {
        let mut document = self.into_update_document(updated_at);
        document.insert("productId", product_id);
        document.insert("sortOrder", sort_order);
        document.insert("createdAt", created_at);
        document
    }

    pub(super) fn into_update_document(self, updated_at: DateTime) -> Document {
        let mut document = doc! {
            "name": self.name,
            "code": self.code,
            "category": self.category,
            "categoryId": self.category_id,
            "operatorId": self.operator_id,
            "productTypeId": self.product_type_id,
            "paymentType": self.payment_type,
            "brand": self.brand,
            "costPrice": self.cost_price,
            "price": { "basic": self.price.basic, "gold": self.price.gold, "platinum": self.price.platinum },
            "rewardPoints": self.reward_points,
            "icon": self.icon,
            "vendor": { "name": self.vendor.name, "sku": self.vendor.sku },
            "status": self.status,
            "updatedAt": updated_at,
        };
        if let Some(sort_order) = self.sort_order {
            document.insert("sortOrder", sort_order);
        }
        document
    }
}
