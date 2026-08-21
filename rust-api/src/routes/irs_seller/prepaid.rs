use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, response::IntoResponse, response::Response, Json};
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::{json, Value};

use crate::{
    state::AppState,
    utils::bson::{read_i64, read_string},
};

use super::types::{constant_time_required_match, text_value};
use super::{client_ip, ip_matches_rule, string_array, IRS_PROVIDER};

use super::settings::stored_config;

pub async fn prepaid(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let Some(client) = &state.mongo_client else {
        return irs_response("-", "-", "-", "2", "", "Layanan IRS Seller tidak tersedia");
    };
    let db = client.database(&state.mongo_db);
    let config = match stored_config(&db).await {
        Ok(config) => config.unwrap_or_default(),
        Err(_) => {
            return irs_response("-", "-", "-", "2", "", "Layanan IRS Seller tidak tersedia");
        }
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
    let raw_preview = mongodb::bson::to_bson(&status_preview_doc(&payload)).unwrap_or(Bson::Null);
    let (status, code, msg, sn) = match parse_irs_status(&config, &raw_preview) {
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
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    let _ = db
        .collection::<Document>("irssellerorders")
        .insert_one(order_doc)
        .await;
    log_irs(&db, &ref_id, &status, &msg, true, &request_ip).await;
    irs_response(&ref_id, &produk, &tujuan, &code, &sn, &msg)
}

fn parse_irs_status(config: &Document, raw: &Bson) -> Option<(String, String, String, String)> {
    let formatter = config.get_document("formatter").ok()?;
    let text = match raw {
        Bson::String(s) => s.clone(),
        Bson::Document(d) => {
            serde_json::to_string(&bson_json_preview(Bson::Document(d.clone()))).unwrap_or_default()
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

fn bson_json_preview(value: Bson) -> Value {
    match value {
        Bson::String(value) => Value::String(value),
        Bson::Double(value) => json!(value),
        Bson::Document(document) => Value::Object(
            document
                .into_iter()
                .map(|(key, value)| (key, bson_json_preview(value)))
                .collect(),
        ),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_json_preview).collect()),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => json!(value),
        Bson::Int64(value) => json!(value),
        Bson::Null => Value::Null,
        other => Value::String(other.to_string()),
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
    constant_time_required_match(
        Some(payload),
        config,
        &["merchant_id", "merchantId", "username", "user"],
        "merchantId",
    ) && constant_time_required_match(Some(payload), config, &["pass", "password"], "password")
        && constant_time_required_match(Some(payload), config, &["pin"], "pin")
        && constant_time_required_match(Some(payload), config, &["secret", "sign", "id"], "secret")
}

/// Preview document containing only the two safe status fields read by the
/// legacy formatter path; credentials never enter the preview.
fn status_preview_doc(payload: &Value) -> Value {
    json!({
        "status": payload.get("status").cloned().unwrap_or(Value::Null),
    })
}
