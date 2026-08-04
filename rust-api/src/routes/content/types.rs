use mongodb::bson::{oid::ObjectId, DateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct SliderItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) image: String,
    pub(super) link: String,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Deserialize)]
pub struct SliderPayload {
    pub(super) name: Option<Value>,
    pub(super) image: Option<Value>,
    pub(super) link: Option<Value>,
    pub(super) status: Option<Value>,
}

#[derive(Deserialize)]
pub struct SliderSortOrderPayload {
    pub(super) orders: Option<Vec<SliderSortOrderItem>>,
}

#[derive(Deserialize)]
pub struct FlashSalePayload {
    pub(super) name: Option<Value>,
    pub(super) description: Option<Value>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<Value>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<Value>,
    pub(super) products: Option<Value>,
    #[serde(rename = "isActive")]
    pub(super) is_active: Option<Value>,
    pub(super) banner: Option<Value>,
}

#[derive(Deserialize)]
pub struct FlashSaleProductPayload {
    #[serde(rename = "productId")]
    pub(super) product_id: Option<Value>,
    #[serde(rename = "discountType")]
    pub(super) discount_type: Option<Value>,
    #[serde(rename = "discountValue")]
    pub(super) discount_value: Option<Value>,
    pub(super) stock: Option<Value>,
    #[serde(rename = "soldCount")]
    pub(super) sold_count: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct SliderSortOrderItem {
    pub(super) id: Option<Value>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<Value>,
}

#[derive(Clone)]
pub(super) struct NormalizedFlashSaleProduct {
    pub(super) product_id: ObjectId,
    pub(super) discount_type: String,
    pub(super) discount_value: i64,
    pub(super) stock: i64,
    pub(super) sold_count: i64,
}

pub(super) struct NormalizedFlashSalePayload {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) start_date: DateTime,
    pub(super) end_date: DateTime,
    pub(super) products: Vec<NormalizedFlashSaleProduct>,
    pub(super) is_active: bool,
    pub(super) banner: String,
}

pub(super) struct ProductValidationSnapshot {
    pub(super) id: ObjectId,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) base_price: i64,
    pub(super) cost_price: i64,
    pub(super) status: bool,
}

#[derive(Serialize)]
pub(super) struct SliderResponse {
    pub(super) message: &'static str,
    pub(super) slider: Value,
}

#[derive(Serialize)]
pub(super) struct FlashSaleResponse {
    pub(super) message: &'static str,
    #[serde(rename = "flashSale")]
    pub(super) flash_sale: Value,
}

#[derive(Serialize)]
pub(super) struct MessageResponse {
    pub(super) message: &'static str,
}

#[derive(Clone)]
pub(super) struct ProductSnapshot {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) price: ProductPrice,
    pub(super) icon: Option<String>,
    pub(super) status: bool,
    pub(super) cost_price: Option<i64>,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct ProductPrice {
    pub(super) basic: i64,
    pub(super) gold: i64,
    pub(super) platinum: i64,
}

#[derive(Clone, Serialize)]
pub(super) struct FlashSaleProductRef {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) price: ProductPrice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) icon: Option<String>,
    pub(super) status: bool,
    #[serde(rename = "costPrice", skip_serializing_if = "Option::is_none")]
    pub(super) cost_price: Option<i64>,
}

#[derive(Clone, Serialize)]
pub(super) struct FlashSaleProductItem {
    #[serde(rename = "productRefId")]
    pub(super) product_ref_id: String,
    #[serde(rename = "productId")]
    pub(super) product_id: Option<FlashSaleProductRef>,
    #[serde(rename = "discountType")]
    pub(super) discount_type: String,
    #[serde(rename = "discountValue")]
    pub(super) discount_value: i64,
    pub(super) stock: i64,
    #[serde(rename = "soldCount")]
    pub(super) sold_count: i64,
}

#[derive(Clone)]
pub(super) struct FlashSaleRecord {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: String,
    pub(super) start_date: DateTime,
    pub(super) end_date: DateTime,
    pub(super) products: Vec<FlashSaleProductItem>,
    pub(super) is_active: bool,
    pub(super) banner: String,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct FlashSaleSummary {
    #[serde(rename = "productCount")]
    pub(super) product_count: i64,
    #[serde(rename = "totalStock")]
    pub(super) total_stock: i64,
    #[serde(rename = "soldCount")]
    pub(super) sold_count: i64,
    #[serde(rename = "remainingStock")]
    pub(super) remaining_stock: i64,
    #[serde(rename = "soldOutCount")]
    pub(super) sold_out_count: i64,
    #[serde(rename = "lowStockCount")]
    pub(super) low_stock_count: i64,
    #[serde(rename = "missingProductCount")]
    pub(super) missing_product_count: i64,
    #[serde(rename = "inactiveProductCount")]
    pub(super) inactive_product_count: i64,
    #[serde(rename = "pricingIssueCount")]
    pub(super) pricing_issue_count: i64,
    #[serde(rename = "overlapCount")]
    pub(super) overlap_count: i64,
}

#[derive(Serialize)]
pub(super) struct FlashSaleOverlap {
    #[serde(rename = "productId")]
    pub(super) product_id: String,
    pub(super) detail: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct FlashSaleAdminItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: String,
    #[serde(rename = "startDate")]
    pub(super) start_date: String,
    #[serde(rename = "endDate")]
    pub(super) end_date: String,
    pub(super) products: Vec<FlashSaleProductItem>,
    #[serde(rename = "isActive")]
    pub(super) is_active: bool,
    pub(super) banner: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "statusKey")]
    pub(super) status_key: String,
    #[serde(rename = "statusLabel")]
    pub(super) status_label: String,
    #[serde(rename = "productCount")]
    pub(super) product_count: i64,
    pub(super) summary: FlashSaleSummary,
    #[serde(rename = "overlappingProducts")]
    pub(super) overlapping_products: Vec<FlashSaleOverlap>,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
    #[serde(rename = "deleteBlockedReason")]
    pub(super) delete_blocked_reason: String,
    #[serde(rename = "hasIssues")]
    pub(super) has_issues: bool,
}

pub(super) struct NormalizedSliderPayload {
    pub(super) name: String,
    pub(super) image: String,
    pub(super) link: String,
    pub(super) status: bool,
}
