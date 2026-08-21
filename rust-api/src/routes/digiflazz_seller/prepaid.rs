use std::sync::Arc;

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::Value;

use crate::{
    routes::{
        transactions::{provider::top_up_vendor, types::RecheckProduct},
        validation_engine::{product_validation_config, run_paid_validation, PaidValidationStatus},
    },
    state::AppState,
    utils::bson::read_i64,
};

use super::{
    document_string, is_valid_pulsa_code, non_negative_i64, optional_i64, seller_config,
    send_seller_callback, text_from_value, unavailable, SellerConfig, SellerPrepaidPayload,
};

pub async fn prepaid(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SellerPrepaidPayload>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let config = seller_config(&db).await;
    let request_ip = client_ip(&headers);
    let ref_id = payload
        .ref_id
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default();
    let pulsa_code = payload
        .pulsa_code
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default()
        .to_lowercase();
    let hp = payload.hp.as_ref().map(text_from_value).unwrap_or_default();
    let price = non_negative_i64(payload.price.as_ref(), 0);
    let sign = payload
        .sign
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default();
    let username = payload
        .username
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default();
    let commands = payload
        .commands
        .as_ref()
        .map(text_from_value)
        .unwrap_or_default()
        .to_lowercase();

    if !config.allowed_ips.is_empty()
        && !config
            .allowed_ips
            .iter()
            .any(|ip| super::ip_matches_rule(&request_ip, ip))
    {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "204",
            "Wrong authentication",
            "rejected",
            format!("IP {request_ip} tidak termasuk whitelist"),
            false,
        )
        .await;
    }

    if config.username.is_empty() || config.api_key.is_empty() {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "204",
            "Wrong authentication",
            "rejected",
            "Konfigurasi Digiflazz Seller belum lengkap".to_string(),
            false,
        )
        .await;
    }

    if ref_id.is_empty() || username.is_empty() || sign.is_empty() {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "204",
            "Wrong authentication",
            "rejected",
            "Username, ref_id, atau sign tidak valid".to_string(),
            false,
        )
        .await;
    }

    if username != config.username
        || !verify_digiflazz_seller_request(&config.username, &config.api_key, &ref_id, &sign)
    {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "204",
            "Wrong authentication",
            "rejected",
            "Verifikasi signature Digiflazz Seller gagal".to_string(),
            false,
        )
        .await;
    }

    if commands != "topup" {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "07",
            "Unsupported command",
            "failed",
            format!(
                "Command {} tidak didukung",
                if commands.is_empty() { "-" } else { &commands }
            ),
            true,
        )
        .await;
    }

    if let Some(response) =
        reply_with_existing_seller_order(&db, &state, &config, &request_ip, &ref_id).await
    {
        return response;
    }

    if pulsa_code.is_empty() || !is_valid_pulsa_code(&pulsa_code) {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "20",
            "Code not found",
            "failed",
            "Pulsa code tidak valid".to_string(),
            true,
        )
        .await;
    }

    if hp.is_empty() || !is_valid_target(&hp) {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "14",
            "Incorrect destination number",
            "failed",
            "Nomor tujuan tidak valid".to_string(),
            true,
        )
        .await;
    }

    let Some(mapping) = db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find_one(doc! { "pulsaCode": &pulsa_code })
        .await
        .ok()
        .flatten()
    else {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "20",
            "Code not found",
            "failed",
            "Mapping pulsa code tidak ditemukan".to_string(),
            true,
        )
        .await;
    };
    let Some(product_id) = mapping.get_object_id("product").ok() else {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "20",
            "Code not found",
            "failed",
            "Mapping pulsa code tidak ditemukan".to_string(),
            true,
        )
        .await;
    };
    let Some(product) = db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten()
    else {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "20",
            "Code not found",
            "failed",
            "Mapping pulsa code tidak ditemukan".to_string(),
            true,
        )
        .await;
    };
    let effective_price = seller_price(&product, &mapping, &config);
    if mapping.get_bool("isActive").unwrap_or(false) != true
        || product.get_bool("status").ok() == Some(false)
    {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "106",
            "Product is temporarily out of service",
            "failed",
            "Produk sedang nonaktif".to_string(),
            true,
        )
        .await;
    }
    if price > 0 && price != effective_price {
        return reject(
            &db,
            &config,
            &request_ip,
            &ref_id,
            &pulsa_code,
            &hp,
            price,
            "07",
            "Price mismatch",
            "failed",
            format!("Harga request {price} tidak sama dengan harga seller {effective_price}"),
            true,
        )
        .await;
    }

    let tr_id = generate_seller_ref_id(&db).await;
    let vendor_name = product
        .get_document("vendor")
        .ok()
        .map(|vendor| document_string(vendor, "name"))
        .unwrap_or_default();
    let vendor_sku = product
        .get_document("vendor")
        .ok()
        .map(|vendor| document_string(vendor, "sku"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| document_string(&product, "code"));
    let now = DateTime::now();
    let mut order_doc = doc! {
        "refId": &ref_id,
        "trId": &tr_id,
        "mapping": mapping.get_object_id("_id").unwrap_or_else(|_| ObjectId::new()),
        "product": product_id,
        "pulsaCode": &pulsa_code,
        "target": &hp,
        "digiflazzPrice": effective_price,
        "status": "pending",
        "rc": "39",
        "message": "Process",
        "vendorName": &vendor_name,
        "vendorSku": &vendor_sku,
        "vendorTrxId": &tr_id,
        "requestIp": &request_ip,
        "callbackRequired": config.callback_enabled,
        "callbackAttemptCount": 0_i64,
        "callbackLastMessage": "",
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    let insert_result = db
        .collection::<Document>("digiflazzsellerorders")
        .insert_one(order_doc.clone())
        .await;
    let order_id = match insert_result {
        Ok(result) => result
            .inserted_id
            .as_object_id()
            .unwrap_or_else(ObjectId::new),
        Err(_) => {
            if let Some(response) =
                reply_with_existing_seller_order(&db, &state, &config, &request_ip, &ref_id)
                    .await
            {
                return response;
            }
            return Json(build_error_response(
                &ref_id,
                &pulsa_code,
                &hp,
                price,
                "07",
                "Failed",
                &config,
            ))
            .into_response();
        }
    };
    order_doc.insert("_id", order_id);

    if let Some(validation_config) = product_validation_config(&product) {
        let (validation_target, validation_secondary_target) =
            validation_targets_from_seller_hp(&hp);
        let validation_result = run_paid_validation(
            &validation_config,
            &validation_target,
            &validation_secondary_target,
        )
        .await;
        let (status, message, sn) = match validation_result.status {
            PaidValidationStatus::Success => (
                "success",
                Some(validation_result.message.as_str()),
                validation_result.sn.as_deref(),
            ),
            PaidValidationStatus::Failed => {
                ("failed", Some(validation_result.message.as_str()), None)
            }
            PaidValidationStatus::ProviderError => {
                ("pending", Some(validation_result.message.as_str()), None)
            }
        };
        let updated =
            update_seller_order_status(&db, order_id, status, None, message, sn, Some(&tr_id))
                .await
                .unwrap_or(order_doc);
        let _ = db
            .collection::<Document>("digiflazzsellerorders")
            .update_one(
                doc! { "_id": order_id },
                doc! { "$set": { "validationOrder": true, "updatedAt": DateTime::now() } },
            )
            .await;
        let updated = db
            .collection::<Document>("digiflazzsellerorders")
            .find_one(doc! { "_id": order_id })
            .await
            .ok()
            .flatten()
            .unwrap_or(updated);
        maybe_send_status_callback(&db, &updated).await;
        log_seller_request(
            &db,
            &ref_id,
            &document_string(&updated, "status"),
            &document_string(&updated, "message"),
            true,
            &request_ip,
        )
        .await;
        return Json(build_response_from_order(&updated, &config)).into_response();
    }

    if vendor_name.is_empty() || vendor_sku.is_empty() {
        let updated = update_seller_order_status(
            &db,
            order_id,
            "failed",
            Some("106"),
            Some("Product is temporarily out of service"),
            None,
            None,
        )
        .await
        .unwrap_or(order_doc);
        maybe_send_status_callback(&db, &updated).await;
        log_seller_request(
            &db,
            &ref_id,
            "failed",
            "Produk belum punya vendor supplier yang bisa diproses",
            true,
            &request_ip,
        )
        .await;
        return Json(build_response_from_order(&updated, &config)).into_response();
    }

    let recheck_product = RecheckProduct {
        code: document_string(&product, "code"),
        vendor_name: vendor_name.clone(),
        vendor_sku: vendor_sku.clone(),
    };
    let updated = match top_up_vendor(&state, &tr_id, &hp, "", &recheck_product).await {
        Ok(result) => {
            let message = result.message.as_deref();
            update_seller_order_status(
                &db,
                order_id,
                &result.status,
                None,
                message,
                result.sn.as_deref(),
                result.vendor_trx_id.as_deref().or(Some(&tr_id)),
            )
            .await
            .unwrap_or(order_doc)
        }
        Err(_) => update_seller_order_status(
            &db,
            order_id,
            "failed",
            Some("07"),
            Some("Failed"),
            None,
            None,
        )
        .await
        .unwrap_or(order_doc),
    };
    maybe_send_status_callback(&db, &updated).await;
    log_seller_request(
        &db,
        &ref_id,
        &document_string(&updated, "status"),
        &document_string(&updated, "message"),
        true,
        &request_ip,
    )
    .await;
    Json(build_response_from_order(&updated, &config)).into_response()
}

fn verify_digiflazz_seller_request(
    username: &str,
    api_key: &str,
    ref_id: &str,
    provided: &str,
) -> bool {
    let expected = format!("{:x}", md5::compute(format!("{username}{api_key}{ref_id}")));
    constant_time_eq(expected.as_bytes(), provided.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right.iter())
        .fold(0_u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

async fn reply_with_existing_seller_order(
    db: &mongodb::Database,
    state: &AppState,
    config: &SellerConfig,
    request_ip: &str,
    ref_id: &str,
) -> Option<Response> {
    let existing = db
        .collection::<Document>("digiflazzsellerorders")
        .find_one(doc! { "refId": ref_id })
        .await
        .ok()
        .flatten()?;
    let mut latest = existing.clone();
    if document_string(&existing, "status") == "pending"
        && !existing.get_bool("validationOrder").unwrap_or(false)
        && !document_string(&existing, "vendorName").is_empty()
    {
        let product = RecheckProduct {
            code: document_string(&existing, "pulsaCode"),
            vendor_name: document_string(&existing, "vendorName"),
            vendor_sku: document_string(&existing, "vendorSku"),
        };
        if let Ok(result) = top_up_vendor(
            state,
            &document_string(&existing, "trId"),
            &document_string(&existing, "target"),
            "",
            &product,
        )
        .await
        {
            if let Ok(order_id) = existing.get_object_id("_id") {
                latest = update_seller_order_status(
                    db,
                    order_id,
                    &result.status,
                    None,
                    result.message.as_deref(),
                    result.sn.as_deref(),
                    result.vendor_trx_id.as_deref(),
                )
                .await
                .unwrap_or(existing.clone());
                maybe_send_status_callback(db, &latest).await;
            }
        }
    }
    log_seller_request(
        db,
        ref_id,
        &document_string(&latest, "status"),
        "Status order dikembalikan dari data existing",
        true,
        request_ip,
    )
    .await;
    Some(Json(build_response_from_order(&latest, config)).into_response())
}

async fn maybe_send_status_callback(db: &mongodb::Database, order: &Document) {
    if document_string(order, "status") != "pending"
        && order.get_bool("callbackRequired").unwrap_or(false)
    {
        let _ = send_seller_callback(db, order).await;
    }
}

async fn update_seller_order_status(
    db: &mongodb::Database,
    order_id: ObjectId,
    status: &str,
    rc: Option<&str>,
    message: Option<&str>,
    sn: Option<&str>,
    vendor_trx_id: Option<&str>,
) -> Option<Document> {
    let (_, default_rc, default_message) = status_shape(status, rc, message);
    let now = DateTime::now();
    let mut set_doc = doc! {
        "status": status,
        "rc": default_rc,
        "message": default_message,
        "updatedAt": now,
    };
    if let Some(sn) = sn {
        set_doc.insert("sn", sn);
    }
    if let Some(vendor_trx_id) = vendor_trx_id {
        set_doc.insert("vendorTrxId", vendor_trx_id);
    }
    let updated = db
        .collection::<Document>("digiflazzsellerorders")
        .find_one_and_update(doc! { "_id": order_id }, doc! { "$set": set_doc })
        .return_document(mongodb::options::ReturnDocument::After)
        .await
        .ok()
        .flatten()?;
    Some(updated)
}

async fn reject(
    db: &mongodb::Database,
    config: &SellerConfig,
    request_ip: &str,
    ref_id: &str,
    pulsa_code: &str,
    hp: &str,
    price: i64,
    rc: &str,
    message: &str,
    status: &str,
    log_message: String,
    verified: bool,
) -> Response {
    log_seller_request(
        db,
        if ref_id.is_empty() { "-" } else { ref_id },
        status,
        &log_message,
        verified,
        request_ip,
    )
    .await;
    Json(build_error_response(
        ref_id, pulsa_code, hp, price, rc, message, config,
    ))
    .into_response()
}

fn build_error_response(
    ref_id: &str,
    pulsa_code: &str,
    target: &str,
    price: i64,
    rc: &str,
    message: &str,
    config: &SellerConfig,
) -> Value {
    build_response(
        ref_id.if_empty("-"),
        ref_id.if_empty("-"),
        pulsa_code,
        target,
        price,
        "failed",
        rc,
        message,
        "",
        config.reported_balance,
    )
}

fn build_response_from_order(order: &Document, config: &SellerConfig) -> Value {
    build_response(
        &document_string(order, "refId"),
        &document_string(order, "trId"),
        &document_string(order, "pulsaCode"),
        &document_string(order, "target"),
        read_i64(order, "digiflazzPrice"),
        &document_string(order, "status"),
        &document_string(order, "rc"),
        &document_string(order, "message"),
        &document_string(order, "sn"),
        config.reported_balance,
    )
}

fn build_response(
    ref_id: &str,
    tr_id: &str,
    pulsa_code: &str,
    target: &str,
    price: i64,
    status: &str,
    rc: &str,
    message: &str,
    sn: &str,
    balance: i64,
) -> Value {
    let (status_code, default_rc, default_message) = status_shape(status, Some(rc), Some(message));
    serde_json::json!({
        "data": {
            "ref_id": ref_id,
            "status": status_code,
            "code": pulsa_code,
            "hp": target,
            "price": price.to_string(),
            "message": default_message,
            "balance": balance.to_string(),
            "tr_id": tr_id,
            "rc": default_rc,
            "sn": sn,
        }
    })
}

fn status_shape(
    status: &str,
    rc: Option<&str>,
    message: Option<&str>,
) -> (&'static str, String, String) {
    let status_code = if status == "success" {
        "1"
    } else if status == "failed" {
        "2"
    } else {
        "0"
    };
    let default_rc = match status {
        "success" => "00",
        "failed" => "07",
        _ => "39",
    };
    let default_message = match status {
        "success" => "Success",
        "failed" => "Failed",
        _ => "Process",
    };
    (
        status_code,
        rc.map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_rc)
            .to_string(),
        message
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_message)
            .to_string(),
    )
}

async fn log_seller_request(
    db: &mongodb::Database,
    ref_id: &str,
    status: &str,
    message: &str,
    verified: bool,
    request_ip: &str,
) {
    let document = crate::services::seller_secrecy::safe_seller_event_document(
        "digiflazz_seller",
        "request",
        ref_id,
        status,
        message,
        verified,
        request_ip,
    );
    let _ = db
        .collection::<Document>("webhookeventlogs")
        .insert_one(document)
        .await;
}

fn seller_price(product: &Document, mapping: &Document, config: &SellerConfig) -> i64 {
    let margin = optional_i64(mapping, "sellerMarginFlat").unwrap_or(config.seller_margin_flat);
    (read_i64(product, "costPrice") + margin).max(0)
}

fn is_valid_target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '+' | '|')
        })
}

fn validation_targets_from_seller_hp(value: &str) -> (String, String) {
    let mut parts = value.splitn(2, '|');
    let target = parts.next().unwrap_or_default().trim().to_string();
    let secondary_target = parts.next().unwrap_or_default().trim().to_string();
    (target, secondary_target)
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next_back())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}


async fn generate_seller_ref_id(_db: &mongodb::Database) -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(13)
        .map(char::from)
        .collect();
    format!("DS{suffix}")
}

trait EmptyFallback {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyFallback for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}
