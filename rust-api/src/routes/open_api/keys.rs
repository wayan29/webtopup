use std::sync::Arc;

use axum::{response::IntoResponse, response::Response, Json};
use sqlx::Row;
use uuid::Uuid;

use crate::{security::require_proxy_context, state::AppState};

use super::{
    responses::{status_message, unavailable},
    types::{ApiKeyResponse, GenerateApiKeyResponse, MessageResponse},
    utils::member_code_from_uuid,
};

fn internal_error() -> Response {
    status_message(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn trusted_user_id(context: &crate::security::ProxyContext) -> Result<Uuid, Response> {
    context.user_id.as_deref().and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"))
}

pub async fn get_key(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let user_id = match trusted_user_id(&context) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let row = sqlx::query("SELECT member_code, api_key, active, secret_nonce IS NOT NULL AND secret_ciphertext IS NOT NULL AS has_secret FROM open_api_credentials WHERE user_id=$1")
        .bind(user_id).fetch_optional(&state.pg_pool).await;
    match row {
        Ok(Some(row)) => {
            let active: bool = row.get("active");
            let api_key: String = row.get("api_key");
            Json(ApiKeyResponse {
                member_id: row.get("member_code"),
                has_api_key: active,
                api_key: active.then_some(api_key),
                secret: None,
                has_secret: active && row.get::<bool, _>("has_secret"),
            }).into_response()
        }
        Ok(None) => match sqlx::query("SELECT role, member_code FROM users WHERE id=$1").bind(user_id).fetch_optional(&state.pg_pool).await {
            Ok(Some(user)) if user.get::<String, _>("role") == "member" => Json(ApiKeyResponse { member_id: user.get::<Option<String>, _>("member_code").unwrap_or_else(|| member_code_from_uuid(user_id)), api_key: None, secret: None, has_api_key: false, has_secret: false }).into_response(),
            Ok(Some(_)) => status_message(axum::http::StatusCode::FORBIDDEN, "Only members can manage API keys"),
            Ok(None) => status_message(axum::http::StatusCode::NOT_FOUND, "User not found"),
            Err(_) => internal_error(),
        },
        Err(_) => internal_error(),
    }
}

pub async fn generate_key(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let user_id = match trusted_user_id(&context) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let user = sqlx::query("SELECT role, member_code FROM users WHERE id=$1").bind(user_id).fetch_optional(&state.pg_pool).await;
    let user = match user {
        Ok(Some(user)) => user,
        Ok(None) => return status_message(axum::http::StatusCode::NOT_FOUND, "User not found"),
        Err(_) => return internal_error(),
    };
    if user.get::<String, _>("role") != "member" {
        return status_message(axum::http::StatusCode::FORBIDDEN, "Only members can generate API keys");
    }
    let member_id: Option<String> = user.get("member_code");
    let member_id = member_id.unwrap_or_else(|| member_code_from_uuid(user_id));
    if let Err(_) = sqlx::query("UPDATE users SET member_code=$2 WHERE id=$1 AND member_code IS NULL")
        .bind(user_id).bind(&member_id).execute(&state.pg_pool).await { return internal_error(); }
    let store = crate::wallet_store::WalletStore::from_pool(state.pg_pool.clone());
    match store.issue_open_api_credential(user_id, &member_id).await {
        Ok((api_key, secret)) => Json(GenerateApiKeyResponse {
            message: "API key generated successfully", member_id, api_key, secret,
        }).into_response(),
        Err(_) => unavailable(),
    }
}

pub async fn revoke_key(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let user_id = match trusted_user_id(&context) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match sqlx::query("UPDATE open_api_credentials SET active=false, secret_nonce=NULL, secret_ciphertext=NULL WHERE user_id=$1 AND active=true")
        .bind(user_id).execute(&state.pg_pool).await {
        Ok(_) => Json(MessageResponse { message: "API key revoked successfully" }).into_response(),
        Err(_) => internal_error(),
    }
}
