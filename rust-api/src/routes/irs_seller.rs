use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::{json, Value};

use crate::{
    routes::auth::require_trusted_step_up_group,
    security::{require_proxy_context, ErrorResponse},
    state::AppState,
    utils::bson::{read_i64, read_string},
};

const CONFIG_KEY: &str = "irsSellerConfig";
const DEFAULT_ENDPOINT: &str = "https://v1.apigames.id/v2/transaksi-irs";
const DEFAULT_PREPAID_PATH: &str = "/v2/irs-seller/prepaid";

pub async fn settings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let config = stored_config(&db).await;
    let active_mappings = db
        .collection::<Document>("digiflazzsellerproductmaps")
        .count_documents(doc! { "isActive": true })
        .await
        .unwrap_or_default();
    let merchant_id = read_string(&config, "merchantId");
    let password = read_string(&config, "password");
    let pin = read_string(&config, "pin");
    let secret = read_string(&config, "secret");
    let configured =
        !merchant_id.is_empty() && !password.is_empty() && !pin.is_empty() && !secret.is_empty();
    Json(json!({
        "configured": configured,
        "ready": configured && active_mappings > 0,
        "enabled": config.get_bool("enabled").unwrap_or(false),
        "merchantId": merchant_id,
        "passwordMasked": mask_secret(&password),
        "pinMasked": mask_secret(&pin),
        "secretMasked": mask_secret(&secret),
        "endpointUrl": read_string(&config, "endpointUrl").if_empty(DEFAULT_ENDPOINT),
        "allowedIps": string_array(&config, "allowedIps"),
        "sellerMarginFlat": read_i64(&config, "sellerMarginFlat"),
        "callbackEnabled": config.get_bool("callbackEnabled").unwrap_or(false),
        "callbackUrl": read_string(&config, "callbackUrl"),
        "prepaidEndpointPath": DEFAULT_PREPAID_PATH,
        "mappingSummary": { "active": active_mappings },
    }))
    .into_response()
}

pub async fn save_settings(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    if let Err(response) = require_trusted_step_up_group(&headers, "integrations.credentials") {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let current = stored_config(&db).await;
    let value = doc! {
        "enabled": bool_value(&payload, "enabled").unwrap_or_else(|| current.get_bool("enabled").unwrap_or(false)),
        "merchantId": text_value(&payload, &["merchantId", "merchant_id"]).unwrap_or_else(|| read_string(&current, "merchantId")),
        "password": text_value(&payload, &["password", "pass"]).unwrap_or_else(|| read_string(&current, "password")),
        "pin": text_value(&payload, &["pin"]).unwrap_or_else(|| read_string(&current, "pin")),
        "secret": text_value(&payload, &["secret", "id"]).unwrap_or_else(|| read_string(&current, "secret")),
        "endpointUrl": text_value(&payload, &["endpointUrl"]).unwrap_or_else(|| read_string(&current, "endpointUrl")).if_empty(DEFAULT_ENDPOINT),
        "allowedIps": bson_array_value(&payload, "allowedIps").unwrap_or_else(|| current.get_array("allowedIps").cloned().unwrap_or_default()),
        "sellerMarginFlat": i64_value(&payload, "sellerMarginFlat").unwrap_or_else(|| read_i64(&current, "sellerMarginFlat")),
        "callbackEnabled": bool_value(&payload, "callbackEnabled").unwrap_or_else(|| current.get_bool("callbackEnabled").unwrap_or(false)),
        "callbackUrl": text_value(&payload, &["callbackUrl"]).unwrap_or_else(|| read_string(&current, "callbackUrl")),
        "formatter": payload.get("formatter").and_then(|value| mongodb::bson::to_bson(value).ok()).unwrap_or_else(default_formatter_bson),
        "updatedAt": DateTime::now(),
    };
    if db
        .collection::<Document>("settings")
        .update_one(
            doc! { "key": CONFIG_KEY },
            doc! { "$set": { "key": CONFIG_KEY, "value": value, "description": "Konfigurasi IRS Seller" } },
        )
        .upsert(true)
        .await
        .is_err()
    {
        return internal_error();
    }
    Json(json!({ "success": true, "message": "Konfigurasi IRS Seller berhasil disimpan" }))
        .into_response()
}

pub async fn mappings(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let docs = match db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find(doc! {})
        .sort(doc! { "updatedAt": -1 })
        .limit(200)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Json(json!({
        "items": docs.into_iter().map(document_json).collect::<Vec<_>>()
    }))
    .into_response()
}

pub async fn save_mapping(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(_payload): Json<Value>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(_client) = &state.mongo_client else {
        return unavailable();
    };
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "IRS Seller memakai mapping produk Digiflazz Seller",
    )
}

pub async fn delete_mapping(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(_id): Path<String>,
) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(_client) = &state.mongo_client else {
        return unavailable();
    };
    status_message(
        axum::http::StatusCode::BAD_REQUEST,
        "IRS Seller memakai mapping produk Digiflazz Seller",
    )
}

pub async fn admin_orders(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = recent_docs(
        &client.database(&state.mongo_db),
        "irssellerorders",
        doc! {},
    )
    .await;
    Json(json!({ "items": docs.into_iter().map(document_json).collect::<Vec<_>>() }))
        .into_response()
}

pub async fn logs(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    if let Err(response) = require_proxy_context(&headers, &state) {
        return response;
    }
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let docs = recent_docs(
        &client.database(&state.mongo_db),
        "webhookeventlogs",
        doc! { "provider": "irs_seller" },
    )
    .await;
    Json(json!(docs
        .into_iter()
        .map(document_json)
        .collect::<Vec<_>>()))
    .into_response()
}

pub async fn prepaid(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return irs_response("-", "-", "-", "2", "", "MONGO_URI is not configured");
    };
    let db = client.database(&state.mongo_db);
    let config = stored_config(&db).await;
    let ref_id = text_value(&payload, &["ref_id", "refId", "id_trx"]).unwrap_or_default();
    let produk = text_value(&payload, &["produk", "productCode", "kode_produk"])
        .unwrap_or_default()
        .to_lowercase();
    let tujuan = text_value(&payload, &["tujuan", "target", "hp"]).unwrap_or_default();
    let request_ip = client_ip(&headers);
    let raw_bson = mongodb::bson::to_bson(&payload).unwrap_or(Bson::Null);

    if ref_id.is_empty() || produk.is_empty() || tujuan.is_empty() {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "Field ref_id, produk, atau tujuan kosong",
            false,
            &request_ip,
            raw_bson,
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
            raw_bson,
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
            raw_bson,
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
            raw_bson,
        )
        .await;
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Wrong authentication");
    }
    if let Some(existing) = db
        .collection::<Document>("irssellerorders")
        .find_one(doc! { "refId": &ref_id })
        .await
        .ok()
        .flatten()
    {
        return response_from_order(&existing);
    }
    let Some(mapping) = db
        .collection::<Document>("digiflazzsellerproductmaps")
        .find_one(doc! { "pulsaCode": &produk, "isActive": true })
        .await
        .ok()
        .flatten()
    else {
        log_irs(
            &db,
            &ref_id,
            "failed",
            "Mapping produk Digiflazz Seller tidak ditemukan",
            true,
            &request_ip,
            raw_bson,
        )
        .await;
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan");
    };
    let Some(product_id) = mapping.get_object_id("product").ok() else {
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan");
    };
    let Some(product) = db
        .collection::<Document>("products")
        .find_one(doc! { "_id": product_id })
        .await
        .ok()
        .flatten()
    else {
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk tidak ditemukan");
    };
    if product.get_bool("status").ok() == Some(false) {
        return irs_response(&ref_id, &produk, &tujuan, "2", "", "Produk sedang nonaktif");
    }
    let now = DateTime::now();
    let (status, code, msg, sn) = match parse_irs_status(&config, &raw_bson) {
        Some(result) => result,
        None => (
            "pending".to_string(),
            "3".to_string(),
            "Pending".to_string(),
            "".to_string(),
        ),
    };
    let order_doc = doc! {
        "refId": &ref_id,
        "idTrx": &ref_id,
        "irsCode": &produk,
        "productCode": &produk,
        "target": &tujuan,
        "status": &status,
        "statusCode": &code,
        "message": &msg,
        "sn": &sn,
        "mapping": mapping.get_object_id("_id").unwrap_or_else(|_| ObjectId::new()),
        "product": product_id,
        "price": read_i64(&mapping, "price"),
        "requestIp": &request_ip,
        "rawRequest": raw_bson.clone(),
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    let _ = db
        .collection::<Document>("irssellerorders")
        .insert_one(order_doc)
        .await;
    log_irs(&db, &ref_id, &status, &msg, true, &request_ip, Bson::Null).await;
    irs_response(&ref_id, &produk, &tujuan, &code, &sn, &msg)
}

async fn stored_config(db: &mongodb::Database) -> Document {
    db.collection::<Document>("settings")
        .find_one(doc! { "key": CONFIG_KEY })
        .await
        .ok()
        .flatten()
        .and_then(|doc| doc.get_document("value").ok().cloned())
        .unwrap_or_default()
}

fn parse_irs_status(config: &Document, raw: &Bson) -> Option<(String, String, String, String)> {
    let formatter = config.get_document("formatter").ok()?;
    let text = match raw {
        Bson::String(s) => s.clone(),
        Bson::Document(d) => {
            serde_json::to_string(&bson_json(Bson::Document(d.clone()))).unwrap_or_default()
        }
        _ => raw.to_string(),
    };

    let status = raw_to_i64(raw, "status")
        .or_else(|| text_value_from_raw(raw, "status").and_then(|s| s.parse().ok()));
    if let Some(s) = status {
        return match s {
            1 => Some((
                "success".into(),
                "1".into(),
                "BERHASIL".into(),
                extract_sn(formatter, &text),
            )),
            2 => Some(("failed".into(), "2".into(), "GAGAL".into(), "".into())),
            3 => Some(("pending".into(), "3".into(), "PENDING".into(), "".into())),
            _ => None,
        };
    }

    for (keyword, (st, cd, mg)) in [
        ("BERHASIL", ("success", "1", "BERHASIL")),
        ("status\":1", ("success", "1", "BERHASIL")),
        ("GAGAL", ("failed", "2", "GAGAL")),
        ("saldo tidak cukup", ("failed", "2", "saldo tidak cukup")),
        ("invalid produk", ("failed", "2", "invalid produk")),
        ("Produk gangguan", ("failed", "2", "Produk gangguan")),
        ("PENDING", ("pending", "3", "PENDING")),
        ("Under proses", ("pending", "3", "Under proses")),
    ] {
        if text.contains(keyword) {
            return Some((
                st.into(),
                cd.into(),
                mg.into(),
                extract_sn(formatter, &text),
            ));
        }
    }
    None
}

fn extract_sn(formatter: &Document, text: &str) -> String {
    if let Ok(sn) = formatter.get_document("sn") {
        if let (Some(start), Some(end)) = (sn.get_str("start").ok(), sn.get_str("end").ok()) {
            if let Some(pos) = text.find(start) {
                let rest = &text[pos + start.len()..];
                if let Some(end_pos) = rest.find(end) {
                    return rest[..end_pos]
                        .trim_matches(|c: char| c == '"' || c == ',' || c.is_whitespace())
                        .to_string();
                }
            }
        }
    }
    "".to_string()
}

fn raw_to_i64(raw: &Bson, key: &str) -> Option<i64> {
    match raw {
        Bson::Document(d) => d
            .get_i64(key)
            .ok()
            .or(d.get_i32(key).ok().map(|v| v as i64)),
        _ => None,
    }
}

fn text_value_from_raw(raw: &Bson, key: &str) -> Option<String> {
    match raw {
        Bson::Document(d) => d.get_str(key).ok().map(|s| s.to_string()),
        _ => None,
    }
}

async fn recent_docs(db: &mongodb::Database, collection: &str, filter: Document) -> Vec<Document> {
    match db
        .collection::<Document>(collection)
        .find(filter)
        .sort(doc! { "createdAt": -1, "_id": -1 })
        .limit(100)
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<_>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn log_irs(
    db: &mongodb::Database,
    ref_id: &str,
    status: &str,
    message: &str,
    verified: bool,
    request_ip: &str,
    raw: Bson,
) {
    let _ = db
        .collection::<Document>("webhookeventlogs")
        .insert_one(doc! {
            "provider": "irs_seller",
            "event": "request",
            "refId": ref_id,
            "status": status,
            "message": message,
            "verified": verified,
            "requestIp": request_ip,
            "raw": raw,
            "createdAt": DateTime::now(),
            "updatedAt": DateTime::now(),
        })
        .await;
}

fn response_from_order(order: &Document) -> Response {
    let status = read_string(order, "status");
    let code = match status.as_str() {
        "success" => "1",
        "failed" => "2",
        _ => "3",
    };
    irs_response(
        &read_string(order, "refId"),
        &read_string(order, "irsCode"),
        &read_string(order, "target"),
        code,
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
    Json(json!({
        "data": {
            "ref_id": if ref_id.is_empty() { "-" } else { ref_id },
            "produk": if produk.is_empty() { "-" } else { produk },
            "tujuan": if tujuan.is_empty() { "-" } else { tujuan },
            "statuscode": statuscode,
            "sn": sn,
            "msg": msg,
        }
    }))
    .into_response()
}

fn valid_credentials(payload: &Value, config: &Document) -> bool {
    required_matches(
        payload,
        config,
        &["merchant_id", "merchantId", "username", "user"],
        "merchantId",
    ) && required_matches(payload, config, &["pass", "password"], "password")
        && required_matches(payload, config, &["pin"], "pin")
        && required_matches(payload, config, &["secret", "sign", "id"], "secret")
}

fn required_matches(
    payload: &Value,
    config: &Document,
    payload_keys: &[&str],
    config_key: &str,
) -> bool {
    let expected = read_string(config, config_key);
    if expected.is_empty() {
        return false;
    }
    text_value(payload, payload_keys)
        .map(|value| value == expected)
        .unwrap_or(false)
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

fn ip_matches_rule(client_ip: &str, rule: &str) -> bool {
    if client_ip == rule {
        return true;
    }
    let Some((range_ip, prefix)) = rule.split_once('/') else {
        return false;
    };
    let Ok(client) = client_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(range) = range_ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    if prefix > 32 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(client) & mask) == (u32::from(range) & mask)
}

fn document_json(document: Document) -> Value {
    bson_json(Bson::Document(document))
}

fn bson_json(value: Bson) -> Value {
    match value {
        Bson::String(value) => Value::String(value),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => json!(value),
        Bson::Int64(value) => json!(value),
        Bson::Double(value) => json!(value),
        Bson::DateTime(value) => Value::String(
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string()),
        ),
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::Document(document) => Value::Object(
            document
                .into_iter()
                .map(|(key, value)| (key, bson_json(value)))
                .collect(),
        ),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_json).collect()),
        Bson::Null => Value::Null,
        other => Value::String(other.to_string()),
    }
}

fn text_value(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(|value| match value {
                Value::String(value) => Some(value.trim().to_string()),
                Value::Number(value) => Some(value.to_string()),
                Value::Bool(value) => Some(value.to_string()),
                _ => None,
            })
            .filter(|value| !value.is_empty())
    })
}

fn bool_value(payload: &Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(|value| match value {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn i64_value(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(|value| match value {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn bson_array_value(payload: &Value, key: &str) -> Option<Vec<Bson>> {
    match payload.get(key)? {
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(|value| text_from_json(value).map(Bson::String))
                .collect(),
        ),
        Value::String(value) => Some(
            value
                .split([',', ';', '\n'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Bson::String(value.to_string()))
                .collect(),
        ),
        _ => None,
    }
}

fn text_from_json(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn string_array(document: &Document, key: &str) -> Vec<String> {
    document
        .get_array(key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else if value.len() <= 4 {
        "****".to_string()
    } else {
        format!(
            "{}****{}",
            &value[..2],
            &value[value.len().saturating_sub(2)..]
        )
    }
}

fn default_formatter_bson() -> Bson {
    mongodb::bson::to_bson(&json!({
        "id": "secret",
        "pin": "pin",
        "pass": "pass",
        "user": "merchant_id",
        "id_trx": "ref_id",
        "kode_produk": "produk",
        "tujuan": "tujuan",
        "cb_status_code": "statuscode",
        "cb_sn": "sn",
        "cb_msg": "msg"
    }))
    .unwrap_or(Bson::Null)
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn internal_error() -> Response {
    status_message(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
    )
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            message: "MONGO_URI is not configured",
        }),
    )
        .into_response()
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}
