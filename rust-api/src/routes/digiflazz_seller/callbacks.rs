use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::Value;

use super::{document_string, seller_config, SellerActionResult, SellerConfig};

const CALLBACK_RETRY_BACKOFF_MINUTES: [i64; 4] = [1, 5, 15, 60];

pub(super) fn callback_pending_expression() -> Document {
    doc! { "$or": [
        { "$eq": ["$callbackRequired", true] },
        { "$and": [
            { "$ne": ["$status", "pending"] },
            { "$eq": [ { "$ifNull": ["$callbackDeliveredAt", Bson::Null] }, Bson::Null ] },
            { "$lte": [ { "$ifNull": ["$callbackAttemptCount", 0] }, 0 ] },
            { "$eq": [ { "$ifNull": ["$callbackLastMessage", ""] }, "" ] }
        ] }
    ] }
}

pub(super) fn callback_pending_query() -> Document {
    doc! { "$or": [
        { "callbackRequired": true },
        { "$and": [
            { "status": { "$ne": "pending" } },
            { "callbackDeliveredAt": Bson::Null },
            { "callbackAttemptCount": { "$lte": 0 } },
            { "callbackLastMessage": { "$in": ["", Bson::Null] } }
        ] }
    ] }
}

pub(super) fn callback_due_retry_query() -> Document {
    let now = DateTime::now();
    doc! { "$and": [
        { "callbackRequired": true },
        { "status": { "$ne": "pending" } },
        { "$or": [
            { "callbackNextRetryAt": Bson::Null },
            { "callbackNextRetryAt": { "$lte": now } }
        ] }
    ] }
}

pub(super) fn callback_due_retry_expression() -> Document {
    let now = DateTime::now();
    doc! { "$and": [
        { "$eq": ["$callbackRequired", true] },
        { "$ne": ["$status", "pending"] },
        { "$or": [
            { "$eq": [ { "$ifNull": ["$callbackNextRetryAt", Bson::Null] }, Bson::Null ] },
            { "$lte": ["$callbackNextRetryAt", now] }
        ] }
    ] }
}

pub(super) async fn send_seller_callback(
    db: &mongodb::Database,
    order: &Document,
) -> SellerActionResult {
    let config = seller_config(db).await;
    let order_id = match order.get_object_id("_id") {
        Ok(id) => id,
        Err(_) => {
            return SellerActionResult {
                success: false,
                message: "Order not found".to_string(),
            }
        }
    };
    let attempt_count = order
        .get_i64("callbackAttemptCount")
        .or_else(|_| order.get_i32("callbackAttemptCount").map(i64::from))
        .unwrap_or(0)
        + 1;
    let now = DateTime::now();
    let payload = seller_callback_payload(order, &config);

    if !config.callback_enabled {
        let message = "Callback dinonaktifkan pada pengaturan Digiflazz Seller".to_string();
        update_callback_failure(db, order_id, attempt_count, now, None, &message).await;
        log_seller_callback(
            db,
            "callback-skipped",
            order,
            "skipped",
            &message,
            false,
        )
        .await;
        return SellerActionResult {
            success: false,
            message,
        };
    }

    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()
        .and_then(|client| {
            if config.digiflazz_callback_url.is_empty() {
                None
            } else {
                Some(client.post(&config.digiflazz_callback_url).json(&payload))
            }
        });

    let Some(request) = response else {
        let message = "Callback URL belum dikonfigurasi".to_string();
        update_callback_failure(db, order_id, attempt_count, now, None, &message).await;
        log_seller_callback(
            db,
            "callback",
            order,
            "failed",
            &message,
            false,
        )
        .await;
        return SellerActionResult {
            success: false,
            message,
        };
    };

    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16() as i64;
            let body = response.json::<Value>().await.unwrap_or_default();
            let message = body
                .get("message")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("HTTP {status}"));
            let _ = db
                .collection::<Document>("digiflazzsellerorders")
                .update_one(
                    doc! { "_id": order_id },
                    doc! { "$set": {
                        "callbackRequired": false,
                        "callbackDeliveredAt": now,
                        "callbackAttemptCount": attempt_count,
                        "callbackLastAttemptAt": now,
                        "callbackLastStatusCode": status,
                        "callbackLastMessage": &message,
                        "updatedAt": now,
                    }, "$unset": { "callbackNextRetryAt": "" } },
                )
                .await;
            log_seller_callback(
                db,
                "callback",
                order,
                "delivered",
                &message,
                true,
            )
            .await;
            SellerActionResult {
                success: true,
                message,
            }
        }
        Err(error) => {
            let message = error.to_string();
            update_callback_failure(db, order_id, attempt_count, now, None, &message).await;
            log_seller_callback(
                db,
                "callback",
                order,
                "failed",
                &message,
                false,
            )
            .await;
            SellerActionResult {
                success: false,
                message,
            }
        }
    }
}

fn retry_delay_minutes(attempt_count: i64) -> i64 {
    let index = (attempt_count - 1).clamp(0, CALLBACK_RETRY_BACKOFF_MINUTES.len() as i64 - 1);
    CALLBACK_RETRY_BACKOFF_MINUTES[index as usize]
}

async fn update_callback_failure(
    db: &mongodb::Database,
    order_id: ObjectId,
    attempt_count: i64,
    now: DateTime,
    status_code: Option<i64>,
    message: &str,
) {
    let next_retry_at =
        DateTime::from_millis(now.timestamp_millis() + retry_delay_minutes(attempt_count) * 60_000);
    let mut set_doc = doc! {
        "callbackRequired": true,
        "callbackAttemptCount": attempt_count,
        "callbackLastAttemptAt": now,
        "callbackNextRetryAt": next_retry_at,
        "callbackLastMessage": message,
        "updatedAt": now,
    };
    if let Some(status_code) = status_code {
        set_doc.insert("callbackLastStatusCode", status_code);
    }
    let _ = db
        .collection::<Document>("digiflazzsellerorders")
        .update_one(doc! { "_id": order_id }, doc! { "$set": set_doc })
        .await;
}

fn seller_callback_payload(order: &Document, config: &SellerConfig) -> Value {
    let status = document_string(order, "status");
    let rc = document_string(order, "rc");
    let message = document_string(order, "message");
    let status_code = match status.as_str() {
        "success" => "1",
        "failed" => "2",
        _ => "0",
    };
    let default_rc = match status.as_str() {
        "success" => "00",
        "failed" => "07",
        _ => "39",
    };
    let default_message = match status.as_str() {
        "success" => "Success",
        "failed" => "Failed",
        _ => "Process",
    };
    serde_json::json!({
        "data": {
            "ref_id": document_string(order, "refId"),
            "status": status_code,
            "code": document_string(order, "pulsaCode"),
            "hp": document_string(order, "target"),
            "price": order.get_i64("digiflazzPrice").or_else(|_| order.get_i32("digiflazzPrice").map(i64::from)).unwrap_or(0).to_string(),
            "message": if message.is_empty() { default_message.to_string() } else { message },
            "balance": config.reported_balance.to_string(),
            "tr_id": document_string(order, "trId"),
            "rc": if rc.is_empty() { default_rc.to_string() } else { rc },
            "sn": document_string(order, "sn"),
        }
    })
}

async fn log_seller_callback(
    db: &mongodb::Database,
    event: &str,
    order: &Document,
    status: &str,
    message: &str,
    verified: bool,
) {
    let document = crate::services::seller_secrecy::safe_seller_event_document(
        "digiflazz_seller",
        event,
        &document_string(order, "refId"),
        status,
        message,
        verified,
        "unknown",
    );
    let _ = db
        .collection::<Document>("webhookeventlogs")
        .insert_one(document)
        .await;
}
