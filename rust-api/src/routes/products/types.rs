use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

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

#[derive(Clone)]
pub(super) struct ResolvedCategory {
    pub(super) id: Uuid,
    pub(super) name: String,
}

#[derive(Clone)]
pub(super) struct ResolvedOperator {
    pub(super) id: Uuid,
    pub(super) name: String,
    pub(super) category_id: Uuid,
}

#[derive(Clone)]
pub(super) struct ResolvedProductType {
    pub(super) id: Uuid,
    pub(super) category_id: Uuid,
    pub(super) operator_id: Uuid,
}

#[derive(Clone, Default)]
pub(super) struct ProductPrice {
    pub(super) basic: i64,
    pub(super) gold: i64,
    pub(super) platinum: i64,
}

#[derive(Clone, Default)]
pub(super) struct ProductVendor {
    pub(super) name: String,
    pub(super) sku: String,
}

pub(super) struct ProductNormalizedPayload {
    pub(super) name: String,
    pub(super) code: String,
    pub(super) category: String,
    pub(super) category_id: Uuid,
    pub(super) operator_id: Uuid,
    pub(super) product_type_id: Uuid,
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
