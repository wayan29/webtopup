use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::state::AppState;

use super::checkout::GuestProductRow;

pub(super) async fn load_guest_product_document(
    pool: &sqlx::PgPool,
    product_id: Uuid,
) -> Option<GuestProductRow> {
    sqlx::query("SELECT p.id,p.code,p.name,jsonb_build_object('basic',p.price_basic,'gold',p.price_gold,'platinum',p.price_platinum) AS price,p.status,p.category_id,c.name AS category_name,p.operator_id,o.name AS operator_name,p.product_type_id,p.validation,p.vendor_name,p.vendor_sku FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id WHERE p.id=$1")
        .bind(product_id).fetch_optional(pool).await.ok().flatten().map(product_row)
}

pub(super) fn product_validation_config(product: &GuestProductRow) -> Option<Value> {
    product.validation.get("enabled").and_then(Value::as_bool).filter(|enabled| *enabled)
        .map(|_| product.validation.clone())
}

fn product_row(row: sqlx::postgres::PgRow) -> GuestProductRow {
    GuestProductRow {
        id: row.get("id"), code: row.get("code"), name: row.get("name"), price: row.get("price"),
        status: row.get("status"), category_id: row.get("category_id"),
        category_name: row.try_get("category_name").unwrap_or_default(),
        operator_id: row.get("operator_id"), operator_name: row.try_get("operator_name").unwrap_or_default(),
        product_type_id: row.get("product_type_id"), validation: row.get("validation"),
        vendor_name: row.get("vendor_name"), vendor_sku: row.get("vendor_sku"),
    }
}


pub(super) async fn load_guest_product_by_code(pool: &sqlx::PgPool, code: &str) -> Option<GuestProductRow> {
    sqlx::query("SELECT p.id,p.code,p.name,jsonb_build_object('basic',p.price_basic,'gold',p.price_gold,'platinum',p.price_platinum) AS price,p.status,p.category_id,c.name AS category_name,p.operator_id,o.name AS operator_name,p.product_type_id,p.validation,p.vendor_name,p.vendor_sku FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN operators o ON o.id=p.operator_id WHERE p.code=$1")
        .bind(code).fetch_optional(pool).await.ok().flatten().map(product_row)
}

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
    config: Value,
}

pub(super) async fn load_guest_provider_product(pool: &sqlx::PgPool, product_id: Uuid) -> Option<GuestProviderProduct> {
    sqlx::query("SELECT vendor_name,vendor_sku,code FROM products WHERE id=$1")
        .bind(product_id).fetch_optional(pool).await.ok().flatten().map(|row| {
            let vendor_sku: String = row.get("vendor_sku");
            GuestProviderProduct { vendor_name: row.get("vendor_name"), vendor_sku: if vendor_sku.is_empty() { row.get("code") } else { vendor_sku } }
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

async fn digiflazz_guest_credentials(state: &AppState, vendor_name: &str) -> Option<GuestVendorCredentials> {
    let vendor = find_vendor_config(state, vendor_name).await?;
    let config = vendor.get("config")?;
    let username = config_string(config, "username", "digiflazz", "username")?;
    let secret = config_string(config, "apiKey", "digiflazz", "apiKey")?;
    let base_url = if provider_mode() == "sandbox" { env_string("PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL")? }
        else { vendor.get("api_base_url").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(str::to_owned).unwrap_or_else(|| "https://api.digiflazz.com/v1".to_string()) };
    Some(GuestVendorCredentials { username, secret, base_url, config: config.clone() })
}

async fn tokovoucher_guest_credentials(state: &AppState) -> Option<GuestVendorCredentials> {
    let vendor = find_vendor_config(state, "tokovoucher").await?;
    let config = vendor.get("config")?;
    let username = config_string(config, "memberCode", "tokovoucher", "memberCode")
        .or_else(|| config_string(config, "apiKey", "tokovoucher", "apiKey"))?;
    let secret = config_string(config, "secret", "tokovoucher", "secret")?;
    let base_url = if provider_mode() == "sandbox" { env_string("PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL")? }
        else { vendor.get("api_base_url").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(str::to_owned).unwrap_or_else(|| "https://api.tokovoucher.net".to_string()) };
    Some(GuestVendorCredentials { username, secret, base_url, config: config.clone() })
}

async fn find_vendor_config(state: &AppState, name: &str) -> Option<Value> {
    sqlx::query("SELECT name,api_base_url,config,status FROM vendors WHERE lower(name) LIKE '%' || lower($1) || '%' AND status=true ORDER BY name LIMIT 1")
        .bind(name).fetch_optional(&state.pg_pool).await.ok().flatten().map(|row| serde_json::json!({"name":row.get::<String,_>("name"),"api_base_url":row.get::<String,_>("api_base_url"),"config":row.get::<Value,_>("config"),"status":row.get::<bool,_>("status")}))
}

fn config_string(config: &Value, key: &str, provider: &str, field: &str) -> Option<String> {
    let value = config.get(key)?.as_str()?.trim();
    if value.is_empty() || !crate::services::seller_secrets::is_envelope(value) { return None; }
    crate::services::seller_secrets::open(provider, field, value).ok().filter(|v| !v.trim().is_empty())
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
