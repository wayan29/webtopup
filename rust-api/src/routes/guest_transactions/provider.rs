use mongodb::bson::{doc, oid::ObjectId, Document};
use serde_json::Value;

use crate::{state::AppState, utils::bson::read_string};

pub(super) struct GuestProviderProduct {
    pub(super) vendor_name: String,
    pub(super) vendor_sku: String,
}

pub(super) struct GuestVendorTopUpResult {
    pub(super) status: String,
    pub(super) vendor_trx_id: Option<String>,
    pub(super) message: Option<String>,
    pub(super) sn: Option<String>,
}

struct GuestVendorCredentials {
    username: String,
    secret: String,
    base_url: String,
}

pub(super) async fn load_guest_product_document(
    db: &mongodb::Database,
    product_id: ObjectId,
) -> Option<Document> {
    db.collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten()
}

pub(super) async fn load_guest_provider_product(
    db: &mongodb::Database,
    product_id: ObjectId,
) -> Option<GuestProviderProduct> {
    let document = db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .projection(doc! { "code": 1, "vendor": 1 })
        .await
        .ok()??;
    let vendor = document.get_document("vendor").ok();
    let code = read_string(&document, "code");
    Some(GuestProviderProduct {
        vendor_name: vendor
            .map(|value| read_string(value, "name"))
            .unwrap_or_default(),
        vendor_sku: vendor
            .map(|value| read_string(value, "sku"))
            .filter(|value| !value.is_empty())
            .unwrap_or(code),
    })
}

pub(super) async fn top_up_guest_vendor(
    state: &AppState,
    ref_id: &str,
    target: &str,
    server_id: &str,
    product: &GuestProviderProduct,
) -> Result<GuestVendorTopUpResult, ()> {
    let mode = provider_mode();
    if mode == "mock" {
        return mock_guest_top_up_status(ref_id, target);
    }
    if product.vendor_name.to_lowercase().contains("tokovoucher") {
        return top_up_guest_tokovoucher(state, ref_id, target, server_id, product).await;
    }
    top_up_guest_digiflazz(state, ref_id, target, product).await
}

fn mock_guest_top_up_status(ref_id: &str, target: &str) -> Result<GuestVendorTopUpResult, ()> {
    if target.to_lowercase().contains("mock-status-error") {
        return Err(());
    }
    let status = status_from_scenario_text(Some(target))
        .unwrap_or_else(|| normalize_mock_status("PROVIDER_MOCK_TOPUP_STATUS", "pending"));
    let sn = if status == "success" {
        env_string("PROVIDER_MOCK_SN")
    } else {
        None
    };
    Ok(GuestVendorTopUpResult {
        status: status.clone(),
        vendor_trx_id: env_string("PROVIDER_MOCK_VENDOR_TRX_ID")
            .or_else(|| Some(ref_id.to_string())),
        message: Some(
            env_string("PROVIDER_MOCK_MESSAGE").unwrap_or_else(|| format!("Mock top-up {status}")),
        ),
        sn,
    })
}

async fn top_up_guest_digiflazz(
    state: &AppState,
    ref_id: &str,
    target: &str,
    product: &GuestProviderProduct,
) -> Result<GuestVendorTopUpResult, ()> {
    let Some(credentials) = digiflazz_guest_credentials(state, &product.vendor_name).await else {
        return Ok(GuestVendorTopUpResult {
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
        return Ok(GuestVendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    Ok(GuestVendorTopUpResult {
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

async fn top_up_guest_tokovoucher(
    state: &AppState,
    ref_id: &str,
    target: &str,
    server_id: &str,
    product: &GuestProviderProduct,
) -> Result<GuestVendorTopUpResult, ()> {
    let Some(credentials) = tokovoucher_guest_credentials(state).await else {
        return Ok(GuestVendorTopUpResult {
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
        return Ok(GuestVendorTopUpResult {
            status: "failed".to_string(),
            vendor_trx_id: None,
            message: Some("Connection Error".to_string()),
            sn: None,
        });
    };
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    Ok(GuestVendorTopUpResult {
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

async fn digiflazz_guest_credentials(
    state: &AppState,
    vendor_name: &str,
) -> Option<GuestVendorCredentials> {
    let vendor = find_vendor_config(state, vendor_name).await;
    let config = vendor
        .as_ref()
        .and_then(|document| document.get_document("config").ok());
    let username = config
        .and_then(|document| normalized_config_string(document, "username"))
        .or_else(|| env_string("DIGIFLAZZ_USERNAME"))
        .unwrap_or_else(|| "demo".to_string());
    let secret = config
        .and_then(|document| normalized_config_string(document, "apiKey"))
        .or_else(|| env_string("DIGIFLAZZ_API_KEY"))
        .unwrap_or_else(|| "dev".to_string());
    let base_url = if provider_mode() == "sandbox" {
        env_string("PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL")?
    } else {
        vendor
            .as_ref()
            .and_then(|document| normalized_config_string(document, "apiBaseUrl"))
            .or_else(|| env_string("DIGIFLAZZ_BASE_URL"))
            .unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string())
    };
    Some(GuestVendorCredentials {
        username,
        secret,
        base_url,
    })
}

async fn tokovoucher_guest_credentials(state: &AppState) -> Option<GuestVendorCredentials> {
    let vendor = find_vendor_config(state, "tokovoucher").await;
    let config = vendor
        .as_ref()
        .and_then(|document| document.get_document("config").ok());
    let username = config
        .and_then(|document| {
            normalized_config_string(document, "memberCode")
                .or_else(|| normalized_config_string(document, "apiKey"))
        })
        .or_else(|| env_string("TOKOVOUCHER_MEMBER_CODE"))
        .or_else(|| env_string("TOKOVOUCHER_API_KEY"))?;
    let secret = config
        .and_then(|document| normalized_config_string(document, "secret"))
        .or_else(|| env_string("TOKOVOUCHER_SECRET"))?;
    let base_url = if provider_mode() == "sandbox" {
        env_string("PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL")?
    } else {
        vendor
            .as_ref()
            .and_then(|document| normalized_config_string(document, "apiBaseUrl"))
            .or_else(|| env_string("TOKOVOUCHER_BASE_URL"))
            .unwrap_or_else(|| "https://api.tokovoucher.net".to_string())
    };
    Some(GuestVendorCredentials {
        username,
        secret,
        base_url,
    })
}

async fn find_vendor_config(state: &AppState, name: &str) -> Option<Document> {
    state
        .mongo_client
        .as_ref()?
        .database(&state.mongo_db)
        .collection::<Document>("vendors")
        .find_one(doc! { "name": { "$regex": name, "$options": "i" } })
        .await
        .ok()
        .flatten()
}

fn provider_mode() -> String {
    std::env::var("PROVIDER_MODE")
        .unwrap_or_else(|_| "live".to_string())
        .trim()
        .to_lowercase()
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

fn normalized_config_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_str(key)
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
