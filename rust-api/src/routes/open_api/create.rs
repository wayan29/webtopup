use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime, Document},
    options::ReturnDocument,
};
use rand::{distributions::Alphanumeric, Rng};

use crate::{
    routes::{
        transactions::{provider::top_up_vendor, types::RecheckProduct},
        validation_engine::{product_validation_config, run_paid_validation, PaidValidationStatus},
    },
    security::require_proxy_context,
    state::AppState,
    utils::bson::{escape_regex, read_i64, read_string},
};

use super::{
    responses::{api_error, unavailable},
    types::{ApiCreateTransactionData, ApiCreateTransactionPayload, ApiCreateTransactionResponse},
    utils::{date_string, id_value},
};

pub async fn create_transaction(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ApiCreateTransactionPayload>,
) -> Response {
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid API key");
    };
    let product_code = payload
        .product_code
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let target = payload
        .target
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let server_id = payload
        .server_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_default();
    let customer_ref_id = payload
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if product_code.is_empty() || target.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "product_code and target are required",
        );
    }

    let db = client.database(&state.mongo_db);
    let users = db.collection::<Document>("users");
    let products = db.collection::<Document>("products");
    let transactions = db.collection::<Document>("transactions");

    let Some(user) = users
        .find_one(doc! { "_id": user_id, "role": "member", "active": { "$ne": false } })
        .await
        .ok()
        .flatten()
    else {
        return api_error(StatusCode::NOT_FOUND, "User not found");
    };
    let user_level = read_string(&user, "level").if_empty("basic").to_string();
    let Some(product) = products
        .find_one(doc! { "code": &product_code, "status": true })
        .await
        .ok()
        .flatten()
    else {
        return api_error(StatusCode::NOT_FOUND, "Product not found or unavailable");
    };
    let purchase_issues = product_purchase_issues(&db, &product).await;
    if !purchase_issues.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": format!("Product unavailable: {}", purchase_issues.join(", ")),
            })),
        )
            .into_response();
    }
    let price = product
        .get_document("price")
        .ok()
        .map(|price| read_i64(price, &user_level))
        .unwrap_or_default();
    if price <= 0 {
        return api_error(StatusCode::BAD_REQUEST, "Product not found or unavailable");
    }
    if let Some(ref_id) = customer_ref_id.as_deref() {
        if let Some(existing) = transactions
            .find_one(doc! { "customerRefId": ref_id, "user": user_id })
            .await
            .ok()
            .flatten()
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "success": false,
                    "message": "Duplicate ref_id",
                    "data": {
                        "existing_trx_id": id_value(&existing),
                        "status": read_string(&existing, "status"),
                    }
                })),
            )
                .into_response();
        }
    }

    let updated_user = users
        .find_one_and_update(
            doc! { "_id": user_id, "balance": { "$gte": price } },
            doc! { "$inc": { "balance": -price }, "$set": { "updatedAt": DateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await;
    let Some(updated_user) = (match updated_user {
        Ok(value) => value,
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "message": "Insufficient balance",
                "data": {
                    "required": price,
                    "current_balance": read_i64(&user, "balance"),
                }
            })),
        )
            .into_response();
    };

    let internal_ref_id = generate_open_api_ref_id(&db).await;
    let product_id = product
        .get_object_id("_id")
        .unwrap_or_else(|_| ObjectId::new());
    let now = DateTime::now();
    let mut transaction_doc = doc! {
        "user": user_id,
        "product": product_id,
        "target": &target,
        "amount": price,
        "status": "pending",
        "vendorTrxId": &internal_ref_id,
        "refunded": false,
        "source": "api",
        "createdAt": now,
        "updatedAt": now,
        "__v": 0_i64,
    };
    if let Some(ref_id) = customer_ref_id.as_deref() {
        transaction_doc.insert("customerRefId", ref_id);
    }
    if !server_id.is_empty() {
        transaction_doc.insert("serverId", server_id.clone());
    }
    let transaction_id = match transactions.insert_one(transaction_doc).await {
        Ok(result) => result
            .inserted_id
            .as_object_id()
            .unwrap_or_else(ObjectId::new),
        Err(_) => {
            rollback_balance(&users, user_id, price).await;
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
        }
    };

    if let Some(validation_config) = product_validation_config(&product) {
        let validation_result = run_paid_validation(&validation_config, &target, &server_id).await;
        let (status, status_note) = match validation_result.status {
            PaidValidationStatus::Success => (
                "success",
                format!("Validasi otomatis berhasil: {}", validation_result.message),
            ),
            PaidValidationStatus::Failed => (
                "failed",
                format!("Validasi otomatis gagal: {}", validation_result.message),
            ),
            PaidValidationStatus::ProviderError => (
                "pending",
                format!("Validasi otomatis tertunda: {}", validation_result.message),
            ),
        };
        let mut set_doc = doc! {
            "status": status,
            "message": validation_result.message.clone(),
            "statusUpdateNote": status_note,
            "updatedAt": DateTime::now(),
        };
        if let Some(sn) = validation_result.sn.as_deref() {
            set_doc.insert("sn", sn);
        }
        let _ = transactions
            .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_doc })
            .await;
        if validation_result.status == PaidValidationStatus::Failed {
            refund_failed_transaction(&users, &transactions, user_id, transaction_id, price).await;
        }
    } else {
        let recheck_product = RecheckProduct {
            code: read_string(&product, "code"),
            vendor_name: product
                .get_document("vendor")
                .ok()
                .map(|vendor| read_string(vendor, "name"))
                .unwrap_or_default(),
            vendor_sku: product
                .get_document("vendor")
                .ok()
                .map(|vendor| read_string(vendor, "sku"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| read_string(&product, "code")),
        };
        if let Ok(vendor_result) = top_up_vendor(
            &state,
            &internal_ref_id,
            &target,
            &server_id,
            &recheck_product,
        )
        .await
        {
            let mut set_doc = doc! {
                "status": &vendor_result.status,
                "updatedAt": DateTime::now(),
            };
            if let Some(vendor_trx_id) = vendor_result.vendor_trx_id.as_deref() {
                set_doc.insert("vendorTrxId", vendor_trx_id);
            }
            if let Some(sn) = vendor_result.sn.as_deref() {
                set_doc.insert("sn", sn);
            }
            if let Some(message) = vendor_result.message.as_deref() {
                set_doc.insert("message", message);
            }
            let _ = transactions
                .update_one(doc! { "_id": transaction_id }, doc! { "$set": set_doc })
                .await;
            if vendor_result.status == "failed" {
                refund_failed_transaction(&users, &transactions, user_id, transaction_id, price)
                    .await;
            }
        }
    }

    let transaction = transactions
        .find_one(doc! { "_id": transaction_id })
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let balance = users
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "balance": 1 })
        .await
        .ok()
        .flatten()
        .map(|user| read_i64(&user, "balance"))
        .unwrap_or_else(|| read_i64(&updated_user, "balance"));

    Json(ApiCreateTransactionResponse {
        success: true,
        message: "Transaction created",
        data: ApiCreateTransactionData {
            trx_id: id_value(&transaction),
            ref_id: customer_ref_id,
            product_code: read_string(&product, "code"),
            product_name: read_string(&product, "name"),
            target: read_string(&transaction, "target"),
            price,
            status: read_string(&transaction, "status"),
            sn: transaction.get_str("sn").ok().map(ToString::to_string),
            balance,
            created_at: date_string(&transaction, "createdAt"),
        },
    })
    .into_response()
}

async fn rollback_balance(users: &mongodb::Collection<Document>, user_id: ObjectId, amount: i64) {
    let _ = users
        .update_one(
            doc! { "_id": user_id },
            doc! { "$inc": { "balance": amount }, "$set": { "updatedAt": DateTime::now() } },
        )
        .await;
}

async fn refund_failed_transaction(
    users: &mongodb::Collection<Document>,
    transactions: &mongodb::Collection<Document>,
    user_id: ObjectId,
    transaction_id: ObjectId,
    amount: i64,
) {
    let refunded = transactions
        .find_one_and_update(
            doc! { "_id": transaction_id, "refunded": { "$ne": true } },
            doc! { "$set": { "refunded": true, "refundedAt": DateTime::now(), "refundReason": "Vendor failed", "updatedAt": DateTime::now() } },
        )
        .await
        .ok()
        .flatten();
    if refunded.is_some() {
        rollback_balance(users, user_id, amount).await;
    }
}

async fn generate_open_api_ref_id(_db: &mongodb::Database) -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(13)
        .map(char::from)
        .collect();
    format!("API{suffix}")
}

async fn product_purchase_issues(db: &mongodb::Database, product: &Document) -> Vec<String> {
    let mut issues = Vec::new();
    if referenced_status_false(db, "categories", product.get_object_id("categoryId").ok()).await
        || named_status_false(db, "categories", &read_string(product, "category")).await
    {
        issues.push("Kategori nonaktif".to_string());
    }
    if referenced_status_false(db, "operators", product.get_object_id("operatorId").ok()).await
        || named_status_false(db, "operators", &read_string(product, "brand")).await
    {
        issues.push("Operator nonaktif".to_string());
    }
    if referenced_status_false(
        db,
        "producttypes",
        product.get_object_id("productTypeId").ok(),
    )
    .await
    {
        issues.push("Jenis produk nonaktif".to_string());
    }
    issues
}

async fn referenced_status_false(
    db: &mongodb::Database,
    collection: &str,
    id: Option<ObjectId>,
) -> bool {
    let Some(id) = id else {
        return false;
    };
    db.collection::<Document>(collection)
        .find_one(doc! { "_id": id })
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
}

async fn named_status_false(db: &mongodb::Database, collection: &str, name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    db.collection::<Document>(collection)
        .find_one(
            doc! { "name": { "$regex": format!("^{}$", escape_regex(name)), "$options": "i" } },
        )
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
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
