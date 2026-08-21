//! Private fail-closed Seller Center summary.

use std::sync::Arc;

use axum::{
    extract::State,
    http::HeaderMap,
    response::IntoResponse,
    response::Response,
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, DateTime, Document};

use crate::{
    routes::irs_seller,
    security::require_proxy_context,
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::{
    SellerCenterDigiflazz, SellerCenterDigiflazzOrders, SellerCenterIrs, SellerCenterIssue,
    SellerCenterMappings, SellerCenterOrderCounts, SellerCenterSummaryResponse,
};

const SELLER_CONFIG_KEY: &str = "digiflazzSellerConfig";

fn digiflazz_center_status(configured: bool, active_mappings: i64, present: bool) -> &'static str {
    if !present {
        "unavailable"
    } else if !configured {
        "needs_setup"
    } else if active_mappings <= 0 {
        "attention"
    } else {
        "ready"
    }
}

fn irs_center_status(enabled: bool, configured: bool, active_mappings: i64, present: bool) -> &'static str {
    if !present {
        "unavailable"
    } else if !enabled {
        "disabled"
    } else if !configured {
        "needs_setup"
    } else if active_mappings <= 0 {
        "attention"
    } else {
        "ready"
    }
}

/// Corrected pending callback count: only required, undelivered callbacks.
fn center_callback_pending_expression() -> Document {
    doc! { "$and": [
        { "$eq": ["$callbackRequired", true] },
        { "$eq": [ { "$ifNull": ["$callbackDeliveredAt", Bson::Null] }, Bson::Null ] }
    ] }
}

async fn digiflazz_order_counts(
    db: &mongodb::Database,
) -> mongodb::error::Result<SellerCenterDigiflazzOrders> {
    let mut cursor = db
        .collection::<Document>("digiflazzsellerorders")
        .aggregate(vec![doc! { "$group": {
            "_id": Bson::Null,
            "total": { "$sum": 1 },
            "pending": { "$sum": { "$cond": [ { "$eq": ["$status", "pending"] }, 1, 0 ] } },
            "failed": { "$sum": { "$cond": [ { "$eq": ["$status", "failed"] }, 1, 0 ] } },
            "callbackPending": { "$sum": { "$cond": [ center_callback_pending_expression(), 1, 0 ] } }
        } }])
        .await?;
    let doc = cursor.try_next().await?;
    Ok(doc
        .map(|doc| SellerCenterDigiflazzOrders {
            total: read_i64(&doc, "total"),
            pending: read_i64(&doc, "pending"),
            failed: read_i64(&doc, "failed"),
            callback_pending: read_i64(&doc, "callbackPending"),
        })
        .unwrap_or_default())
}

async fn irs_order_counts(db: &mongodb::Database) -> mongodb::error::Result<SellerCenterOrderCounts> {
    let mut cursor = db
        .collection::<Document>("irssellerorders")
        .aggregate(vec![doc! { "$group": {
            "_id": Bson::Null,
            "total": { "$sum": 1 },
            "pending": { "$sum": { "$cond": [ { "$eq": ["$status", "pending"] }, 1, 0 ] } },
            "failed": { "$sum": { "$cond": [ { "$eq": ["$status", "failed"] }, 1, 0 ] } }
        } }])
        .await?;
    let doc = cursor.try_next().await?;
    Ok(doc
        .map(|doc| SellerCenterOrderCounts {
            total: read_i64(&doc, "total"),
            pending: read_i64(&doc, "pending"),
            failed: read_i64(&doc, "failed"),
        })
        .unwrap_or_default())
}

async fn mapping_counts(db: &mongodb::Database) -> mongodb::error::Result<SellerCenterMappings> {
    let collection = db.collection::<Document>("digiflazzsellerproductmaps");
    let total = collection.count_documents(doc! {}).await? as i64;
    let active = collection
        .count_documents(doc! { "isActive": true })
        .await? as i64;
    Ok(SellerCenterMappings { total, active })
}

async fn digiflazz_config(db: &mongodb::Database) -> mongodb::error::Result<Option<Document>> {
    let document = db
        .collection::<Document>("settings")
        .find_one(doc! { "key": SELLER_CONFIG_KEY })
        .await?;
    Ok(document.and_then(|document| document.get_document("value").ok().cloned()))
}

pub async fn center_summary(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        let response = SellerCenterSummaryResponse {
            ok: false,
            partial: false,
            issues: vec![SellerCenterIssue::new(
                "SELLER_CONFIG_UNAVAILABLE",
                "mongodb.settings.digiflazzSeller",
            )],
            generated_at: rfc3339_now(),
            digiflazz: SellerCenterDigiflazz {
                configured: false,
                ready: false,
                status: "unavailable".to_string(),
                orders: SellerCenterDigiflazzOrders::default(),
            },
            irs: SellerCenterIrs {
                enabled: false,
                configured: false,
                ready: false,
                status: "unavailable".to_string(),
                orders: SellerCenterOrderCounts::default(),
            },
            mappings: SellerCenterMappings::default(),
        };
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(response)).into_response();
    };
    let db = client.database(&state.mongo_db);
    let mut issues: Vec<SellerCenterIssue> = Vec::new();

    let seller_config = digiflazz_config(&db).await.map_err(|_| {
        issues.push(SellerCenterIssue::new(
            "SELLER_CONFIG_UNAVAILABLE",
            "mongodb.settings.digiflazzSeller",
        ));
    });
    let irs_config = irs_seller::stored_config(&db).await.map_err(|_| {
        issues.push(SellerCenterIssue::new(
            "IRS_CONFIG_UNAVAILABLE",
            "mongodb.settings.irsSeller",
        ));
    });
    let mappings = mapping_counts(&db).await.map_err(|_| {
        issues.push(SellerCenterIssue::new(
            "SELLER_MAPPING_SUMMARY_UNAVAILABLE",
            "mongodb.digiflazzSellerMappings",
        ));
    });
    let digiflazz_orders = digiflazz_order_counts(&db).await.map_err(|_| {
        issues.push(SellerCenterIssue::new(
            "SELLER_ORDER_SUMMARY_UNAVAILABLE",
            "mongodb.digiflazzSellerOrders",
        ));
    });
    let irs_orders = irs_order_counts(&db).await.map_err(|_| {
        issues.push(SellerCenterIssue::new(
            "IRS_ORDER_SUMMARY_UNAVAILABLE",
            "mongodb.irsSellerOrders",
        ));
    });
    issues.dedup_by(|left, right| left.code == right.code && left.source == right.source);

    let mappings_present = mappings.is_ok();
    let mappings = mappings.unwrap_or_default();
    let active_mappings = if mappings_present {
        mappings.active
    } else {
        -1
    };

    let (digiflazz_config_present, seller_configured) = match &seller_config {
        Ok(config) => (
            true,
            config
                .as_ref()
                .map(|config| {
                    !read_string(config, "username").is_empty()
                        && !read_string(config, "apiKey").is_empty()
                })
                .unwrap_or(false),
        ),
        Err(_) => (false, false),
    };
    let digiflazz_status = digiflazz_center_status(
        seller_configured,
        active_mappings,
        digiflazz_config_present && mappings_present,
    );

    let (irs_present, irs_enabled, irs_configured) = match &irs_config {
        Ok(config) => {
            let config = config.as_ref();
            (
                true,
                config.map(|config| config.get_bool("enabled").unwrap_or(false)).unwrap_or(false),
                config
                    .map(|config| {
                        !read_string(config, "merchantId").is_empty()
                            && !read_string(config, "password").is_empty()
                            && !read_string(config, "pin").is_empty()
                            && !read_string(config, "secret").is_empty()
                    })
                    .unwrap_or(false),
            )
        }
        Err(_) => (false, false, false),
    };
    let irs_status = irs_center_status(
        irs_enabled,
        irs_configured,
        active_mappings,
        irs_present && mappings_present,
    );

    let digiflazz_orders_present = digiflazz_orders.is_ok();
    let irs_orders_present = irs_orders.is_ok();
    let digiflazz_status = if digiflazz_orders_present {
        digiflazz_status
    } else {
        "unavailable"
    };
    let irs_status = if irs_orders_present { irs_status } else { "unavailable" };

    let body = SellerCenterSummaryResponse {
        ok: true,
        partial: !issues.is_empty(),
        issues,
        generated_at: rfc3339_now(),
        digiflazz: SellerCenterDigiflazz {
            configured: seller_configured,
            ready: digiflazz_status == "ready",
            status: digiflazz_status.to_string(),
            orders: digiflazz_orders.unwrap_or_default(),
        },
        irs: SellerCenterIrs {
            enabled: irs_enabled,
            configured: irs_configured,
            ready: irs_status == "ready",
            status: irs_status.to_string(),
            orders: irs_orders.unwrap_or_default(),
        },
        mappings,
    };
    Json(body).into_response()
}

fn rfc3339_now() -> String {
    DateTime::now()
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| String::new())
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
        let issue = SellerCenterIssue::new("IRS_ORDER_SUMMARY_UNAVAILABLE", "mongodb.irsSellerOrders");
        assert_eq!(
            serde_json::to_value(issue).unwrap(),
            serde_json::json!({
                "code": "IRS_ORDER_SUMMARY_UNAVAILABLE",
                "source": "mongodb.irsSellerOrders"
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
                "mongodb.digiflazzSellerMappings",
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
