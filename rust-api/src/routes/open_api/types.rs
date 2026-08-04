use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub struct ApiKeyResponse {
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    pub secret: Option<String>,
    #[serde(rename = "hasApiKey")]
    pub has_api_key: bool,
    #[serde(rename = "hasSecret")]
    pub has_secret: bool,
}

#[derive(Serialize)]
pub struct GenerateApiKeyResponse {
    pub message: &'static str,
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub secret: String,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub message: &'static str,
}

#[derive(Serialize)]
pub struct ApiProfileResponse {
    pub success: bool,
    pub data: ApiProfileData,
}

#[derive(Serialize)]
pub struct ApiProfileData {
    pub name: String,
    pub email: String,
    pub level: String,
    pub balance: i64,
}

#[derive(Deserialize)]
pub struct ApiProductsQuery {
    pub category: Option<String>,
    pub operator: Option<String>,
    #[serde(rename = "type")]
    pub product_type: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiOperatorsQuery {
    pub category: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiProductTypesQuery {
    pub category: Option<String>,
    pub operator: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiTransactionsQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct ApiCheckTransactionQuery {
    #[serde(alias = "trxId")]
    pub trx_id: Option<String>,
    #[serde(alias = "refId")]
    pub ref_id: Option<String>,
}

#[derive(Serialize)]
pub struct ApiDataResponse<T> {
    pub success: bool,
    pub data: T,
}

#[derive(Serialize)]
pub struct ApiCategoryItem {
    pub id: String,
    pub name: String,
    pub slug: String,
}

#[derive(Serialize)]
pub struct ApiOperatorItem {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub category: String,
}

#[derive(Serialize)]
pub struct ApiProductTypeItem {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub category: String,
    pub operator: String,
}

#[derive(Serialize)]
pub struct ApiProductItem {
    pub code: String,
    pub name: String,
    pub category: String,
    pub operator: String,
    #[serde(rename = "type")]
    pub product_type: String,
    #[serde(rename = "productCode")]
    pub product_code_alias: String,
    #[serde(rename = "productName")]
    pub product_name_alias: String,
    #[serde(rename = "categoryName")]
    pub category_name: String,
    #[serde(rename = "operatorName")]
    pub operator_name: String,
    #[serde(rename = "jenisName")]
    pub jenis_name: String,
    pub price: i64,
    pub status: &'static str,
}

#[derive(Deserialize)]
pub struct ApiCreateTransactionPayload {
    #[serde(alias = "produk", alias = "productCode")]
    pub product_code: Option<String>,
    #[serde(alias = "tujuan")]
    pub target: Option<String>,
    #[serde(alias = "serverId")]
    pub server_id: Option<String>,
    #[serde(alias = "refId")]
    pub ref_id: Option<String>,
}

#[derive(Serialize)]
pub struct ApiCreateTransactionResponse {
    pub success: bool,
    pub message: &'static str,
    pub data: ApiCreateTransactionData,
}

#[derive(Serialize)]
pub struct ApiCreateTransactionData {
    pub trx_id: Value,
    pub ref_id: Option<String>,
    pub product_code: String,
    pub product_name: String,
    pub target: String,
    pub price: i64,
    pub status: String,
    pub sn: Option<String>,
    pub balance: i64,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ApiTransactionItem {
    pub trx_id: Value,
    pub ref_id: Option<String>,
    pub product_code: Option<String>,
    pub product_name: Option<String>,
    pub target: String,
    pub price: i64,
    pub status: String,
    pub sn: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ApiTransactionDetail {
    pub trx_id: Value,
    pub ref_id: Option<String>,
    pub product_code: Option<String>,
    pub product_name: Option<String>,
    pub target: String,
    pub price: i64,
    pub status: String,
    pub sn: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct ApiTransactionsPagination {
    pub page: i64,
    pub limit: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Serialize)]
pub struct ApiTransactionsResponse {
    pub success: bool,
    pub data: Vec<ApiTransactionItem>,
    pub pagination: ApiTransactionsPagination,
}

#[derive(Serialize)]
pub struct ApiErrorResponse {
    pub success: bool,
    pub message: &'static str,
}
