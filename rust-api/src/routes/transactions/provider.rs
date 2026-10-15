use serde_json::Value;
use sqlx::Row;

use crate::{services::seller_secrets, state::AppState};

use super::{RecheckProduct, VendorTopUpResult};

fn provider_mode() -> String {
    std::env::var("PROVIDER_MODE")
        .unwrap_or_else(|_| "live".to_string())
        .trim()
        .to_lowercase()
}

pub(crate) async fn top_up_vendor(
    state: &AppState,
    ref_id: &str,
    target: &str,
    server_id: &str,
    product: &RecheckProduct,
) -> Result<VendorTopUpResult, ()> {
    let mode = provider_mode();
    if mode == "mock" {
        return Ok(mock_top_up_status(ref_id, target));
    }
    if product.vendor_name.to_lowercase().contains("tokovoucher") {
        return top_up_tokovoucher(state, ref_id, target, server_id, product).await;
    }
    top_up_digiflazz(state, ref_id, target, product).await
}

fn mock_top_up_status(ref_id: &str, target: &str) -> VendorTopUpResult {
    let status = status_from_scenario_text(Some(target))
        .unwrap_or_else(|| normalize_mock_status("PROVIDER_MOCK_TOPUP_STATUS", "pending"));
    let sn = if status == "success" {
        env_string("PROVIDER_MOCK_SN")
    } else {
        None
    };
    VendorTopUpResult {
        status: status.clone(),
        vendor_trx_id: env_string("PROVIDER_MOCK_VENDOR_TRX_ID")
            .or_else(|| Some(ref_id.to_string())),
        message: Some(
            env_string("PROVIDER_MOCK_MESSAGE").unwrap_or_else(|| format!("Mock top-up {status}")),
        ),
        sn,
    }
}

async fn top_up_digiflazz(
    state: &AppState,
    ref_id: &str,
    target: &str,
    product: &RecheckProduct,
) -> Result<VendorTopUpResult, ()> {
    let Some(credentials) = digiflazz_credentials_for_recheck(state, &product.vendor_name).await
    else {
        return Ok(VendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let sign = format!(
        "{:x}",
        md5::compute(format!(
            "{}{}{}",
            credentials.username, credentials.secret, ref_id
        ))
    );
    let base_url = credentials.base_url.trim_end_matches('/');
    let response = reqwest::Client::new()
        .post(format!("{base_url}/transaction"))
        .json(&serde_json::json!({
            "username": credentials.username,
            "buyer_sku_code": product.vendor_sku,
            "customer_no": target,
            "ref_id": ref_id,
            "sign": sign,
        }))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(VendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    Ok(VendorTopUpResult {
        status: map_provider_status(data.get("status").and_then(Value::as_str)),
        vendor_trx_id: data
            .get("ref_id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        message: data
            .get("message")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sn: data
            .get("sn")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

async fn top_up_tokovoucher(
    state: &AppState,
    ref_id: &str,
    target: &str,
    server_id: &str,
    product: &RecheckProduct,
) -> Result<VendorTopUpResult, ()> {
    let Some(credentials) = tokovoucher_credentials_for_recheck(state).await else {
        return Ok(VendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{}:{}",
            credentials.username, credentials.secret, ref_id
        ))
    );
    let base_url = credentials.base_url.trim_end_matches('/');
    let response = reqwest::Client::new()
        .post(format!("{base_url}/v1/transaksi"))
        .json(&serde_json::json!({
            "ref_id": ref_id,
            "produk": product.vendor_sku,
            "tujuan": target,
            "server_id": server_id,
            "member_code": credentials.username,
            "signature": signature,
        }))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(VendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    Ok(VendorTopUpResult {
        status: map_provider_status(data.get("status").and_then(Value::as_str)),
        vendor_trx_id: data
            .get("ref_id")
            .or_else(|| data.get("trxid"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        message: data
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .map(ToString::to_string),
        sn: data
            .get("sn")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}


struct RecheckVendorCredentials {
    username: String,
    secret: String,
    base_url: String,
}

async fn find_vendor_config(state: &AppState, name: &str) -> Option<Value> {
    let row = sqlx::query("SELECT name,api_base_url,config,status FROM vendors WHERE lower(name) LIKE '%' || lower($1) || '%' AND status=true ORDER BY name LIMIT 1")
        .bind(name)
        .fetch_optional(&state.pg_pool)
        .await
        .ok()
        .flatten()?;
    Some(serde_json::json!({
        "name": row.get::<String, _>("name"),
        "api_base_url": row.get::<String, _>("api_base_url"),
        "config": row.get::<Value, _>("config"),
        "status": row.get::<bool, _>("status"),
    })
    )
}

async fn digiflazz_credentials_for_recheck(
    state: &AppState,
    vendor_name: &str,
) -> Option<RecheckVendorCredentials> {
    let vendor = find_vendor_config(state, vendor_name).await;
    let config = vendor.as_ref().and_then(|vendor| vendor.get("config"));
    let username = config
        .and_then(|config| decrypted_config_string(config, "username", "digiflazz", "username"))
        .or_else(|| env_string("DIGIFLAZZ_USERNAME"))
        .unwrap_or_else(|| "demo".to_string());
    let secret = config
        .and_then(|config| decrypted_config_string(config, "apiKey", "digiflazz", "apiKey"))
        .or_else(|| env_string("DIGIFLAZZ_API_KEY"))
        .unwrap_or_else(|| "dev".to_string());
    let base_url = if provider_mode() == "sandbox" {
        env_string("PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL")?
    } else {
        vendor
            .as_ref()
            .and_then(|vendor| vendor.get("api_base_url"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| env_string("DIGIFLAZZ_BASE_URL"))
            .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string())
    };
    Some(RecheckVendorCredentials {
        username,
        secret,
        base_url,
    })
}

async fn tokovoucher_credentials_for_recheck(state: &AppState) -> Option<RecheckVendorCredentials> {
    let vendor = find_vendor_config(state, "tokovoucher").await;
    let config = vendor.as_ref().and_then(|vendor| vendor.get("config"));
    let username = config
        .and_then(|config| {
            decrypted_config_string(config, "memberCode", "tokovoucher", "memberCode")
                .or_else(|| decrypted_config_string(config, "apiKey", "tokovoucher", "apiKey"))
        })
        .or_else(|| env_string("TOKOVOUCHER_MEMBER_CODE"))
        .or_else(|| env_string("TOKOVOUCHER_API_KEY"))?;
    let secret = config
        .and_then(|config| decrypted_config_string(config, "secret", "tokovoucher", "secret"))
        .or_else(|| env_string("TOKOVOUCHER_SECRET"))?;
    let base_url = if provider_mode() == "sandbox" {
        env_string("PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL")?
    } else {
        vendor
            .as_ref()
            .and_then(|vendor| vendor.get("api_base_url"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| env_string("TOKOVOUCHER_BASE_URL"))
            .unwrap_or_else(|| "https://api.tokovoucher.net".to_string())
    };
    Some(RecheckVendorCredentials {
        username,
        secret,
        base_url,
    })
}

fn decrypted_config_string(config: &Value, key: &str, provider: &str, field: &str) -> Option<String> {
    let value = config.get(key)?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    if !seller_secrets::is_envelope(value) {
        return Some(value.to_string());
    }
    seller_secrets::open(provider, field, value)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn status_from_scenario_text(value: Option<&str>) -> Option<String> {
    let text = value?.to_lowercase();
    if text.contains("mock-status-success") {
        return Some("success".to_string());
    }
    if text.contains("mock-status-failed") {
        return Some("failed".to_string());
    }
    if text.contains("mock-status-pending") {
        return Some("pending".to_string());
    }
    None
}

fn normalize_mock_status(key: &str, fallback: &str) -> String {
    let status = std::env::var(key).unwrap_or_default().trim().to_lowercase();
    if matches!(status.as_str(), "success" | "failed" | "pending") {
        status
    } else {
        fallback.to_string()
    }
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn map_provider_status(value: Option<&str>) -> String {
    let normalized = value.unwrap_or_default().to_lowercase();
    if normalized.contains("sukses") || normalized.contains("success") {
        "success".to_string()
    } else if normalized.contains("gagal") || normalized.contains("failed") {
        "failed".to_string()
    } else {
        "pending".to_string()
    }
}
