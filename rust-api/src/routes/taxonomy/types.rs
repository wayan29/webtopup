use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct CategoryItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: i64,
    pub(super) name: String,
    pub(super) slug: String,
    pub(super) icon: String,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    #[serde(rename = "directProductCount")]
    pub(super) direct_product_count: i64,
    #[serde(rename = "legacyProductCount")]
    pub(super) legacy_product_count: i64,
    #[serde(rename = "productCount")]
    pub(super) product_count: i64,
    #[serde(rename = "operatorCount")]
    pub(super) operator_count: i64,
    #[serde(rename = "productTypeCount")]
    pub(super) product_type_count: i64,
    #[serde(rename = "dependencyCount")]
    pub(super) dependency_count: i64,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
}

#[derive(Deserialize)]
pub struct SortOrderPayload {
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<String>,
    pub(super) orders: Option<Vec<SortOrderItem>>,
}

#[derive(Deserialize)]
pub struct UpdateCategoryPayload {
    pub(super) name: Option<String>,
    pub(super) icon: Option<String>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
    pub(super) status: Option<bool>,
}

#[derive(Deserialize)]
pub struct CreateCategoryPayload {
    pub(super) name: Option<String>,
    pub(super) icon: Option<String>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
    pub(super) status: Option<bool>,
}

#[derive(Serialize)]
pub(super) struct CreateCategoryResponse {
    pub(super) message: &'static str,
    pub(super) category: Value,
}

pub(super) struct CategoryDependencyCounts {
    pub(super) direct_product_count: i64,
    pub(super) legacy_product_count: i64,
    pub(super) product_count: i64,
    pub(super) operator_count: i64,
    pub(super) product_type_count: i64,
    pub(super) dependency_count: i64,
}

pub(super) struct OperatorDependencyCounts {
    pub(super) direct_product_count: i64,
    pub(super) legacy_product_count: i64,
    pub(super) product_count: i64,
    pub(super) product_type_count: i64,
    pub(super) dependency_count: i64,
}

#[derive(Deserialize)]
pub(super) struct SortOrderItem {
    pub(super) id: String,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
}

#[derive(Deserialize)]
pub struct UpdateOperatorPayload {
    pub(super) name: Option<String>,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    pub(super) icon: Option<String>,
    #[serde(rename = "instructionImage")]
    pub(super) instruction_image: Option<String>,
    #[serde(rename = "checkUsername")]
    pub(super) check_username: Option<bool>,
    #[serde(rename = "usernameLabel")]
    pub(super) username_label: Option<String>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
    pub(super) status: Option<bool>,
    #[serde(rename = "validationType")]
    pub(super) validation_type: Option<String>,
    pub(super) description: Option<String>,
    #[serde(rename = "isCustomProduct")]
    pub(super) is_custom_product: Option<bool>,
    #[serde(rename = "userIdLabel")]
    pub(super) user_id_label: Option<String>,
    #[serde(rename = "userIdType")]
    pub(super) user_id_type: Option<String>,
    #[serde(rename = "hasServerId")]
    pub(super) has_server_id: Option<bool>,
    #[serde(rename = "serverIdLabel")]
    pub(super) server_id_label: Option<String>,
    #[serde(rename = "serverIdDropdown")]
    pub(super) server_id_dropdown: Option<bool>,
    #[serde(rename = "serverIdType")]
    pub(super) server_id_type: Option<String>,
    #[serde(rename = "serverOptions")]
    pub(super) server_options: Option<Value>,
}

#[derive(Deserialize)]
pub struct UpdateProductTypePayload {
    pub(super) name: Option<String>,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<String>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<String>,
    pub(super) icon: Option<String>,
    pub(super) cover: Option<String>,
    #[serde(rename = "openTime")]
    pub(super) open_time: Option<String>,
    #[serde(rename = "closeTime")]
    pub(super) close_time: Option<String>,
    #[serde(rename = "open24Hours")]
    pub(super) open_24_hours: Option<bool>,
    #[serde(rename = "estimatedDelivery")]
    pub(super) estimated_delivery: Option<String>,
    #[serde(rename = "processType")]
    pub(super) process_type: Option<String>,
    pub(super) description: Option<String>,
    #[serde(rename = "popupInfo")]
    pub(super) popup_info: Option<Value>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: Option<f64>,
    pub(super) status: Option<bool>,
}

#[derive(Serialize)]
pub(super) struct MessageResponse {
    pub(super) message: &'static str,
}

#[derive(Serialize)]
pub(super) struct UpdateCategoryResponse {
    pub(super) message: &'static str,
    pub(super) category: Value,
}

#[derive(Serialize)]
pub(super) struct UpdateOperatorResponse {
    pub(super) message: &'static str,
    pub(super) operator: Value,
}

#[derive(Serialize)]
pub(super) struct CreateOperatorResponse {
    pub(super) message: &'static str,
    pub(super) operator: Value,
}

#[derive(Serialize)]
pub(super) struct UpdateProductTypeResponse {
    pub(super) message: &'static str,
    #[serde(rename = "productType")]
    pub(super) product_type: Value,
}

#[derive(Serialize)]
pub(super) struct CreateProductTypeResponse {
    pub(super) message: &'static str,
    #[serde(rename = "productType")]
    pub(super) product_type: Value,
}

#[derive(Serialize)]
pub(super) struct OperatorItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: i64,
    pub(super) name: String,
    pub(super) slug: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<CategoryBrief>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) icon: Option<String>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "isCustomProduct")]
    pub(super) is_custom_product: bool,
    #[serde(rename = "directProductCount")]
    pub(super) direct_product_count: i64,
    #[serde(rename = "legacyProductCount")]
    pub(super) legacy_product_count: i64,
    #[serde(rename = "productCount")]
    pub(super) product_count: i64,
    #[serde(rename = "productTypeCount")]
    pub(super) product_type_count: i64,
    #[serde(rename = "dependencyCount")]
    pub(super) dependency_count: i64,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
}

#[derive(Serialize)]
pub(super) struct ProductTypeItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "typeId")]
    pub(super) type_id: i64,
    pub(super) name: String,
    pub(super) slug: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<CategoryBrief>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<OperatorBrief>,
    pub(super) icon: String,
    pub(super) cover: String,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "productCount")]
    pub(super) product_count: i64,
    #[serde(rename = "dependencyCount")]
    pub(super) dependency_count: i64,
    #[serde(rename = "canDelete")]
    pub(super) can_delete: bool,
}

#[derive(Serialize)]
pub(super) struct OperatorDetail {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: i64,
    pub(super) name: String,
    pub(super) slug: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<CategoryBrief>,
    pub(super) icon: String,
    #[serde(rename = "instructionImage")]
    pub(super) instruction_image: String,
    #[serde(rename = "checkUsername")]
    pub(super) check_username: bool,
    #[serde(rename = "usernameLabel")]
    pub(super) username_label: String,
    #[serde(rename = "validationType")]
    pub(super) validation_type: String,
    pub(super) description: String,
    #[serde(rename = "isCustomProduct")]
    pub(super) is_custom_product: bool,
    #[serde(rename = "userIdLabel")]
    pub(super) user_id_label: String,
    #[serde(rename = "userIdType")]
    pub(super) user_id_type: String,
    #[serde(rename = "hasServerId")]
    pub(super) has_server_id: bool,
    #[serde(rename = "serverIdLabel")]
    pub(super) server_id_label: String,
    #[serde(rename = "serverIdDropdown")]
    pub(super) server_id_dropdown: bool,
    #[serde(rename = "serverIdType")]
    pub(super) server_id_type: String,
    #[serde(rename = "serverOptions")]
    pub(super) server_options: Vec<ServerOption>,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct ServerOption {
    pub(super) label: String,
    pub(super) value: String,
}

#[derive(Serialize)]
pub(super) struct ProductTypeDetail {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(rename = "typeId")]
    pub(super) type_id: i64,
    pub(super) name: String,
    pub(super) slug: String,
    #[serde(rename = "categoryId")]
    pub(super) category_id: Option<CategoryBrief>,
    #[serde(rename = "operatorId")]
    pub(super) operator_id: Option<OperatorBrief>,
    pub(super) icon: String,
    pub(super) cover: String,
    #[serde(rename = "openTime")]
    pub(super) open_time: String,
    #[serde(rename = "closeTime")]
    pub(super) close_time: String,
    #[serde(rename = "open24Hours")]
    pub(super) open_24_hours: bool,
    #[serde(rename = "estimatedDelivery")]
    pub(super) estimated_delivery: String,
    #[serde(rename = "processType")]
    pub(super) process_type: String,
    pub(super) description: String,
    #[serde(rename = "popupInfo")]
    pub(super) popup_info: PopupInfo,
    #[serde(rename = "sortOrder")]
    pub(super) sort_order: i64,
    pub(super) status: bool,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Serialize)]
pub(super) struct PopupInfo {
    pub(super) title: String,
    pub(super) content: String,
    pub(super) image: String,
    #[serde(rename = "buttonText")]
    pub(super) button_text: String,
    #[serde(rename = "buttonLink")]
    pub(super) button_link: String,
    pub(super) enabled: bool,
}

#[derive(Serialize, Clone)]
pub(super) struct CategoryBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) icon: String,
    pub(super) slug: String,
    pub(super) status: bool,
}

#[derive(Serialize, Clone)]
pub(super) struct OperatorBrief {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) icon: String,
    pub(super) slug: String,
    pub(super) status: bool,
}
