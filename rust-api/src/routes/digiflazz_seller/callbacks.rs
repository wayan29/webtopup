use serde_json::Value;

use super::{seller_config, SellerActionResult, SellerConfig};
use crate::{services::seller_secrecy, state::AppState};

fn order_string(order: &Value, key: &str) -> String {
    order
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

const CALLBACK_RETRY_BACKOFF_MINUTES: [i64; 4] = [1, 5, 15, 60];

pub(super) async fn send_seller_callback(state: &AppState, order: &Value) -> SellerActionResult {
    let config = seller_config(&state.pg_pool).await;
    let order_id = order.get("id").and_then(Value::as_str).unwrap_or_default();
    if order_id.is_empty() {
        return SellerActionResult { success: false, message: "Order not found".to_string() };
    }
    let attempt_count = order.get("callback_attempt_count").and_then(Value::as_i64).unwrap_or(0) + 1;
    let now = chrono::Utc::now();
    let payload = seller_callback_payload(order, &config);
    if !config.callback_enabled {
        let message = "Callback dinonaktifkan pada pengaturan Digiflazz Seller".to_string();
        update_callback_failure(state, order_id, attempt_count, now, None, &message).await;
        log_seller_callback(state, "callback-skipped", order, "skipped", &message, false).await;
        return SellerActionResult { success: false, message };
    }
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(client) => client,
        Err(error) => {
            let message = error.to_string();
            update_callback_failure(state, order_id, attempt_count, now, None, &message).await;
            log_seller_callback(state, "callback", order, "failed", &message, false).await;
            return SellerActionResult { success: false, message };
        }
    };
    if config.digiflazz_callback_url.is_empty() {
        let message = "Callback URL belum dikonfigurasi".to_string();
        update_callback_failure(state, order_id, attempt_count, now, None, &message).await;
        log_seller_callback(state, "callback", order, "failed", &message, false).await;
        return SellerActionResult { success: false, message };
    }
    match client.post(&config.digiflazz_callback_url).json(&payload).send().await {
        Ok(response) => {
            let status = response.status().as_u16() as i32;
            let success = response.status().is_success();
            let body = response.json::<Value>().await.unwrap_or_default();
            let message = body.get("message").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("HTTP {status}"));
            if success {
                let _ = sqlx::query("UPDATE seller_callbacks SET delivered_at=$2,attempt_count=$3,next_retry_at=NULL,last_error='',last_status_code=$4,last_attempt_at=$2 WHERE channel='digiflazz' AND ref_id=$1")
                    .bind(order.get("reference_id").and_then(Value::as_str).unwrap_or_default()).bind(now).bind(attempt_count).bind(status).execute(&state.pg_pool).await;
                log_seller_callback(state, "callback", order, "delivered", &message, true).await;
                SellerActionResult { success: true, message }
            } else {
                update_callback_failure(state, order_id, attempt_count, now, Some(status), &message).await;
                log_seller_callback(state, "callback", order, "failed", &message, true).await;
                SellerActionResult { success: false, message }
            }
        }
        Err(error) => {
            let message = error.to_string();
            update_callback_failure(state, order_id, attempt_count, now, None, &message).await;
            log_seller_callback(state, "callback", order, "failed", &message, false).await;
            SellerActionResult { success: false, message }
        }
    }
}

fn retry_delay_minutes(attempt_count: i64) -> i64 {
    CALLBACK_RETRY_BACKOFF_MINUTES[(attempt_count - 1).clamp(0, CALLBACK_RETRY_BACKOFF_MINUTES.len() as i64 - 1) as usize]
}

async fn update_callback_failure(state: &AppState, order_id: &str, attempt_count: i64, now: chrono::DateTime<chrono::Utc>, status_code: Option<i32>, message: &str) {
    let next = now + chrono::Duration::minutes(retry_delay_minutes(attempt_count));
    let _ = sqlx::query("UPDATE seller_callbacks SET attempt_count=$2,next_retry_at=$3,last_error=$4,last_status_code=$5,last_attempt_at=$6 WHERE channel='digiflazz' AND ref_id=(SELECT reference_id FROM seller_orders WHERE id=$1::uuid)")
        .bind(order_id).bind(attempt_count).bind(next).bind(message).bind(status_code).bind(now).execute(&state.pg_pool).await;
}

fn seller_callback_payload(order: &Value, config: &SellerConfig) -> Value {
    let status = order_string(order, "status");
    let rc = order_string(order, "rc");
    let message = order_string(order, "message");
    let status_code = match status.as_str() { "success" => "1", "failed" => "2", _ => "0" };
    let default_rc = match status.as_str() { "success" => "00", "failed" => "07", _ => "39" };
    let default_message = match status.as_str() { "success" => "Success", "failed" => "Failed", _ => "Process" };
    serde_json::json!({"data":{"ref_id":order_string(order,"reference_id"),"status":status_code,"code":order_string(order,"buyer_sku_code"),"hp":order_string(order,"customer_no"),"price":order.get("amount").and_then(Value::as_i64).unwrap_or(0).to_string(),"message":if message.is_empty(){default_message.to_string()}else{message},"balance":config.reported_balance.to_string(),"tr_id":order_string(order,"vendor_reference"),"rc":if rc.is_empty(){default_rc.to_string()}else{rc},"sn":order_string(order,"sn")}})
}

async fn log_seller_callback(state: &AppState, event: &str, order: &Value, status: &str, message: &str, verified: bool) {
    let safe = seller_secrecy::safe_seller_event_document("digiflazz", event, &order_string(order, "reference_id"), status, message, verified, "unknown");
    let text = |key: &str| safe.get(key).and_then(Value::as_str).unwrap_or_default();
    let _ = sqlx::query("INSERT INTO seller_event_logs(channel,event,reference_id,status,message,verified,request_ip) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(text("provider")).bind(text("event")).bind(text("refId")).bind(text("status")).bind(text("message")).bind(safe.get("verified").and_then(Value::as_bool).unwrap_or(false)).bind(text("requestIp")).execute(&state.pg_pool).await;
}

