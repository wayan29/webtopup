use std::sync::Arc;

use axum::{body::Bytes, extract::{OriginalUri, State}, http::HeaderMap, response::IntoResponse};
use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::state::AppState;

use super::{responses::status_message, store::setting_string, utils::has_whitelist};

pub async fn receive(State(state): State<Arc<AppState>>, OriginalUri(uri): OriginalUri, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let provider = uri.path().rsplit('/').next().unwrap_or("");
    if !matches!(provider, "digiflazz" | "tokovoucher") {
        return status_message(axum::http::StatusCode::NOT_FOUND, "Webhook provider not found");
    }
    let (secret_key, whitelist_key) = if provider == "digiflazz" { ("digiflazzWebhookSecret", "digiflazzWhitelistIP") } else { ("tokovoucherWebhookSecret", "tokovoucherWhitelistIP") };
    let (stored_secret, whitelist) = match (setting_string(&state.pg_pool, secret_key).await, setting_string(&state.pg_pool, whitelist_key).await) {
        (Ok(secret), Ok(whitelist)) => (secret, whitelist),
        _ => return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Webhook store unavailable"),
    };
    let secret = if stored_secret.is_empty() { std::env::var("WEBHOOK_SHARED_SECRET").unwrap_or_default() } else { stored_secret };
    let whitelist = if whitelist.is_empty() { std::env::var(format!("{}_ALLOWLIST", provider.to_ascii_uppercase())).unwrap_or_default() } else { whitelist };
    let request_ip = client_ip(&headers);
    if has_whitelist(&whitelist) && !whitelist.split(',').map(str::trim).filter(|value| !value.is_empty()).any(|rule| ip_matches_rule(&request_ip, rule)) {
        return status_message(axum::http::StatusCode::FORBIDDEN, "IP not allowed");
    }
    if secret.is_empty() && !has_whitelist(&whitelist) {
        return status_message(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Webhook protection is not configured");
    }
    let signature = headers.get("x-hub-signature").and_then(|value| value.to_str().ok()).unwrap_or("");
    if !secret.is_empty() && !signature_matches(secret.as_bytes(), &body, signature) {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Invalid signature");
    }
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return status_message(axum::http::StatusCode::BAD_REQUEST, "Invalid webhook payload"),
    };
    let ref_id = payload.get("ref_id").and_then(|value| value.as_str()).unwrap_or("");
    let status = payload.get("status").and_then(|value| value.as_str()).unwrap_or("");
    if ref_id.is_empty() || !matches!(status, "success" | "failed") {
        return status_message(axum::http::StatusCode::BAD_REQUEST, "Invalid webhook payload");
    }
    match apply_financial_webhook(&state.pg_pool, provider, ref_id, status, &body, &request_ip).await {
        Ok(result) => axum::Json(serde_json::json!({"status":result,"provider":provider})).into_response(),
        Err(()) => status_message(axum::http::StatusCode::CONFLICT, "Webhook transition rejected"),
    }
}

async fn apply_financial_webhook(pool: &sqlx::PgPool, provider: &str, ref_id: &str, status: &str, body: &[u8], request_ip: &str) -> Result<&'static str, ()> {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(body));
    let mut tx = pool.begin().await.map_err(|_| ())?;
    let order = sqlx::query_as::<_, (uuid::Uuid, Option<uuid::Uuid>, i64, String, bool, serde_json::Value)>(
        "SELECT id,user_id,amount,status,refunded,snapshot FROM financial_transactions WHERE reference_id=$1 FOR UPDATE")
        .bind(ref_id).fetch_optional(&mut *tx).await.map_err(|_| ())?.ok_or(())?;
    let (order_id, user_id, amount, current_status, refunded, snapshot) = order;
    let owner = user_id.ok_or(())?;
    let order_provider = snapshot.get("provider").and_then(serde_json::Value::as_str).ok_or(())?;
    if order_provider != provider || amount <= 0 || snapshot.get("userId").and_then(serde_json::Value::as_str).is_some_and(|value| value != owner.to_string()) { return Err(()); }
    let event = sqlx::query_as::<_, (String, bool)>("SELECT status,refunded FROM webhook_events WHERE provider=$1 AND ref_id=$2 FOR UPDATE")
        .bind(provider).bind(ref_id).fetch_optional(&mut *tx).await.map_err(|_| ())?;
    if let Some((old, _)) = &event { if old == status { return Ok("replay"); } }
    if status == "failed" {
        if event.is_some() || current_status == "success" { return Err(()); }
        if current_status == "failed" { return Ok("replay"); }
        let direction: i16 = 1;
        let kind = "refund";
        let balance: i64 = sqlx::query_scalar("SELECT balance FROM users WHERE id=$1 FOR UPDATE").bind(owner).fetch_optional(&mut *tx).await.map_err(|_| ())?.ok_or(())?;
        let next = balance.checked_add(i64::from(direction).checked_mul(amount).ok_or(())?).ok_or(())?;
        if next < 0 { return Err(()); }
        sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,$3,$4,$5,$6)").bind(owner).bind(format!("webhook-{}:{provider}:{ref_id}", if direction < 0 { "correction" } else { "refund" })).bind(kind).bind(direction).bind(amount).bind(next).execute(&mut *tx).await.map_err(|_| ())?;
        sqlx::query("UPDATE users SET balance=$2,updated_at=now() WHERE id=$1").bind(owner).bind(next).execute(&mut *tx).await.map_err(|_| ())?;
        let now_refunded = direction > 0;
        sqlx::query("UPDATE financial_transactions SET status='failed',refunded=$2,updated_at=now() WHERE id=$1").bind(order_id).bind(now_refunded).execute(&mut *tx).await.map_err(|_| ())?;
    } else {
        if current_status == "failed" || refunded {
            if !event.as_ref().is_some_and(|(old, was_refunded)| old == "failed" && *was_refunded) { return Err(()); }
            let balance: i64 = sqlx::query_scalar("SELECT balance FROM users WHERE id=$1 FOR UPDATE").bind(owner).fetch_optional(&mut *tx).await.map_err(|_| ())?.ok_or(())?;
            let next = balance.checked_sub(amount).filter(|value| *value >= 0).ok_or(())?;
            sqlx::query("INSERT INTO ledger_entries(user_id,source,kind,direction,amount,balance_after) VALUES($1,$2,'debit',-1,$3,$4)").bind(owner).bind(format!("webhook-correction:{provider}:{ref_id}")).bind(amount).bind(next).execute(&mut *tx).await.map_err(|_| ())?;
            sqlx::query("UPDATE users SET balance=$2,updated_at=now() WHERE id=$1").bind(owner).bind(next).execute(&mut *tx).await.map_err(|_| ())?;
        }
        sqlx::query("UPDATE financial_transactions SET status='success',refunded=false,updated_at=now() WHERE id=$1").bind(order_id).execute(&mut *tx).await.map_err(|_| ())?;
    }
    sqlx::query("INSERT INTO webhook_events(provider,ref_id,status,payload_digest,refunded) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider,ref_id) DO UPDATE SET status=EXCLUDED.status,payload_digest=EXCLUDED.payload_digest,refunded=EXCLUDED.refunded")
        .bind(provider).bind(ref_id).bind(status).bind(digest).bind(status == "failed").execute(&mut *tx).await.map_err(|_| ())?;
    sqlx::query("INSERT INTO financial_status_events(transaction_id,status,payload) VALUES($1,$2,$3)").bind(order_id).bind(status).bind(serde_json::json!({"provider":provider,"referenceId":ref_id,"requestIp":request_ip})).execute(&mut *tx).await.map_err(|_| ())?;
    sqlx::query("INSERT INTO webhook_event_logs(provider,event,reference_id,status,message,verified,request_ip) VALUES($1,'financial_callback',$2,$3,'applied',true,$4)").bind(provider).bind(ref_id).bind(status).bind(request_ip).execute(&mut *tx).await.map_err(|_| ())?;
    tx.commit().await.map_err(|_| ())?;
    Ok("applied")
}

fn client_ip(headers: &HeaderMap) -> String {
    headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()).and_then(|value| value.split(',').next_back()).map(str::trim).filter(|value| !value.is_empty()).or_else(|| headers.get("x-real-ip").and_then(|value| value.to_str().ok()).map(str::trim)).filter(|value| !value.is_empty()).unwrap_or("unknown").to_string()
}
fn ip_matches_rule(client_ip: &str, rule: &str) -> bool {
    if client_ip == rule { return true; }
    let Some((range_ip, prefix)) = rule.split_once('/') else { return false; };
    let (Ok(client), Ok(range), Ok(prefix)) = (client_ip.parse::<std::net::Ipv4Addr>(), range_ip.parse::<std::net::Ipv4Addr>(), prefix.parse::<u8>()) else { return false; };
    if prefix > 32 { return false; }
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    (u32::from(client) & mask) == (u32::from(range) & mask)
}

fn signature_matches(secret: &[u8], body: &[u8], signature: &str) -> bool {
    let Ok(mut mac) = <Hmac<Sha1> as Mac>::new_from_slice(secret) else { return false; };
    mac.update(body);
    let expected = format!("sha1={}", hex(mac.finalize().into_bytes().as_slice()));
    signature.len() == expected.len() && subtle::ConstantTimeEq::ct_eq(signature.as_bytes(), expected.as_bytes()).into()
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

#[cfg(test)]
mod tests {
    use super::{hex, signature_matches};
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    #[test]
    fn accepts_exact_raw_body_and_rejects_reordered_json() {
        let secret = b"webhook-secret";
        let raw = br#"{"ref_id":"REF-1","status":"failed"}"#;
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("key");
        mac.update(raw);
        let signature = format!("sha1={}", hex(mac.finalize().into_bytes().as_slice()));
        assert!(signature_matches(secret, raw, &signature));
        assert!(!signature_matches(secret, br#"{"status":"failed","ref_id":"REF-1"}"#, &signature));
        assert!(!signature_matches(secret, raw, "sha1=00"));
    }
}

