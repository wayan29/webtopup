use mongodb::{
    bson::{doc, Bson, DateTime, Document},
    Database,
};
use serde_json::Value;

use crate::services::product_id::{
    allocate_product_id, classify_duplicate_key_constraint, is_duplicate_key,
    should_retry_duplicate_product_id_attempt, DuplicateKeyConstraint,
    MAX_PRODUCT_ID_INSERT_ATTEMPTS,
};
use crate::utils::bson::{read_i64, read_string};

use super::{
    json::value_to_bson,
    sync_pricing::{category_icon_for_label, sell_prices_from_cost, MembershipMargins},
    types::{TokovoucherAccess, VendorCredentials},
};

pub(in crate::routes::vendors) async fn fetch_digiflazz_balance_with_base_url(
    credentials: &VendorCredentials,
    base_url: &str,
) -> Value {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}{}depo",
            credentials.username, credentials.secret
        ))
    );
    let payload = serde_json::json!({
        "cmd": "deposit",
        "username": credentials.username,
        "sign": signature
    });

    let Ok(response) = reqwest::Client::new()
        .post(format!("{}/cek-saldo", base_url.trim_end_matches('/')))
        .json(&payload)
        .send()
        .await
    else {
        return Value::from(0);
    };

    let Ok(body) = response.json::<Value>().await else {
        return Value::from(0);
    };

    body.pointer("/data/deposit")
        .cloned()
        .unwrap_or(Value::from(0))
}

pub(in crate::routes::vendors) struct DigiflazzTransactionResult {
    pub status: String,
    pub message: String,
    pub sn: Option<String>,
    pub raw: Value,
}

pub(in crate::routes::vendors) async fn send_digiflazz_transaction(
    credentials: &VendorCredentials,
    base_url: &str,
    buyer_sku_code: &str,
    customer_no: &str,
    ref_id: &str,
) -> DigiflazzTransactionResult {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}{}{}",
            credentials.username, credentials.secret, ref_id
        ))
    );
    let payload = serde_json::json!({
        "username": credentials.username,
        "buyer_sku_code": buyer_sku_code,
        "customer_no": customer_no,
        "ref_id": ref_id,
        "sign": signature,
    });
    let response = reqwest::Client::new()
        .post(format!("{}/transaction", base_url.trim_end_matches('/')))
        .json(&payload)
        .send()
        .await;

    let Ok(response) = response else {
        return DigiflazzTransactionResult {
            status: "failed".to_string(),
            message: "Connection Error".to_string(),
            sn: None,
            raw: serde_json::json!({ "message": "Connection Error" }),
        };
    };

    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let data = body.get("data").unwrap_or(&body);
    DigiflazzTransactionResult {
        status: map_digiflazz_purchase_status(data.get("status").and_then(Value::as_str)),
        message: data
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| data.get("rc").and_then(Value::as_str))
            .unwrap_or("Transaksi dikirim ke Digiflazz")
            .to_string(),
        sn: data
            .get("sn")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        raw: body,
    }
}

fn map_digiflazz_purchase_status(value: Option<&str>) -> String {
    let normalized = value.unwrap_or_default().to_lowercase();
    if normalized.contains("sukses") || normalized.contains("success") {
        "success".to_string()
    } else if normalized.contains("gagal") || normalized.contains("failed") {
        "failed".to_string()
    } else {
        "pending".to_string()
    }
}

pub(super) async fn fetch_digiflazz_pricelist_remote(
    credentials: &VendorCredentials,
    base_url: &str,
) -> Vec<Document> {
    let signature = format!(
        "{:x}",
        md5::compute(format!(
            "{}{}pricelist",
            credentials.username, credentials.secret
        ))
    );
    let payload = serde_json::json!({
        "cmd": "prepaid",
        "username": credentials.username,
        "sign": signature
    });
    let Ok(response) = reqwest::Client::new()
        .post(format!("{}/price-list", base_url.trim_end_matches('/')))
        .json(&payload)
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = response.json::<Value>().await else {
        return Vec::new();
    };
    body.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .cloned()
                .filter_map(|value| match value_to_bson(value) {
                    Bson::Document(document) => Some(document),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) async fn sync_product_items(
    db: &Database,
    vendor_name: &str,
    items: Vec<Document>,
) -> Result<i64, String> {
    let products = db.collection::<Document>("products");
    let margins = load_membership_margins(db).await;
    let mut synced_count = 0;
    for item in items {
        let code = read_string(&item, "buyer_sku_code");
        if code.is_empty() {
            continue;
        }
        let name = read_string(&item, "product_name");
        let category = read_string(&item, "category");
        let brand = read_string(&item, "brand");
        // Digiflazz `price` is buyer cost, not MSRP.
        let cost_price = read_i64(&item, "price").max(0);
        let status = item.get_bool("seller_product_status").unwrap_or(false);
        let sell = sell_prices_from_cost(cost_price, margins);
        let price_doc = doc! {
            "basic": sell.basic,
            "gold": sell.gold,
            "platinum": sell.platinum,
        };
        let vendor_doc = doc! {
            "name": vendor_name,
            "sku": &code,
        };
        let taxonomy = ensure_product_taxonomy(db, &category, &brand).await?;

        let existing = products
            .find_one(doc! { "code": &code })
            .projection(doc! { "_id": 1 })
            .await
            .map_err(|error| error.to_string())?;
        if let Some(existing) = existing {
            let Some(existing_id) = existing.get_object_id("_id").ok() else {
                return Err("Invalid product id".to_string());
            };
            products
                .update_one(
                    doc! { "_id": existing_id },
                    doc! {
                        "$set": {
                            "name": name,
                            "category": taxonomy.category_name.clone(),
                            "categoryId": taxonomy.category_id,
                            "brand": brand,
                            "operatorId": taxonomy.operator_id,
                            "productTypeId": taxonomy.product_type_id,
                            "costPrice": cost_price,
                            "price": price_doc,
                            "vendor": vendor_doc,
                            "status": status,
                            "updatedAt": DateTime::now(),
                        }
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
        } else {
            let now = DateTime::now();
            insert_synced_product_with_allocated_id(
                db,
                &products,
                &code,
                &name,
                &taxonomy,
                &brand,
                cost_price,
                price_doc,
                vendor_doc,
                status,
                now,
            )
            .await?;
        }
        synced_count += 1;
    }
    Ok(synced_count)
}

#[derive(Clone)]
struct ProductTaxonomyIds {
    category_id: mongodb::bson::oid::ObjectId,
    category_name: String,
    operator_id: mongodb::bson::oid::ObjectId,
    product_type_id: mongodb::bson::oid::ObjectId,
}

async fn load_membership_margins(db: &Database) -> MembershipMargins {
    let settings = db.collection::<Document>("settings");
    let Ok(Some(document)) = settings
        .find_one(doc! { "key": "margins" })
        .projection(doc! { "value": 1 })
        .await
    else {
        return MembershipMargins::default();
    };
    let value = document.get_document("value").ok();
    MembershipMargins {
        basic: read_f64_margin(value, "basic", MembershipMargins::default().basic),
        gold: read_f64_margin(value, "gold", MembershipMargins::default().gold),
        platinum: read_f64_margin(value, "platinum", MembershipMargins::default().platinum),
    }
}

fn read_f64_margin(value: Option<&Document>, key: &str, fallback: f64) -> f64 {
    let Some(document) = value else {
        return fallback;
    };
    match document.get(key) {
        Some(Bson::Double(v)) if v.is_finite() && *v >= 0.0 => *v,
        Some(Bson::Int32(v)) if *v >= 0 => f64::from(*v),
        Some(Bson::Int64(v)) if *v >= 0 => *v as f64,
        _ => fallback,
    }
}

fn taxonomy_slug(value: &str) -> Option<String> {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

async fn ensure_product_taxonomy(
    db: &Database,
    category_label: &str,
    brand: &str,
) -> Result<ProductTaxonomyIds, String> {
    let category_name = if category_label.trim().is_empty() {
        "Lainnya".to_string()
    } else {
        category_label.trim().to_string()
    };
    let operator_name = if brand.trim().is_empty() {
        "Umum".to_string()
    } else {
        brand.trim().to_string()
    };
    let category_id = ensure_category(db, &category_name).await?;
    let operator_id = ensure_operator(db, category_id, &operator_name).await?;
    let product_type_id = ensure_default_product_type(db, category_id, operator_id).await?;
    Ok(ProductTaxonomyIds {
        category_id,
        category_name,
        operator_id,
        product_type_id,
    })
}

async fn ensure_category(db: &Database, name: &str) -> Result<mongodb::bson::oid::ObjectId, String> {
    let categories = db.collection::<Document>("categories");
    let Some(slug) = taxonomy_slug(name) else {
        return Err(format!("invalid category name for slug: {name}"));
    };
    if let Some(existing) = categories
        .find_one(doc! {
            "$or": [
                { "slug": &slug },
                { "name": { "$regex": format!("^{}$", regex_escape(name)), "$options": "i" } }
            ]
        })
        .projection(doc! { "_id": 1 })
        .await
        .map_err(|error| error.to_string())?
    {
        return existing
            .get_object_id("_id")
            .map_err(|error| error.to_string());
    }
    let now = DateTime::now();
    let sort_order = next_sort_order(&categories, doc! {}).await?;
    let category_numeric_id = next_numeric_id(&categories, "categoryId").await?;
    let insert = categories
        .insert_one(doc! {
            "categoryId": category_numeric_id,
            "name": name,
            "slug": slug,
            "icon": category_icon_for_label(name),
            "sortOrder": sort_order,
            "status": true,
            "createdAt": now,
            "updatedAt": now,
        })
        .await
        .map_err(|error| error.to_string())?;
    match insert.inserted_id {
        Bson::ObjectId(id) => Ok(id),
        other => Err(format!("unexpected category insert id: {other:?}")),
    }
}

async fn ensure_operator(
    db: &Database,
    category_id: mongodb::bson::oid::ObjectId,
    name: &str,
) -> Result<mongodb::bson::oid::ObjectId, String> {
    let operators = db.collection::<Document>("operators");
    let Some(slug) = taxonomy_slug(name) else {
        return Err(format!("invalid operator name for slug: {name}"));
    };
    // Prefer same category + slug, else any matching name/slug so we don't fork brands.
    if let Some(existing) = operators
        .find_one(doc! {
            "$or": [
                { "slug": &slug, "categoryId": category_id },
                { "slug": &slug },
                { "name": { "$regex": format!("^{}$", regex_escape(name)), "$options": "i" } }
            ]
        })
        .projection(doc! { "_id": 1 })
        .await
        .map_err(|error| error.to_string())?
    {
        return existing
            .get_object_id("_id")
            .map_err(|error| error.to_string());
    }
    let now = DateTime::now();
    let sort_order = next_sort_order(&operators, doc! { "categoryId": category_id }).await?;
    let operator_id = next_numeric_id(&operators, "operatorId").await?;
    let insert = operators
        .insert_one(doc! {
            "operatorId": operator_id,
            "name": name,
            "slug": slug,
            "categoryId": category_id,
            "icon": "",
            "instructionImage": "",
            "checkUsername": false,
            "usernameLabel": "",
            "validationType": "none",
            "description": "",
            "isCustomProduct": false,
            "userIdLabel": "Nomor / User ID",
            "userIdType": "text",
            "hasServerId": false,
            "serverIdLabel": "Server ID",
            "serverIdDropdown": false,
            "serverIdType": "text",
            "serverOptions": [],
            "sortOrder": sort_order,
            "status": true,
            "createdAt": now,
            "updatedAt": now,
        })
        .await
        .map_err(|error| error.to_string())?;
    match insert.inserted_id {
        Bson::ObjectId(id) => Ok(id),
        other => Err(format!("unexpected operator insert id: {other:?}")),
    }
}

async fn ensure_default_product_type(
    db: &Database,
    category_id: mongodb::bson::oid::ObjectId,
    operator_id: mongodb::bson::oid::ObjectId,
) -> Result<mongodb::bson::oid::ObjectId, String> {
    let product_types = db.collection::<Document>("producttypes");
    let type_name = "Umum";
    let Some(slug) = taxonomy_slug(type_name) else {
        return Err("invalid default product type slug".to_string());
    };
    if let Some(existing) = product_types
        .find_one(doc! { "operatorId": operator_id, "slug": &slug })
        .projection(doc! { "_id": 1 })
        .await
        .map_err(|error| error.to_string())?
    {
        return existing
            .get_object_id("_id")
            .map_err(|error| error.to_string());
    }
    // Reuse any existing type on this operator if present (avoid empty operator shells).
    if let Some(existing) = product_types
        .find_one(doc! { "operatorId": operator_id, "status": true })
        .sort(doc! { "sortOrder": 1 })
        .projection(doc! { "_id": 1 })
        .await
        .map_err(|error| error.to_string())?
    {
        return existing
            .get_object_id("_id")
            .map_err(|error| error.to_string());
    }
    let now = DateTime::now();
    let sort_order = next_sort_order(&product_types, doc! { "operatorId": operator_id }).await?;
    let type_id = next_numeric_id(&product_types, "typeId").await?;
    let insert = product_types
        .insert_one(doc! {
            "typeId": type_id,
            "name": type_name,
            "slug": slug,
            "categoryId": category_id,
            "operatorId": operator_id,
            "icon": "",
            "cover": "",
            "openTime": "00:00",
            "closeTime": "23:59",
            "open24Hours": true,
            "estimatedDelivery": "",
            "processType": "auto",
            "description": "",
            "popupInfo": {
                "title": "",
                "content": "",
                "image": "",
                "buttonText": "",
                "buttonLink": "",
                "enabled": false,
            },
            "sortOrder": sort_order,
            "status": true,
            "createdAt": now,
            "updatedAt": now,
            "__v": 0,
        })
        .await
        .map_err(|error| error.to_string())?;
    match insert.inserted_id {
        Bson::ObjectId(id) => Ok(id),
        other => Err(format!("unexpected product type insert id: {other:?}")),
    }
}

async fn next_sort_order(
    collection: &mongodb::Collection<Document>,
    filter: Document,
) -> Result<i64, String> {
    Ok(collection
        .find_one(filter)
        .sort(doc! { "sortOrder": -1 })
        .projection(doc! { "sortOrder": 1 })
        .await
        .map_err(|error| error.to_string())?
        .map(|document| read_i64(&document, "sortOrder") + 1)
        .unwrap_or(0))
}

async fn next_numeric_id(
    collection: &mongodb::Collection<Document>,
    field: &str,
) -> Result<i64, String> {
    Ok(collection
        .find_one(doc! {})
        .sort(doc! { field: -1 })
        .projection(doc! { field: 1 })
        .await
        .map_err(|error| error.to_string())?
        .map(|document| read_i64(&document, field) + 1)
        .unwrap_or(1))
}

fn regex_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

async fn insert_synced_product_with_allocated_id(
    db: &Database,
    products: &mongodb::Collection<Document>,
    code: &str,
    name: &str,
    taxonomy: &ProductTaxonomyIds,
    brand: &str,
    cost_price: i64,
    price_doc: Document,
    vendor_doc: Document,
    status: bool,
    now: DateTime,
) -> Result<(), String> {
    for attempt in 0..MAX_PRODUCT_ID_INSERT_ATTEMPTS {
        let product_id = allocate_product_id(db)
            .await
            .map_err(|error| error.to_string())?;
        let document = doc! {
            "productId": product_id,
            "code": code,
            "name": name,
            "category": &taxonomy.category_name,
            "categoryId": taxonomy.category_id,
            "brand": brand,
            "operatorId": taxonomy.operator_id,
            "productTypeId": taxonomy.product_type_id,
            "costPrice": cost_price,
            "price": price_doc.clone(),
            "vendor": vendor_doc.clone(),
            "status": status,
            "createdAt": now,
            "updatedAt": now,
            "__v": 0,
        };
        match products.insert_one(document).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                if is_duplicate_key(&error) {
                    match classify_duplicate_key_constraint(&error) {
                        DuplicateKeyConstraint::ProductId => {
                            if should_retry_duplicate_product_id_attempt(attempt) {
                                continue;
                            }
                            return Err(format!(
                                "productId duplicate after max sync insert attempts (code={code})"
                            ));
                        }
                        DuplicateKeyConstraint::Code => {
                            return Err(format!(
                                "duplicate product code during vendor sync: {code}"
                            ));
                        }
                        DuplicateKeyConstraint::Unknown => {
                            return Err(format!(
                                "unknown duplicate key on vendor sync insert: {error}"
                            ));
                        }
                    }
                }
                return Err(error.to_string());
            }
        }
    }
    Err("vendor sync product insert exhausted retries".to_string())
}

pub(in crate::routes::vendors) async fn fetch_tokovoucher_balance_with_base_url(
    credentials: &VendorCredentials,
    base_url: &str,
) -> Result<Value, String> {
    let signature = format!(
        "{:x}",
        md5::compute(format!("{}:{}", credentials.username, credentials.secret))
    );
    let response = reqwest::Client::new()
        .get(format!("{}/member", base_url.trim_end_matches('/')))
        .query(&[
            ("member_code", credentials.username.as_str()),
            ("signature", signature.as_str()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;

    if let Some(balance) = body.pointer("/data/saldo") {
        return Ok(balance.clone());
    }
    if let Some(error_message) = body.get("error_msg").and_then(Value::as_str) {
        return Err(error_message.to_string());
    }

    Ok(Value::from(0))
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
