use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Deserialize)]
pub struct FlashSalePayload {
    pub(super) name: Option<Value>,
    pub(super) description: Option<Value>,
    #[serde(rename = "startDate")]
    pub(super) start_date: Option<Value>,
    #[serde(rename = "endDate")]
    pub(super) end_date: Option<Value>,
    pub(super) products: Option<Vec<FlashSaleProductPayload>>,
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

#[derive(Serialize)]
pub struct FlashSaleResponse {
    pub(super) message: &'static str,
    #[serde(rename = "flashSale")]
    pub(super) flash_sale: Value,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub(super) message: &'static str,
}









