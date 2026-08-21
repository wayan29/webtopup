use std::sync::Arc;

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    options::ReturnDocument,
};
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};

use crate::{
    routes::{
        transactions::{provider::top_up_vendor, types::RecheckProduct},
        validation_engine::{product_validation_config, run_paid_validation, PaidValidationStatus},
    },
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::settings::stored_config;
use super::types::{constant_time_required_match, text_value};
use super::{client_ip, ip_matches_rule, string_array, IRS_PROVIDER};

const IRS_STORAGE_FAILURE_MESSAGE: &str = "Layanan IRS Seller tidak tersedia";
const IRS_EXECUTION_FAILURE_MESSAGE: &str = "Transaksi IRS gagal diproses";

pub async fn prepaid(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return irs_response("-", "-", "-", "2", "", IRS_STORAGE_FAILURE_MESSAGE);
    };
    let db = client.database(&state.mongo_db);
    let config = match stored_config(&db).await {
        Ok(config) => config.unwrap_or_default(),
        Err(_) => return irs_response("-", "-", "-", "2", "", IRS_STORAGE_FAILURE_MESSAGE),
    };
    let ref_id = text_value(&payload, &["ref_id", "refId", "id_trx"]).unwrap_or_default();
    let produk = text_value(&payload, &["produk", "productCode", "kode_produk"])
        .unwrap_or_default()
        .to_lowercase();
    let tujuan = text_value(&payload, &["tujuan", "target", "hp"]).unwrap_or_default();
    let request_ip = client_ip(&headers);

    if ref_id.is_empty() || produk.is_empty() || tujuan.is_empty() {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "Field ref_id, produk, atau tujuan kosong",
            false,
            &request_ip,
        )
        .await;
        return irs_response(
            &ref_id,
            &produk,
            &tujuan,
            "2",
            "",
            "Field ref_id, produk, atau tujuan wajib diisi",
        );
    }
    if !config.get_bool("enabled").unwrap_or(false) {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "IRS Seller belum aktif",
            false,
            &request_ip,
        )
        .await;
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "IRS Seller belum aktif");
    }
    let allowed_ips = string_array(&config, "allowedIps");
    if !allowed_ips.is_empty()
        && !allowed_ips
            .iter()
            .any(|ip| ip_matches_rule(&request_ip, ip))
    {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "IP tidak diizinkan",
            false,
            &request_ip,
        )
        .await;
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Wrong authentication");
    }
    if !valid_credentials(&payload, &config) {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "Credential IRS tidak valid",
            false,
            &request_ip,
        )
        .await;
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Wrong authentication");
    }

    let orders = db.collection::<Document>("irssellerorders");
    let existing = match orders.find_one(doc! { "refId": &ref_id }).await {
        Ok(existing) => existing,
        Err(_) => return irs_response(&ref_id, &produk, &tujuan, "2", "", IRS_STORAGE_FAILURE_MESSAGE),
    };
    if let Some(order) = existing {
        if irs_order_ready_for_claim(&order) {
            return execute_irs_order(&state, &db, order, &request_ip).await;
        }
        return irs_response_from_order(&order);
    }

    let mapping = match db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find_one(doc! { "pulsaCode": &produk, "isActive": true })
        .await
    {
        Ok(Some(mapping)) => mapping,
        Ok(None) => {
            log_irs(
                &db,
                &ref_id,
                "failed",
                "Mapping produk Digiflazz Seller tidak ditemukan",
                true,
                &request_ip,
            )
            .await;
            return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan");
        }
        Err(_) => {
            return irs_response(&ref_id, &produk, &tujuan, "2", "", IRS_STORAGE_FAILURE_MESSAGE)
        }
    };
    let Ok(product_id) = mapping.get_object_id("product") else {
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan");
    };
    let product = match db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .await
    {
        Ok(Some(product)) => product,
        Ok(None) => {
            return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan")
        }
        Err(_) => {
            return irs_response(&ref_id, &produk, &tujuan, "2", "", IRS_STORAGE_FAILURE_MESSAGE)
        }
    };
    if product.get_bool("status").ok() == Some(false) {
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk sedang nonaktif");
    }

    let internal_ref_id = generate_irs_ref_id();
    let vendor = product.get_document("vendor").ok();
    let vendor_name = vendor
        .map(|vendor| read_string(vendor, "name"))
        .unwrap_or_default();
    let vendor_sku = vendor
        .map(|vendor| read_string(vendor, "sku"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| read_string(&product, "code"));
    let validation_order = product_validation_config(&product).is_some();
    let now = DateTime::now();
    let mut order_doc = doc! {
        "refId": &ref_id,
        "internalRefId": &internal_ref_id,
        "irsCode": &produk,
        "productCode": &produk,
        "target": &tujuan,
        "status": "pending",
        "statusCode": "3",
        "message": "Pending",
        "sn": "",
        "mapping": mapping.get_object_id("_id").unwrap_or_else(|_| ObjectId::new()),
        "product": product_id,
        "price": read_i64(&mapping, "price"),
        "vendorName": &vendor_name,
        "vendorSku": &vendor_sku,
        "vendorTrxId": &internal_ref_id,
        "requestIp": &request_ip,
        "validationOrder": validation_order,
        "executionState": "ready",
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    let order_id = match orders.insert_one(order_doc.clone()).await {
        Ok(result) => result
            .inserted_id
            .as_object_id()
            .unwrap_or_else(ObjectId::new),
        Err(error) => {
            if !is_duplicate_key_error(&error) {
                return irs_response(
                    &ref_id,
                    &produk,
                    &tujuan,
                    "2",
                    "",
                    IRS_STORAGE_FAILURE_MESSAGE,
                );
            }
            let winner = match orders.find_one(doc! { "refId": &ref_id }).await {
                Ok(Some(winner)) => winner,
                _ => {
                    return irs_response(
                        &ref_id,
                        &produk,
                        &tujuan,
                        "2",
                        "",
                        IRS_STORAGE_FAILURE_MESSAGE,
                    )
                }
            };
            if irs_order_ready_for_claim(&winner) {
                return execute_irs_order(&state, &db, winner, &request_ip).await;
            }
            return irs_response_from_order(&winner);
        }
    };
    order_doc.insert("_id", order_id);
    execute_irs_order(&state, &db, order_doc, &request_ip).await
}

fn irs_order_ready_for_claim(order: &Document) -> bool {
    order.get_str("executionState").ok() == Some("ready")
}

async fn claim_irs_execution(
    db: &mongodb::Database,
    order_id: ObjectId,
) -> mongodb::error::Result<bool> {
    let claimed = db
        .collection::<Document>("irssellerorders")
        .find_one_and_update(
            doc! { "_id": order_id, "executionState": "ready" },
            doc! { "$set": { "executionState": "executing", "executionStartedAt": DateTime::now(), "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await?;
    Ok(claimed.is_some())
}

async fn execute_irs_order(
    state: &Arc<AppState>,
    db: &mongodb::Database,
    order: Document,
    request_ip: &str,
) -> Response {
    let order_id = order
        .get_object_id("_id")
        .unwrap_or_else(|_| ObjectId::new());
    let ref_id = read_string(&order, "refId");
    let produk = read_string(&order, "irsCode");
    let tujuan = read_string(&order, "target");

    match claim_irs_execution(db, order_id).await {
        Ok(true) => {}
        Ok(false) => {
            let persisted = reload_irs_order(db, order_id).await;
            return match persisted {
                Some(order) => irs_response_from_order(&order),
                None => irs_response(&ref_id, &produk, &tujuan, "3", "", "Pending"),
            };
        }
        Err(_) => return irs_response(&ref_id, &produk, &tujuan, "2", "", IRS_STORAGE_FAILURE_MESSAGE),
    }

    // This request now owns the single execution for this refId.
    let internal_ref_id = read_string(&order, "internalRefId");
    let product = load_irs_order_product(db, &order).await;
    let (status, message, sn, vendor_trx_id) = if order.get_bool("validationOrder").unwrap_or(false)
    {
        match product {
            Some(product) => match product_validation_config(&product) {
                Some(validation_config) => {
                    let (target, secondary) = validation_targets_from_tujuan(&tujuan);
                    let result =
                        run_paid_validation(&validation_config, &target, &secondary).await;
                    match result.status {
                        PaidValidationStatus::Success => (
                            "success".to_string(),
                            result.message.clone(),
                            result.sn.clone().unwrap_or_default(),
                            Some(internal_ref_id.clone()),
                        ),
                        PaidValidationStatus::Failed => (
                            "failed".to_string(),
                            result.message.clone(),
                            String::new(),
                            Some(internal_ref_id.clone()),
                        ),
                        PaidValidationStatus::ProviderError => (
                            "pending".to_string(),
                            result.message.clone(),
                            String::new(),
                            Some(internal_ref_id.clone()),
                        ),
                    }
                }
                None => {
                    (
                        "failed".to_string(),
                        IRS_EXECUTION_FAILURE_MESSAGE.to_string(),
                        String::new(),
                        None,
                    )
                }
            },
            None => (
                "failed".to_string(),
                IRS_EXECUTION_FAILURE_MESSAGE.to_string(),
                String::new(),
                None,
            ),
        }
    } else {
        let vendor_name = read_string(&order, "vendorName");
        let vendor_sku = read_string(&order, "vendorSku");
        if vendor_name.is_empty() || vendor_sku.is_empty() {
            (
                "failed".to_string(),
                "Produk belum punya vendor supplier yang bisa diproses".to_string(),
                String::new(),
                None,
            )
        } else {
            let recheck = RecheckProduct {
                code: read_string(&order, "productCode"),
                vendor_name: vendor_name.clone(),
                vendor_sku: vendor_sku.clone(),
            };
            match top_up_vendor(state, &internal_ref_id, &tujuan, "", &recheck).await {
                Ok(result) => {
                    let message = result.message.unwrap_or_default();
                    let message = if message.is_empty() {
                        default_irs_message(&result.status)
                    } else {
                        message
                    };
                    let vendor_trx_id = result
                        .vendor_trx_id
                        .filter(|value| !value.is_empty())
                        .or(Some(internal_ref_id.clone()));
                    (
                        result.status,
                        message,
                        result.sn.unwrap_or_default(),
                        vendor_trx_id,
                    )
                }
                Err(_) => (
                    "failed".to_string(),
                    IRS_EXECUTION_FAILURE_MESSAGE.to_string(),
                    String::new(),
                    Some(internal_ref_id.clone()),
                ),
            }
        }
    };

    let Some(updated) =
        finalize_irs_execution(db, order_id, &status, &message, &sn, vendor_trx_id.as_deref()).await
    else {
        return irs_response(&ref_id, &produk, &tujuan, "3", "", "Pending");
    };
    log_irs(
        db,
        &read_string(&updated, "refId"),
        &read_string(&updated, "status"),
        &read_string(&updated, "message"),
        true,
        request_ip,
    )
    .await;
    irs_response_from_order(&updated)
}

async fn load_irs_order_product(
    db: &mongodb::Database,
    order: &Document,
) -> Option<Document> {
    let product_id = order.get_object_id("product").ok()?;
    db.collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten()
}

async fn reload_irs_order(db: &mongodb::Database, order_id: ObjectId) -> Option<Document> {
    db.collection::<Document>("irssellerorders")
        .find_one(doc! { "_id": order_id })
        .await
        .ok()
        .flatten()
}

async fn finalize_irs_execution(
    db: &mongodb::Database,
    order_id: ObjectId,
    status: &str,
    message: &str,
    sn: &str,
    vendor_trx_id: Option<&str>,
) -> Option<Document> {
    let now = DateTime::now();
    let mut set_doc = doc! {
        "status": status,
        "statusCode": irs_status_code(status),
        "message": message,
        "sn": sn,
        "executionState": "completed",
        "executionCompletedAt": now,
        "updatedAt": now,
    };
    if let Some(vendor_trx_id) = vendor_trx_id {
        set_doc.insert("vendorTrxId", vendor_trx_id);
    }
    db.collection::<Document>("irssellerorders")
        .find_one_and_update(doc! { "_id": order_id }, doc! { "$set": set_doc })
        .return_document(ReturnDocument::After)
        .await
        .ok()
        .flatten()
}

fn default_irs_message(status: &str) -> String {
    match status {
        "success" => "BERHASIL".to_string(),
        "failed" => "GAGAL".to_string(),
        _ => "Pending".to_string(),
    }
}

fn validation_targets_from_tujuan(value: &str) -> (String, String) {
    let mut parts = value.splitn(2, '|');
    let target = parts.next().unwrap_or_default().trim().to_string();
    let secondary_target = parts.next().unwrap_or_default().trim().to_string();
    (target, secondary_target)
}

fn generate_irs_ref_id() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(13)
        .map(char::from)
        .collect();
    format!("IRS{suffix}")
}

fn is_duplicate_key_error(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write)) => {
            write.code == 11000
        }
        _ => {
            let message = error.to_string();
            message.contains("E11000") || message.contains("duplicate key")
        }
    }
}

async fn log_irs(
    db: &mongodb::Database,
    ref_id: &str,
    status: &str,
    message: &str,
    verified: bool,
    request_ip: &str,
) {
    let _ = db
        .collection::<Document>("webhookeventlogs")
        .insert_one(crate::services::seller_secrecy::safe_seller_event_document(
            IRS_PROVIDER, "request", ref_id, status, message, verified, request_ip,
        ))
        .await;
}

pub(super) fn irs_status_code(status: &str) -> &'static str {
    match status {
        "success" => "1",
        "failed" => "2",
        _ => "3",
    }
}

pub(super) fn irs_response_from_order(order: &Document) -> Response {
    irs_response(
        &read_string(order, "refId"),
        &read_string(order, "irsCode"),
        &read_string(order, "target"),
        irs_status_code(&read_string(order, "status")),
        &read_string(order, "sn"),
        &read_string(order, "message"),
    )
}

fn irs_response(
    ref_id: &str,
    produk: &str,
    tujuan: &str,
    statuscode: &str,
    sn: &str,
    msg: &str,
) -> Response {
    Json(irs_response_value(ref_id, produk, tujuan, statuscode, sn, msg)).into_response()
}

pub(super) fn irs_response_value(
    ref_id: &str,
    produk: &str,
    tujuan: &str,
    statuscode: &str,
    sn: &str,
    msg: &str,
) -> Value {
    json!({
        "data": {
            "ref_id": if ref_id.is_empty() { "-" } else { ref_id },
            "produk": if produk.is_empty() { "-" } else { produk },
            "tujuan": if tujuan.is_empty() { "-" } else { tujuan },
            "statuscode": statuscode,
            "sn": sn,
            "msg": msg,
        }
    })
}

fn valid_credentials(payload: &Value, config: &Document) -> bool {
    constant_time_required_match(
        Some(payload),
        config,
        &["merchant_id", "merchantId", "username", "user"],
        "merchantId",
    ) && constant_time_required_match(Some(payload), config, &["pass", "password"], "password")
        && constant_time_required_match(Some(payload), config, &["pin"], "pin")
        && constant_time_required_match(Some(payload), config, &["secret", "sign", "id"], "secret")
}

#[cfg(test)]
mod tests {
    #[test]
    fn irs_response_contract_fields_remain_exact() {
        let value = super::irs_response_value("ref-1", "sku-1", "0812", "1", "SN1", "BERHASIL");
        let keys = value["data"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            ["ref_id", "produk", "tujuan", "statuscode", "sn", "msg"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert_eq!(value["data"]["statuscode"], "1");
    }

    #[test]
    fn irs_status_code_maps_success_failed_pending_and_executing() {
        assert_eq!(super::irs_status_code("success"), "1");
        assert_eq!(super::irs_status_code("failed"), "2");
        assert_eq!(super::irs_status_code("pending"), "3");
        assert_eq!(super::irs_status_code("executing"), "3");
    }

    #[test]
    fn supplier_call_is_after_durable_execution_claim() {
        let source = include_str!("prepaid.rs");
        let production = source.split("\n#[cfg(test)]").next().unwrap();
        let claim = production.find("claim_irs_execution(").unwrap();
        let supplier = production.find("top_up_vendor(").unwrap();
        assert!(claim < supplier, "durable claim must precede supplier execution");
        assert_eq!(production.matches("top_up_vendor(").count(), 1);
    }

    #[test]
    fn production_never_persists_raw_request_or_stub_status_authority() {
        let source = include_str!("prepaid.rs");
        let production = source.split("\n#[cfg(test)]").next().unwrap();
        assert!(!production.contains("\"rawRequest\":"));
        assert!(!production.contains("parse_irs_status"));
    }

    #[test]
    fn execution_claim_filter_matches_ready_once() {
        let source = include_str!("prepaid.rs");
        let production = source.split("\n#[cfg(test)]").next().unwrap();
        assert!(production.contains("\"executionState\": \"ready\""));
        assert!(production.contains("\"executionState\": \"executing\""));
        assert!(production.contains("\"executionState\": \"completed\""));
        assert!(
            !production.contains("\"executing\", \"ready\""),
            "executing must never roll back to ready"
        );
    }
}
