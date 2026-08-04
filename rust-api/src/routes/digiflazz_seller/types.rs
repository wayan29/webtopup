use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone)]
pub(super) struct SellerConfig {
    pub(super) username: String,
    pub(super) api_key: String,
    pub(super) public_base_url: String,
    pub(super) digiflazz_callback_url: String,
    pub(super) server_ip: String,
    pub(super) reported_balance: i64,
    pub(super) seller_margin_flat: i64,
    pub(super) allowed_ips: Vec<String>,
    pub(super) callback_enabled: bool,
    pub(super) prepaid_endpoint_path: String,
    pub(super) prepaid_endpoint_url: String,
}

#[derive(Serialize)]
pub(super) struct SellerSettingsResponse {
    pub(super) configured: bool,
    pub(super) ready: bool,
    pub(super) username: String,
    #[serde(rename = "apiKeyMasked")]
    pub(super) api_key_masked: String,
    #[serde(rename = "publicBaseUrl")]
    pub(super) public_base_url: String,
    #[serde(rename = "digiflazzCallbackUrl")]
    pub(super) digiflazz_callback_url: String,
    #[serde(rename = "serverIp")]
    pub(super) server_ip: String,
    #[serde(rename = "reportedBalance")]
    pub(super) reported_balance: i64,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: i64,
    #[serde(rename = "allowedIps")]
    pub(super) allowed_ips: Vec<String>,
    #[serde(rename = "callbackEnabled")]
    pub(super) callback_enabled: bool,
    #[serde(rename = "prepaidEndpointPath")]
    pub(super) prepaid_endpoint_path: String,
    #[serde(rename = "prepaidEndpointUrl")]
    pub(super) prepaid_endpoint_url: String,
    #[serde(rename = "mappingSummary")]
    pub(super) mapping_summary: MappingSummary,
    #[serde(rename = "orderSummary")]
    pub(super) order_summary: OrderSummary,
    #[serde(rename = "retryQueueHealth")]
    pub(super) retry_queue_health: RetryQueueHealth,
}

#[derive(Deserialize)]
pub struct SaveSettingsPayload {
    pub(super) username: Option<Value>,
    #[serde(rename = "apiKey")]
    pub(super) api_key: Option<Value>,
    #[serde(rename = "publicBaseUrl")]
    pub(super) public_base_url: Option<Value>,
    #[serde(rename = "digiflazzCallbackUrl")]
    pub(super) digiflazz_callback_url: Option<Value>,
    #[serde(rename = "serverIp")]
    pub(super) server_ip: Option<Value>,
    #[serde(rename = "reportedBalance")]
    pub(super) reported_balance: Option<Value>,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: Option<Value>,
    #[serde(rename = "allowedIps")]
    pub(super) allowed_ips: Option<Value>,
    #[serde(rename = "callbackEnabled")]
    pub(super) callback_enabled: Option<Value>,
}

#[derive(Serialize)]
pub(super) struct SaveSettingsResponse {
    pub(super) success: bool,
    pub(super) message: &'static str,
    pub(super) configured: bool,
    pub(super) username: String,
    #[serde(rename = "apiKeyMasked")]
    pub(super) api_key_masked: String,
    #[serde(rename = "publicBaseUrl")]
    pub(super) public_base_url: String,
    #[serde(rename = "digiflazzCallbackUrl")]
    pub(super) digiflazz_callback_url: String,
    #[serde(rename = "serverIp")]
    pub(super) server_ip: String,
    #[serde(rename = "reportedBalance")]
    pub(super) reported_balance: i64,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: i64,
    #[serde(rename = "allowedIps")]
    pub(super) allowed_ips: Vec<String>,
    #[serde(rename = "callbackEnabled")]
    pub(super) callback_enabled: bool,
    #[serde(rename = "prepaidEndpointUrl")]
    pub(super) prepaid_endpoint_url: String,
}

#[derive(Serialize)]
pub(super) struct MappingSummary {
    pub(super) total: i64,
    pub(super) active: i64,
}

#[derive(Default, Serialize)]
pub(super) struct OrderSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    #[serde(rename = "callbackPending")]
    pub(super) callback_pending: i64,
    #[serde(rename = "callbackDueRetry")]
    pub(super) callback_due_retry: i64,
    #[serde(rename = "callbackHighAttempt")]
    pub(super) callback_high_attempt: i64,
}

#[derive(Serialize)]
pub(super) struct RetryQueueHealth {
    pub(super) status: String,
    pub(super) source: String,
    #[serde(rename = "lastRunAt")]
    pub(super) last_run_at: Option<String>,
    pub(super) processed: i64,
    #[serde(rename = "successCount")]
    pub(super) success_count: i64,
    #[serde(rename = "failedCount")]
    pub(super) failed_count: i64,
    #[serde(rename = "remainingDue")]
    pub(super) remaining_due: i64,
    #[serde(rename = "lastError")]
    pub(super) last_error: String,
}

#[derive(Default, Deserialize)]
pub struct MappingQuery {
    pub(super) search: Option<String>,
    pub(super) page: Option<i64>,
    pub(super) limit: Option<i64>,
    pub(super) mapped: Option<String>,
}

#[derive(Serialize)]
pub(super) struct MappingListResponse {
    pub(super) items: Vec<MappingProductItem>,
    pub(super) meta: MappingListMeta,
    pub(super) summary: MappingListSummary,
}

#[derive(Serialize)]
pub(super) struct MappingListMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Serialize)]
pub(super) struct MappingListSummary {
    #[serde(rename = "totalProducts")]
    pub(super) total_products: i64,
    #[serde(rename = "mappedProducts")]
    pub(super) mapped_products: i64,
    #[serde(rename = "activeMappings")]
    pub(super) active_mappings: i64,
}

#[derive(Clone, Serialize)]
pub(super) struct MappingProductItem {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) brand: String,
    pub(super) category: String,
    pub(super) status: bool,
    pub(super) vendor: String,
    pub(super) price: i64,
    #[serde(rename = "costPrice")]
    pub(super) cost_price: i64,
    #[serde(rename = "recommendedPrice")]
    pub(super) recommended_price: i64,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    pub(super) mapping: Option<MappingItem>,
}

#[derive(Clone, Serialize)]
pub(super) struct MappingItem {
    pub(super) id: String,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: String,
    pub(super) price: i64,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: Option<i64>,
    #[serde(rename = "effectiveMarginFlat")]
    pub(super) effective_margin_flat: i64,
    #[serde(rename = "isActive")]
    pub(super) is_active: bool,
    #[serde(rename = "lastSyncStatus")]
    pub(super) last_sync_status: String,
    #[serde(rename = "lastSyncRc")]
    pub(super) last_sync_rc: String,
    #[serde(rename = "lastSyncMessage")]
    pub(super) last_sync_message: String,
    #[serde(rename = "lastSyncAt")]
    pub(super) last_sync_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
}

#[derive(Deserialize)]
pub struct SaveMappingPayload {
    #[serde(rename = "productId")]
    pub(super) product_id: Option<Value>,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: Option<Value>,
    pub(super) price: Option<Value>,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: Option<Value>,
    #[serde(rename = "isActive")]
    pub(super) is_active: Option<Value>,
    #[serde(rename = "syncNow")]
    pub(super) _sync_now: Option<Value>,
}

#[derive(Serialize)]
pub(super) struct SaveMappingResponse {
    pub(super) success: bool,
    pub(super) message: &'static str,
    pub(super) mapping: SavedMappingItem,
    #[serde(rename = "syncResult")]
    pub(super) sync_result: Option<Value>,
}

#[derive(Serialize)]
pub(super) struct SavedMappingItem {
    pub(super) id: String,
    #[serde(rename = "productId")]
    pub(super) product_id: String,
    #[serde(rename = "productName")]
    pub(super) product_name: String,
    #[serde(rename = "productCode")]
    pub(super) product_code: String,
    #[serde(rename = "costPrice")]
    pub(super) cost_price: i64,
    #[serde(rename = "recommendedPrice")]
    pub(super) recommended_price: i64,
    #[serde(rename = "sellerMarginFlat")]
    pub(super) seller_margin_flat: Option<i64>,
    #[serde(rename = "effectiveMarginFlat")]
    pub(super) effective_margin_flat: i64,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: String,
    pub(super) price: i64,
    #[serde(rename = "isActive")]
    pub(super) is_active: bool,
    #[serde(rename = "lastSyncStatus")]
    pub(super) last_sync_status: String,
    #[serde(rename = "lastSyncRc")]
    pub(super) last_sync_rc: String,
    #[serde(rename = "lastSyncMessage")]
    pub(super) last_sync_message: String,
    #[serde(rename = "lastSyncAt")]
    pub(super) last_sync_at: Option<String>,
}

#[derive(Serialize)]
pub(super) struct SellerLogItem {
    pub(super) id: String,
    pub(super) timestamp: String,
    pub(super) event: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    pub(super) status: String,
    pub(super) message: String,
    pub(super) delivered: bool,
}

#[derive(Serialize)]
pub(super) struct SellerOrderItem {
    pub(super) id: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    #[serde(rename = "trId")]
    pub(super) tr_id: String,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: String,
    pub(super) target: String,
    pub(super) price: i64,
    pub(super) status: String,
    pub(super) rc: String,
    pub(super) message: String,
    pub(super) sn: String,
    #[serde(rename = "vendorTrxId")]
    pub(super) vendor_trx_id: String,
    #[serde(rename = "callbackRequired")]
    pub(super) callback_required: bool,
    #[serde(rename = "callbackAttemptCount")]
    pub(super) callback_attempt_count: i64,
    #[serde(rename = "callbackDeliveredAt")]
    pub(super) callback_delivered_at: Option<String>,
    #[serde(rename = "callbackLastAttemptAt")]
    pub(super) callback_last_attempt_at: Option<String>,
    #[serde(rename = "callbackNextRetryAt")]
    pub(super) callback_next_retry_at: Option<String>,
    #[serde(rename = "callbackLastStatusCode")]
    pub(super) callback_last_status_code: Option<i64>,
    #[serde(rename = "callbackLastMessage")]
    pub(super) callback_last_message: String,
    #[serde(rename = "requestIp")]
    pub(super) request_ip: String,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    pub(super) product: Option<SellerOrderProduct>,
}

#[derive(Serialize)]
pub(super) struct SellerAdminOrdersResponse {
    pub(super) items: Vec<SellerAdminOrderItem>,
    pub(super) meta: SellerAdminOrdersMeta,
    pub(super) summary: SellerAdminOrdersSummary,
}

#[derive(Serialize)]
pub(super) struct SellerAdminOrdersMeta {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) total: i64,
    #[serde(rename = "totalPages")]
    pub(super) total_pages: i64,
}

#[derive(Default, Serialize)]
pub(super) struct SellerAdminOrdersSummary {
    pub(super) total: i64,
    pub(super) pending: i64,
    pub(super) success: i64,
    pub(super) failed: i64,
    #[serde(rename = "callbackPending")]
    pub(super) callback_pending: i64,
    #[serde(rename = "callbackDueRetry")]
    pub(super) callback_due_retry: i64,
    #[serde(rename = "amountTotal")]
    pub(super) amount_total: i64,
}

#[derive(Serialize)]
pub(super) struct SellerAdminOrderItem {
    pub(super) id: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    #[serde(rename = "trId")]
    pub(super) tr_id: String,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: String,
    pub(super) target: String,
    pub(super) price: i64,
    pub(super) status: String,
    pub(super) rc: String,
    pub(super) message: String,
    pub(super) sn: String,
    #[serde(rename = "vendorName")]
    pub(super) vendor_name: String,
    #[serde(rename = "vendorSku")]
    pub(super) vendor_sku: String,
    #[serde(rename = "vendorTrxId")]
    pub(super) vendor_trx_id: String,
    #[serde(rename = "callbackRequired")]
    pub(super) callback_required: bool,
    #[serde(rename = "callbackAttemptCount")]
    pub(super) callback_attempt_count: i64,
    #[serde(rename = "callbackDeliveredAt")]
    pub(super) callback_delivered_at: Option<String>,
    #[serde(rename = "callbackLastAttemptAt")]
    pub(super) callback_last_attempt_at: Option<String>,
    #[serde(rename = "callbackNextRetryAt")]
    pub(super) callback_next_retry_at: Option<String>,
    #[serde(rename = "callbackLastStatusCode")]
    pub(super) callback_last_status_code: Option<i64>,
    #[serde(rename = "callbackLastMessage")]
    pub(super) callback_last_message: String,
    #[serde(rename = "requestIp")]
    pub(super) request_ip: String,
    #[serde(rename = "rawRequest")]
    pub(super) raw_request: Option<Value>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: String,
    pub(super) product: Option<SellerAdminOrderProduct>,
}

#[derive(Serialize)]
pub(super) struct SellerAdminOrderProduct {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) brand: String,
    pub(super) category: String,
    #[serde(rename = "vendorName")]
    pub(super) vendor_name: String,
    #[serde(rename = "vendorSku")]
    pub(super) vendor_sku: String,
    pub(super) active: bool,
}

#[derive(Clone, Serialize)]
pub(super) struct SellerOrderProduct {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) brand: String,
    pub(super) category: String,
    #[serde(rename = "vendorName")]
    pub(super) vendor_name: String,
    #[serde(rename = "vendorSku")]
    pub(super) vendor_sku: String,
}

#[derive(Default, Deserialize)]
pub struct LimitPayload {
    pub(super) limit: Option<Value>,
}

#[derive(Clone, Serialize)]
pub(super) struct SellerActionResult {
    pub(super) success: bool,
    pub(super) message: String,
}

#[derive(Clone, Serialize)]
pub(super) struct SellerMappingSyncResult {
    pub(super) success: bool,
    pub(super) rc: String,
    pub(super) message: String,
}

#[derive(Serialize)]
pub(super) struct SellerMappingSyncItem {
    pub(super) id: String,
    #[serde(rename = "pulsaCode")]
    pub(super) pulsa_code: String,
    pub(super) success: bool,
    pub(super) rc: String,
    pub(super) message: String,
}

#[derive(Serialize)]
pub(super) struct SellerMappingBulkSyncResponse {
    pub(super) success: bool,
    pub(super) total: usize,
    #[serde(rename = "successCount")]
    pub(super) success_count: usize,
    #[serde(rename = "failedCount")]
    pub(super) failed_count: usize,
    pub(super) results: Vec<SellerMappingSyncItem>,
}

#[derive(Serialize)]
pub(super) struct SellerCallbackRetryItem {
    #[serde(rename = "orderId")]
    pub(super) order_id: String,
    #[serde(rename = "refId")]
    pub(super) ref_id: String,
    pub(super) success: bool,
    pub(super) message: String,
    #[serde(rename = "nextRetryAt")]
    pub(super) next_retry_at: Option<String>,
}

#[derive(Serialize)]
pub(super) struct SellerCallbackRetryResponse {
    pub(super) processed: usize,
    #[serde(rename = "successCount")]
    pub(super) success_count: usize,
    #[serde(rename = "failedCount")]
    pub(super) failed_count: usize,
    pub(super) results: Vec<SellerCallbackRetryItem>,
}

#[derive(Serialize)]
pub(super) struct SellerCallbackDueRetryResponse {
    pub(super) processed: usize,
    #[serde(rename = "successCount")]
    pub(super) success_count: usize,
    #[serde(rename = "failedCount")]
    pub(super) failed_count: usize,
    #[serde(rename = "remainingDue")]
    pub(super) remaining_due: i64,
    pub(super) health: RetryQueueHealth,
    pub(super) results: Vec<SellerCallbackRetryItem>,
}

#[derive(Deserialize)]
pub struct SellerPrepaidPayload {
    pub(super) ref_id: Option<Value>,
    pub(super) pulsa_code: Option<Value>,
    pub(super) hp: Option<Value>,
    pub(super) price: Option<Value>,
    pub(super) sign: Option<Value>,
    pub(super) username: Option<Value>,
    pub(super) commands: Option<Value>,
}

#[derive(Serialize)]
pub(super) struct SchedulerConfigResponse {
    #[serde(rename = "tokenConfigured")]
    pub(super) token_configured: bool,
    #[serde(rename = "endpointPath")]
    pub(super) endpoint_path: &'static str,
    #[serde(rename = "endpointUrl")]
    pub(super) endpoint_url: String,
    #[serde(rename = "tokenHeader")]
    pub(super) token_header: &'static str,
    #[serde(rename = "recommendedIntervalMinutes")]
    pub(super) recommended_interval_minutes: i64,
    #[serde(rename = "maxLimit")]
    pub(super) max_limit: i64,
    #[serde(rename = "exampleLimit")]
    pub(super) example_limit: i64,
}
