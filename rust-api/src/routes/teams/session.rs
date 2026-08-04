use axum::response::Response;
use mongodb::bson::{doc, oid::ObjectId, Document};

use crate::{security::ProxyContext, utils::bson::read_string};

use super::{responses::status_message, types::ActorScope};

pub(super) async fn actor_scope(
    db: &mongodb::Database,
    context: &ProxyContext,
) -> Result<ActorScope, Response> {
    let Some(user_id) = context.user_id.as_deref() else {
        return Err(status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Unauthorized",
        ));
    };
    let Ok(object_id) = ObjectId::parse_str(user_id) else {
        return Err(status_message(
            axum::http::StatusCode::UNAUTHORIZED,
            "Unauthorized",
        ));
    };
    let actor = match db
        .collection::<Document>("users")
        .find_one(doc! { "_id": object_id })
        .projection(doc! { "name": 1, "email": 1, "role": 1, "permissions": 1, "active": 1 })
        .await
    {
        Ok(Some(actor)) => actor,
        _ => {
            return Err(status_message(
                axum::http::StatusCode::UNAUTHORIZED,
                "Unauthorized",
            ))
        }
    };
    if actor.get_bool("active").ok() == Some(false) {
        return Err(status_message(
            axum::http::StatusCode::FORBIDDEN,
            "Akun tim tidak aktif",
        ));
    }
    let role = read_string(&actor, "role");
    let permissions = actor
        .get_document("permissions")
        .ok()
        .cloned()
        .unwrap_or_default();
    Ok(ActorScope {
        id: object_id,
        name: read_string(&actor, "name"),
        email: read_string(&actor, "email"),
        is_owner: role == "owner",
        role,
        permissions,
    })
}
