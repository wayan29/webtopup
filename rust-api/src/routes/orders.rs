use axum::{http::StatusCode, Json};
use axum::response::IntoResponse;

pub async fn sql_checkout(Json(payload): Json<serde_json::Value>) -> axum::response::Response {
    let Some(user_id) = payload.get("userId").and_then(serde_json::Value::as_str).and_then(|value| uuid::Uuid::parse_str(value).ok()) else { return message(StatusCode::BAD_REQUEST, "Checkout user is required"); };
    let Some(key) = payload.get("key").and_then(serde_json::Value::as_str) else { return message(StatusCode::BAD_REQUEST, "Checkout key is required"); };
    let Some(digest) = payload.get("digest").and_then(serde_json::Value::as_str) else { return message(StatusCode::BAD_REQUEST, "Checkout digest is required"); };
    let Some(product_code) = payload.get("productCode").and_then(serde_json::Value::as_str) else { return message(StatusCode::BAD_REQUEST, "Checkout product is required"); };
    let level = payload.get("level").and_then(serde_json::Value::as_str).unwrap_or("basic");
    let Some(database_url) = payload.get("databaseUrl").and_then(serde_json::Value::as_str) else { return message(StatusCode::BAD_REQUEST, "Checkout database is required"); };
    let database = database_url.split('?').next().unwrap_or(database_url).rsplit('/').next().unwrap_or("");
    if !database.starts_with("webtopup_ci_") { return message(StatusCode::BAD_REQUEST, "Checkout database is not disposable"); }
    let Ok(store) = crate::wallet_store::WalletStore::connect(database_url).await else { return message(StatusCode::SERVICE_UNAVAILABLE, "SQL checkout store is unavailable"); };
    match store.checkout(user_id, key, digest, product_code, level).await {
        Ok(balance) => Json(serde_json::json!({"balance": balance})).into_response(),
        Err(crate::wallet_store::WalletError::Insufficient) => message(StatusCode::CONFLICT, "Insufficient balance"),
        Err(crate::wallet_store::WalletError::Conflict) => message(StatusCode::CONFLICT, "Checkout conflict"),
        Err(_) => message(StatusCode::SERVICE_UNAVAILABLE, "SQL checkout store is unavailable"),
    }
}

fn message(status: StatusCode, message: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({"message": message}))).into_response()
}
