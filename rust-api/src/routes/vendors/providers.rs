use std::time::Duration;

use serde_json::Value;
use sqlx::{PgPool, Row};

use super::{
    sync_pricing::{category_icon_for_label, sell_prices_from_cost, MembershipMargins},
    types::{TokovoucherAccess, VendorCredentials},
};

pub(in crate::routes::vendors) const PROVIDER_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

fn request_failure_message(error: &reqwest::Error) -> String {
    if error.is_timeout() { "provider request timeout".to_string() } else { "provider request failed".to_string() }
}

fn numeric_balance(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else { return Err("provider balance response invalid".into()) };
    let valid = value.as_i64().is_some_and(|number| number >= 0) || value.as_u64().is_some() || value.as_f64().is_some_and(|number| number.is_finite() && number >= 0.0);
    valid.then(|| value.clone()).ok_or_else(|| "provider balance response invalid".into())
}

pub(in crate::routes::vendors) async fn fetch_digiflazz_balance_with_base_url(credentials: &VendorCredentials, base_url: &str) -> Result<Value, String> {
    fetch_digiflazz_balance_with_timeout(credentials, base_url, PROVIDER_HEALTH_TIMEOUT).await
}

async fn fetch_digiflazz_balance_with_timeout(credentials: &VendorCredentials, base_url: &str, timeout: Duration) -> Result<Value, String> {
    let signature = format!("{:x}", md5::compute(format!("{}{}depo", credentials.username, credentials.secret)));
    let payload = serde_json::json!({"cmd":"deposit","username":credentials.username,"sign":signature});
    let client = reqwest::Client::builder().timeout(timeout).build().map_err(|_| "provider request failed".to_string())?;
    let response = client.post(format!("{}/cek-saldo", base_url.trim_end_matches('/'))).json(&payload).send().await.map_err(|error| request_failure_message(&error))?;
    if !response.status().is_success() { return Err("provider HTTP status".to_string()); }
    let body = response.json::<Value>().await.map_err(|_| "provider balance response invalid".to_string())?;
    numeric_balance(body.pointer("/data/deposit"))
}

pub(in crate::routes::vendors) struct DigiflazzTransactionResult { pub status: String, pub message: String, pub sn: Option<String>, pub raw: Value }

pub(in crate::routes::vendors) async fn send_digiflazz_transaction(credentials: &VendorCredentials, base_url: &str, buyer_sku_code: &str, customer_no: &str, ref_id: &str) -> DigiflazzTransactionResult {
    let signature = format!("{:x}", md5::compute(format!("{}{}{}", credentials.username, credentials.secret, ref_id)));
    let payload = serde_json::json!({"username":credentials.username,"buyer_sku_code":buyer_sku_code,"customer_no":customer_no,"ref_id":ref_id,"sign":signature});
    let response = reqwest::Client::new().post(format!("{}/transaction", base_url.trim_end_matches('/'))).json(&payload).send().await;
    let Ok(response) = response else { return DigiflazzTransactionResult {status:"failed".into(),message:"Connection Error".into(),sn:None,raw:serde_json::json!({"message":"Connection Error"})} };
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    DigiflazzTransactionResult {status:map_digiflazz_purchase_status(data.get("status").and_then(Value::as_str)),message:data.get("message").and_then(Value::as_str).or_else(||data.get("rc").and_then(Value::as_str)).unwrap_or("Transaksi dikirim ke Digiflazz").to_string(),sn:data.get("sn").and_then(Value::as_str).map(ToString::to_string),raw:body}
}

fn map_digiflazz_purchase_status(value: Option<&str>) -> String {
    let normalized=value.unwrap_or_default().to_lowercase();
    if normalized.contains("sukses")||normalized.contains("success") {"success".into()} else if normalized.contains("gagal")||normalized.contains("failed") {"failed".into()} else {"pending".into()}
}

pub(super) async fn fetch_digiflazz_pricelist_remote(credentials: &VendorCredentials, base_url: &str) -> Vec<Value> {
    let signature=format!("{:x}",md5::compute(format!("{}{}pricelist",credentials.username,credentials.secret)));
    let payload=serde_json::json!({"cmd":"prepaid","username":credentials.username,"sign":signature});
    let Ok(response)=reqwest::Client::new().post(format!("{}/price-list",base_url.trim_end_matches('/'))).json(&payload).send().await else{return Vec::new()};
    let Ok(body)=response.json::<Value>().await else{return Vec::new()};
    body.get("data").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(Value::is_object).collect()
}

pub(super) async fn sync_product_items(pool: &PgPool, vendor_name: &str, items: Vec<Value>) -> Result<i64, String> {
    let margins=load_membership_margins(pool).await;
    let mut tx=pool.begin().await.map_err(|error|error.to_string())?;
    let mut synced_count=0;
    for item in items {
        let code=item.get("buyer_sku_code").and_then(Value::as_str).unwrap_or_default();
        if code.is_empty(){continue;}
        let name=item.get("product_name").and_then(Value::as_str).unwrap_or_default();
        let category=item.get("category").and_then(Value::as_str).unwrap_or_default();
        let brand=item.get("brand").and_then(Value::as_str).unwrap_or_default();
        let cost_price=item.get("price").and_then(value_to_i64).unwrap_or(0).max(0);
        let status=item.get("seller_product_status").and_then(Value::as_bool).unwrap_or(false);
        let sell=sell_prices_from_cost(cost_price,margins);
        let taxonomy=ensure_product_taxonomy(&mut tx,category,brand).await?;
        sqlx::query("INSERT INTO vendor_prices(vendor,sku,cost,basic,gold,platinum) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(vendor,sku) DO UPDATE SET cost=excluded.cost,basic=excluded.basic,gold=excluded.gold,platinum=excluded.platinum")
            .bind(vendor_name).bind(code).bind(cost_price).bind(sell.basic).bind(sell.gold).bind(sell.platinum).execute(&mut *tx).await.map_err(|error|error.to_string())?;
        sqlx::query("INSERT INTO products(code,name,category,category_id,operator_id,product_type_id,payment_type,brand,cost_price,price_basic,price_gold,price_platinum,vendor_name,vendor_sku,status) VALUES($1,$2,$3,$4,$5,$6,'prabayar',$7,$8,$9,$10,$11,$12,$1,$13) ON CONFLICT(code) DO UPDATE SET name=excluded.name,category=excluded.category,category_id=excluded.category_id,operator_id=excluded.operator_id,product_type_id=excluded.product_type_id,brand=excluded.brand,cost_price=excluded.cost_price,price_basic=excluded.price_basic,price_gold=excluded.price_gold,price_platinum=excluded.price_platinum,vendor_name=excluded.vendor_name,vendor_sku=excluded.vendor_sku,status=excluded.status,updated_at=now()")
            .bind(code).bind(name).bind(&taxonomy.category_name).bind(taxonomy.category_id).bind(taxonomy.operator_id).bind(taxonomy.product_type_id).bind(brand).bind(cost_price).bind(sell.basic).bind(sell.gold).bind(sell.platinum).bind(vendor_name).bind(status).execute(&mut *tx).await.map_err(|error|error.to_string())?;
        synced_count+=1;
    }
    tx.commit().await.map_err(|error|error.to_string())?;
    Ok(synced_count)
}

#[derive(Clone)]
struct ProductTaxonomyIds { category_id: uuid::Uuid, category_name: String, operator_id: uuid::Uuid, product_type_id: uuid::Uuid }

async fn load_membership_margins(pool: &PgPool) -> MembershipMargins {
    let Ok(Some(value))=sqlx::query_scalar::<_,Value>("SELECT value FROM site_settings WHERE key='margins'").fetch_optional(pool).await else{return MembershipMargins::default()};
    MembershipMargins {basic:read_f64_margin(&value,"basic",MembershipMargins::default().basic),gold:read_f64_margin(&value,"gold",MembershipMargins::default().gold),platinum:read_f64_margin(&value,"platinum",MembershipMargins::default().platinum)}
}

fn read_f64_margin(value:&Value,key:&str,fallback:f64)->f64{value.get(key).and_then(Value::as_f64).filter(|number|number.is_finite()&&*number>=0.0).unwrap_or(fallback)}

fn taxonomy_slug(value:&str)->Option<String>{let mut slug=String::new();let mut dash=false;for character in value.trim().to_lowercase().chars(){if character.is_ascii_alphanumeric(){slug.push(character);dash=false}else if !dash&&!slug.is_empty(){slug.push('-');dash=true}}while slug.ends_with('-'){slug.pop();}(!slug.is_empty()).then_some(slug)}

async fn ensure_product_taxonomy(tx:&mut sqlx::Transaction<'_,sqlx::Postgres>,category_label:&str,brand:&str)->Result<ProductTaxonomyIds,String>{
    let category_name=if category_label.trim().is_empty(){"Lainnya".to_string()}else{category_label.trim().to_string()};
    let operator_name=if brand.trim().is_empty(){"Umum".to_string()}else{brand.trim().to_string()};
    let category_slug=taxonomy_slug(&category_name).ok_or_else(||format!("invalid category name for slug: {category_name}"))?;
    let category_id=match sqlx::query_scalar::<_,uuid::Uuid>("SELECT id FROM categories WHERE slug=$1 OR lower(name)=lower($2) LIMIT 1").bind(&category_slug).bind(&category_name).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())?{Some(id)=>id,None=>sqlx::query_scalar::<_,uuid::Uuid>("INSERT INTO categories(name,slug,icon,sort_order,status,is_active) VALUES($1,$2,$3,COALESCE((SELECT MAX(sort_order)+1 FROM categories),0),true,true) RETURNING id").bind(&category_name).bind(&category_slug).bind(category_icon_for_label(&category_name)).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?};
    let operator_slug=taxonomy_slug(&operator_name).ok_or_else(||format!("invalid operator name for slug: {operator_name}"))?;
    let operator_id=match sqlx::query_scalar::<_,uuid::Uuid>("SELECT id FROM operators WHERE category_id=$1 AND slug=$2 LIMIT 1").bind(category_id).bind(&operator_slug).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())?{Some(id)=>id,None=>sqlx::query_scalar::<_,uuid::Uuid>("INSERT INTO operators(category_id,name,slug,status,user_id_label,user_id_type) VALUES($1,$2,$3,true,'Nomor / User ID','text') RETURNING id").bind(category_id).bind(&operator_name).bind(&operator_slug).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?};
    let product_type_id=match sqlx::query_scalar::<_,uuid::Uuid>("SELECT id FROM product_types WHERE operator_id=$1 AND slug='umum' LIMIT 1").bind(operator_id).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())? {
        Some(id) => id,
        None => match sqlx::query_scalar::<_,uuid::Uuid>("SELECT id FROM product_types WHERE operator_id=$1 AND status=true ORDER BY sort_order LIMIT 1").bind(operator_id).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())? {
            Some(id) => id,
            None => sqlx::query_scalar::<_,uuid::Uuid>("INSERT INTO product_types(category_id,operator_id,name,slug) VALUES($1,$2,'Umum','umum') RETURNING id").bind(category_id).bind(operator_id).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?,
        },
    };
    Ok(ProductTaxonomyIds{category_id,category_name,operator_id,product_type_id})
}


pub(in crate::routes::vendors) async fn fetch_tokovoucher_balance_with_base_url(
    credentials: &VendorCredentials,
    base_url: &str,
) -> Result<Value, String> {
    fetch_tokovoucher_balance_with_timeout(credentials, base_url, PROVIDER_HEALTH_TIMEOUT).await
}

async fn fetch_tokovoucher_balance_with_timeout(
    credentials: &VendorCredentials,
    base_url: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let signature = format!(
        "{:x}",
        md5::compute(format!("{}:{}", credentials.username, credentials.secret))
    );
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "provider request failed".to_string())?;
    let response = client
        .get(format!("{}/member", base_url.trim_end_matches('/')))
        .query(&[
            ("member_code", credentials.username.as_str()),
            ("signature", signature.as_str()),
        ])
        .send()
        .await
        .map_err(|error| request_failure_message(&error))?;
    if !response.status().is_success() {
        return Err("provider HTTP status".to_string());
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "provider balance response invalid".to_string())?;
    numeric_balance(body.pointer("/data/saldo"))
}

pub(in crate::routes::vendors) struct TokovoucherProductLookupResult {
    pub code: String,
    pub name: String,
    pub price: i64,
    pub raw: Value,
}

pub(in crate::routes::vendors) struct TokovoucherTransactionResult {
    pub status: String,
    pub message: String,
    pub sn: Option<String>,
    pub raw: Value,
}

pub(in crate::routes::vendors) async fn fetch_tokovoucher_product_by_code(
    access: &TokovoucherAccess,
    code: &str,
) -> Result<TokovoucherProductLookupResult, String> {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{}",
            access.credentials.username, access.credentials.secret
        ))
    );
    let response = reqwest::Client::new()
        .get(format!(
            "{}/produk/code",
            access.base_url.trim_end_matches('/')
        ))
        .query(&[
            ("member_code", access.credentials.username.as_str()),
            ("signature", signature.as_str()),
            ("kode", code),
        ])
        .send()
        .await
        .map_err(|_| "Gagal validasi produk Tokovoucher".to_string())?;
    if !response.status().is_success() {
        return Err("Gagal validasi produk Tokovoucher".to_string());
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "Gagal membaca response produk Tokovoucher".to_string())?;
    let product = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .or_else(|| body.get("data").filter(|value| value.is_object()))
        .ok_or_else(|| "Produk Tokovoucher tidak ditemukan".to_string())?;
    let product_code = product
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or(code)
        .to_string();
    let name = product
        .get("nama_produk")
        .or_else(|| product.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&product_code)
        .to_string();
    let price = product
        .get("price")
        .and_then(value_to_i64)
        .ok_or_else(|| "Harga produk Tokovoucher tidak valid".to_string())?;
    if price <= 0 {
        return Err("Harga produk Tokovoucher tidak valid".to_string());
    }

    Ok(TokovoucherProductLookupResult {
        code: product_code,
        name,
        price,
        raw: body,
    })
}

pub(in crate::routes::vendors) async fn send_tokovoucher_transaction(
    access: &TokovoucherAccess,
    product_code: &str,
    customer_no: &str,
    server_id: &str,
    ref_id: &str,
) -> TokovoucherTransactionResult {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{}:{}",
            access.credentials.username, access.credentials.secret, ref_id
        ))
    );
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/transaksi",
            access.base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({
            "ref_id": ref_id,
            "produk": product_code,
            "tujuan": customer_no,
            "server_id": server_id,
            "member_code": access.credentials.username,
            "signature": signature,
        }))
        .send()
        .await;

    let Ok(response) = response else {
        return TokovoucherTransactionResult {
            status: "failed".to_string(),
            message: "Connection Error".to_string(),
            sn: None,
            raw: serde_json::json!({ "message": "Connection Error" }),
        };
    };

    if !response.status().is_success() {
        return TokovoucherTransactionResult {
            status: "failed".to_string(),
            message: "Tokovoucher request failed".to_string(),
            sn: None,
            raw: serde_json::json!({ "message": "Tokovoucher request failed" }),
        };
    }
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(_) => {
            return TokovoucherTransactionResult {
                status: "failed".to_string(),
                message: "Invalid Tokovoucher response".to_string(),
                sn: None,
                raw: serde_json::json!({ "message": "Invalid Tokovoucher response" }),
            };
        }
    };
    let data = body.get("data").unwrap_or(&body);
    TokovoucherTransactionResult {
        status: map_tokovoucher_purchase_status(data.get("status").and_then(Value::as_str)),
        message: data
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .unwrap_or("Transaksi dikirim ke Tokovoucher")
            .to_string(),
        sn: data
            .get("sn")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        raw: body,
    }
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| {
            value.as_f64().and_then(|number| {
                if number.is_finite() && number.fract() == 0.0 {
                    Some(number as i64)
                } else {
                    None
                }
            })
        })
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

fn map_tokovoucher_purchase_status(value: Option<&str>) -> String {
    let normalized = value.unwrap_or_default().to_lowercase();
    if normalized.contains("sukses") || normalized.contains("success") {
        "success".to_string()
    } else if normalized.contains("gagal")
        || normalized.contains("failed")
        || normalized.contains("error")
    {
        "failed".to_string()
    } else if normalized.is_empty() {
        "pending".to_string()
    } else {
        "pending".to_string()
    }
}

pub(super) async fn fetch_tokovoucher_list(
    access: &TokovoucherAccess,
    path: &str,
    extra_query: Vec<(&'static str, String)>,
) -> Vec<Value> {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{}",
            access.credentials.username, access.credentials.secret
        ))
    );
    let mut request = reqwest::Client::new()
        .get(format!("{}{}", access.base_url.trim_end_matches('/'), path))
        .query(&[
            ("member_code", access.credentials.username.as_str()),
            ("signature", signature.as_str()),
        ]);
    for (key, value) in &extra_query {
        request = request.query(&[(key, value.as_str())]);
    }
    let Ok(response) = request.send().await else {
        return Vec::new();
    };
    let Ok(body) = response.json::<Value>().await else {
        return Vec::new();
    };
    if body.get("status").and_then(Value::as_i64) == Some(1) {
        return body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn serve_once(response: &'static str, delay: Duration) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            std::thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn digiflazz_balance_probe_rejects_missing_balance_and_times_out() {
        let credentials = VendorCredentials {
            username: "fixture".into(),
            secret: "fixture".into(),
        };
        let malformed = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
            Duration::ZERO,
        );
        assert!(
            fetch_digiflazz_balance_with_timeout(&credentials, &malformed, Duration::from_secs(1))
                .await
                .is_err()
        );

        let slow = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":1000000}}",
            Duration::from_millis(100),
        );
        let error =
            fetch_digiflazz_balance_with_timeout(&credentials, &slow, Duration::from_millis(10))
                .await
                .unwrap_err();
        assert!(error.contains("timeout"));
    }

    #[tokio::test]
    async fn both_provider_probes_accept_numeric_balances_only() {
        let credentials = VendorCredentials {
            username: "fixture".into(),
            secret: "fixture".into(),
        };
        let digiflazz = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":1000000}}",
            Duration::ZERO,
        );
        assert_eq!(
            fetch_digiflazz_balance_with_timeout(&credentials, &digiflazz, Duration::from_secs(1))
                .await
                .unwrap(),
            serde_json::json!(1000000),
        );

        let tokovoucher = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"data\":{\"saldo\":2000000}}",
            Duration::ZERO,
        );
        assert_eq!(
            fetch_tokovoucher_balance_with_timeout(
                &credentials,
                &tokovoucher,
                Duration::from_secs(1)
            )
            .await
            .unwrap(),
            serde_json::json!(2000000),
        );

        let invalid = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":\"unknown\"}}",
            Duration::ZERO,
        );
        assert!(
            fetch_digiflazz_balance_with_timeout(&credentials, &invalid, Duration::from_secs(1))
                .await
                .is_err()
        );

        let rejected = serve_once(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno",
            Duration::ZERO,
        );
        assert!(
            fetch_tokovoucher_balance_with_timeout(
                &credentials,
                &rejected,
                Duration::from_secs(1)
            )
            .await
            .is_err()
        );
    }
}
