use std::sync::Arc;

use axum::{response::IntoResponse, response::Response, Json};
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::require_proxy_context, state::AppState, utils::bson::read_string};

use super::{
    responses::{status_message, unavailable},
    types::{ApiKeyResponse, GenerateApiKeyResponse, MessageResponse},
    utils::{generate_api_key, generate_api_secret, member_code_from_id},
};

pub async fn get_key(
    headers: axum::http::HeaderMap,
    state: axum::extract::State<Arc<AppState>>,
) -> Response {
    let axum::extract::State(state) = state;
    let context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = match context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(user_id) => user_id,
        None => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let user = client
        .database(&state.mongo_db)
        .collection::<Document>("users")
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "apiKey": 1, "apiSecret": 1, "memberCode": 1 })
        .await
        .ok()
        .flatten();
    let Some(user) = user else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    // Secret is returned only from generate_key. Reloading settings must not re-expose it.
    Json(api_key_status_response(&user, &user_id)).into_response()
}

/// Build the non-secret status envelope for GET /api/key.
pub(super) fn api_key_status_response(user: &Document, user_id: &ObjectId) -> ApiKeyResponse {
    let api_key = read_string(user, "apiKey");
    let secret = read_string(user, "apiSecret");
    let member_id = read_string(user, "memberCode");
    let member_id = if member_id.is_empty() {
        member_code_from_id(user_id)
    } else {
        member_id
    };
    let has_api_key = !api_key.is_empty();
    let has_secret = !secret.is_empty();
    ApiKeyResponse {
        member_id,
        api_key: if has_api_key { Some(api_key) } else { None },
        // Always None on status reads — secret is one-time at generate.
        secret: None,
        has_api_key,
        has_secret,
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
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = match context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(user_id) => user_id,
        None => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let user = users
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "role": 1, "memberCode": 1 })
        .await
        .ok()
        .flatten();
    let Some(user) = user else {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    };
    if read_string(&user, "role") != "member" {
        return status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Only members can generate API keys",
        );
    }
    let api_key = generate_api_key();
    let secret = generate_api_secret();
    let existing_member_code = read_string(&user, "memberCode");
    let member_id = if existing_member_code.is_empty() {
        member_code_from_id(&user_id)
    } else {
        existing_member_code
    };
    if users
        .update_one(
            doc! { "_id": user_id },
            doc! { "$set": { "apiKey": &api_key, "apiSecret": &secret, "memberCode": &member_id } },
        )
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    Json(GenerateApiKeyResponse {
        message: "API key generated successfully",
        member_id,
        api_key,
        secret,
    })
    .into_response()
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
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let user_id = match context
        .user_id
        .as_deref()
        .and_then(|id| ObjectId::parse_str(id).ok())
    {
        Some(user_id) => user_id,
        None => return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized"),
    };
    let users = client
        .database(&state.mongo_db)
        .collection::<Document>("users");
    let user_exists = users
        .find_one(doc! { "_id": user_id })
        .projection(doc! { "_id": 1 })
        .await
        .ok()
        .flatten()
        .is_some();
    if !user_exists {
        return status_message(axum::http::StatusCode::NOT_FOUND, "User not found");
    }
    if users
        .update_one(doc! { "_id": user_id }, open_api_credentials_clear_update())
        .await
        .is_err()
    {
        return status_message(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        );
    }
    Json(MessageResponse {
        message: "API key revoked successfully",
    })
    .into_response()
}

/// Shared Mongo update that fully disables Open API access without deleting memberCode identity.
pub(crate) fn open_api_credentials_clear_update() -> Document {
    doc! { "$unset": { "apiKey": "", "apiSecret": "" } }
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{doc, oid::ObjectId};

    use super::{api_key_status_response, open_api_credentials_clear_update};

    #[test]
    fn status_response_never_includes_secret_even_when_stored() {
        let user_id = ObjectId::new();
        let user = doc! {
            "apiKey": "tv_live_key",
            "apiSecret": "super-secret-value",
            "memberCode": "MBRTEST01",
        };
        let response = api_key_status_response(&user, &user_id);
        assert_eq!(response.member_id, "MBRTEST01");
        assert_eq!(response.api_key.as_deref(), Some("tv_live_key"));
        assert!(response.has_api_key);
        assert!(response.has_secret);
        assert_eq!(response.secret, None);
    }

    #[test]
    fn clear_update_unsets_key_and_secret() {
        let update = open_api_credentials_clear_update();
        let unset = update.get_document("$unset").expect("unset");
        assert!(unset.contains_key("apiKey"));
        assert!(unset.contains_key("apiSecret"));
        assert!(!unset.contains_key("memberCode"));
    }
}
