//! Private fail-closed Seller Center summary.

use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, response::IntoResponse, response::Response, Json};
use serde_json::Value;
use sqlx::Row;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    SellerCenterDigiflazz, SellerCenterDigiflazzOrders, SellerCenterIrs, SellerCenterIssue,
    SellerCenterMappings, SellerCenterOrderCounts, SellerCenterSummaryResponse,
};

fn digiflazz_center_status(configured: bool, active_mappings: i64, present: bool) -> &'static str {
    if !present { "unavailable" } else if !configured { "needs_setup" } else if active_mappings <= 0 { "attention" } else { "ready" }
}
fn irs_center_status(enabled: bool, configured: bool, active_mappings: i64, present: bool) -> &'static str {
    if !present { "unavailable" } else if !enabled { "disabled" } else if !configured { "needs_setup" } else if active_mappings <= 0 { "attention" } else { "ready" }
}
fn config_string(config: &Value, key: &str) -> String { config.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string() }

pub async fn center_summary(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) { return response; }
    let mut issues = Vec::new();
    let digiflazz_config = crate::services::seller_sql::stored_settings(&state.pg_pool,"digiflazz").await;
    if digiflazz_config.is_err() { issues.push(SellerCenterIssue::new("SELLER_CONFIG_UNAVAILABLE","sql.seller_settings.digiflazz")); }
    let irs_config = crate::services::seller_sql::stored_settings(&state.pg_pool,"irs").await;
    if irs_config.is_err() { issues.push(SellerCenterIssue::new("IRS_CONFIG_UNAVAILABLE","sql.seller_settings.irs")); }
    let mappings = sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE enabled)::bigint AS active FROM seller_mappings WHERE channel='digiflazz'").fetch_one(&state.pg_pool).await;
    if mappings.is_err() { issues.push(SellerCenterIssue::new("SELLER_MAPPING_SUMMARY_UNAVAILABLE","sql.seller_mappings.digiflazz")); }
    let digiflazz_orders = sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE o.status='pending')::bigint AS pending,count(*) FILTER(WHERE o.status='failed')::bigint AS failed,count(*) FILTER(WHERE c.delivered_at IS NULL AND c.ref_id IS NOT NULL)::bigint AS callback_pending FROM seller_orders o LEFT JOIN seller_callbacks c ON c.channel=o.channel AND c.ref_id=o.reference_id WHERE o.channel='digiflazz'").fetch_one(&state.pg_pool).await;
    if digiflazz_orders.is_err() { issues.push(SellerCenterIssue::new("SELLER_ORDER_SUMMARY_UNAVAILABLE","sql.seller_orders.digiflazz")); }
    let irs_orders = sqlx::query("SELECT count(*)::bigint AS total,count(*) FILTER(WHERE status='pending')::bigint AS pending,count(*) FILTER(WHERE status='failed')::bigint AS failed FROM seller_orders WHERE channel='irs'").fetch_one(&state.pg_pool).await;
    if irs_orders.is_err() { issues.push(SellerCenterIssue::new("IRS_ORDER_SUMMARY_UNAVAILABLE","sql.seller_orders.irs")); }
    let mappings_present = mappings.is_ok();
    let (mapping_total,mapping_active) = mappings.map(|r|(r.get::<i64,_>("total"),r.get::<i64,_>("active"))).unwrap_or_default();
    let mappings = SellerCenterMappings { total:mapping_total,active:mapping_active };
    let digiflazz_config = digiflazz_config.unwrap_or_else(|_|serde_json::json!({}));
    let seller_configured = !config_string(&digiflazz_config,"username").is_empty() && !config_string(&digiflazz_config,"apiKey").is_empty();
    let mut digiflazz_status = digiflazz_center_status(seller_configured,if mappings_present {mapping_active} else {-1},digiflazz_config != serde_json::json!({}) || !issues.iter().any(|i|i.code=="SELLER_CONFIG_UNAVAILABLE") && mappings_present);
    let irs_config = irs_config.unwrap_or_else(|_|serde_json::json!({}));
    let irs_enabled = irs_config.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let irs_configured = ["merchantId","password","pin","secret"].iter().all(|key|!config_string(&irs_config,key).is_empty());
    let mut irs_status = irs_center_status(irs_enabled,irs_configured,if mappings_present {mapping_active} else {-1},!issues.iter().any(|i|i.code=="IRS_CONFIG_UNAVAILABLE") && mappings_present);
    let digiflazz_orders = digiflazz_orders.map(|row|SellerCenterDigiflazzOrders {total:row.get("total"),pending:row.get("pending"),failed:row.get("failed"),callback_pending:row.get("callback_pending")});
    if digiflazz_orders.is_err() { digiflazz_status="unavailable"; }
    let irs_orders = irs_orders.map(|row|SellerCenterOrderCounts {total:row.get("total"),pending:row.get("pending"),failed:row.get("failed")});
    if irs_orders.is_err() { irs_status="unavailable"; }
    let body = SellerCenterSummaryResponse {
        ok:true, partial:!issues.is_empty(), issues, generated_at:chrono::Utc::now().to_rfc3339(),
        digiflazz:SellerCenterDigiflazz {configured:seller_configured,ready:digiflazz_status=="ready",status:digiflazz_status.to_string(),orders:digiflazz_orders.unwrap_or_default()},
        irs:SellerCenterIrs {enabled:irs_enabled,configured:irs_configured,ready:irs_status=="ready",status:irs_status.to_string(),orders:irs_orders.unwrap_or_default()}, mappings,
    };
    Json(body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_irs_is_neutral_while_failed_sources_are_unavailable() {
        assert_eq!(irs_center_status(false, true, 4, true), "disabled");
        assert_eq!(irs_center_status(true, true, 4, true), "ready");
        assert_eq!(irs_center_status(true, false, 4, true), "needs_setup");
        assert_eq!(irs_center_status(true, true, 0, true), "attention");
        assert_eq!(irs_center_status(true, true, 4, false), "unavailable");
    }

    #[test]
    fn digiflazz_status_has_no_disabled_state() {
        assert_eq!(digiflazz_center_status(true, 4, true), "ready");
        assert_eq!(digiflazz_center_status(false, 4, true), "needs_setup");
        assert_eq!(digiflazz_center_status(true, 0, true), "attention");
        assert_eq!(digiflazz_center_status(true, 4, false), "unavailable");
    }

    #[test]
    fn summary_issue_codes_are_stable_and_non_secret() {
        let issue = SellerCenterIssue::new("IRS_ORDER_SUMMARY_UNAVAILABLE", "postgres.irs_seller_orders");
        assert_eq!(
            serde_json::to_value(issue).unwrap(),
            serde_json::json!({
                "code": "IRS_ORDER_SUMMARY_UNAVAILABLE",
                "source": "postgres.irs_seller_orders"
            })
        );
    }

    #[test]
    fn summary_response_serializes_counts_only() {
        let response = SellerCenterSummaryResponse {
            ok: true,
            partial: true,
            issues: vec![SellerCenterIssue::new(
                "SELLER_MAPPING_SUMMARY_UNAVAILABLE",
                "postgres.digiflazz_seller_mappings",
            )],
            generated_at: "2026-08-20T00:00:00.000Z".to_string(),
            digiflazz: SellerCenterDigiflazz {
                configured: true,
                ready: true,
                status: "ready".to_string(),
                orders: SellerCenterDigiflazzOrders {
                    total: 3,
                    pending: 1,
                    failed: 0,
                    callback_pending: 2,
                },
            },
            irs: SellerCenterIrs {
                enabled: false,
                configured: false,
                ready: false,
                status: "disabled".to_string(),
                orders: SellerCenterOrderCounts {
                    total: 0,
                    pending: 0,
                    failed: 0,
                },
            },
            mappings: SellerCenterMappings { total: 1, active: 1 },
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["partial"], true);
        assert_eq!(json["digiflazz"]["status"], "ready");
        assert_eq!(json["irs"]["status"], "disabled");
        assert_eq!(json["digiflazz"]["orders"]["callbackPending"], 2);
        assert_eq!(json["generatedAt"], "2026-08-20T00:00:00.000Z");
        for key in [
            "username",
            "merchantId",
            "apiKeyConfigured",
            "passwordConfigured",
            "requestIp",
            "message",
            "sn",
            "raw",
        ] {
            assert!(
                json.to_string().contains(&format!("\"{key}\"")) == false,
                "summary must not contain {key}"
            );
        }
    }
}
