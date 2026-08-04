use mongodb::bson::{Bson, DateTime, Document};
use serde_json::{json, Map, Value};

use super::read_i64;
use crate::utils::bson::read_string;

pub(super) fn serialize_auth_user(user: &Document) -> Value {
    json!({
        "id": user.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default(),
        "name": read_string(user, "name"),
        "email": read_string(user, "email"),
        "avatarUrl": read_string(user, "avatarUrl"),
        "phone": read_string(user, "phone"),
        "address": read_string(user, "address"),
        "role": read_string(user, "role"),
        "level": read_string(user, "level"),
        "balance": read_i64(user, "balance"),
        "points": read_i64(user, "points"),
        "active": user.get_bool("active").unwrap_or(true),
        "twoFactorEnabled": user.get_bool("twoFactorEnabled").unwrap_or(false),
        "twoFactorEnrollmentRequiredAt": user.get_datetime("twoFactorEnrollmentRequiredAt").map(|value| date_time_to_mongoose_string(*value)).ok(),
        "twoFactorEnrollmentCompletedAt": user.get_datetime("twoFactorEnrollmentCompletedAt").map(|value| date_time_to_mongoose_string(*value)).ok(),
        "serverTime": date_time_to_mongoose_string(DateTime::now()),
        "createdAt": user.get_datetime("createdAt").map(|value| date_time_to_mongoose_string(*value)).unwrap_or_default(),
        "preferences": member_preferences(user.get_document("preferences").ok()),
        "permissions": document_to_json(user.get_document("permissions").cloned().unwrap_or_default()),
    })
}

fn member_preferences(preferences: Option<&Document>) -> Value {
    json!({
        "emailNotifications": preferences.and_then(|d| d.get_bool("emailNotifications").ok()).unwrap_or(true),
        "smsNotifications": preferences.and_then(|d| d.get_bool("smsNotifications").ok()).unwrap_or(false),
        "showBalance": preferences.and_then(|d| d.get_bool("showBalance").ok()).unwrap_or(true),
        "uiTheme": preferences.map(|d| read_string(d, "uiTheme")).filter(|value| !value.is_empty()).unwrap_or_else(|| "ember-premium".to_string()),
    })
}

fn document_to_json(document: Document) -> Value {
    let mut map = Map::new();
    for (key, value) in document {
        map.insert(key, bson_to_json(value));
    }
    Value::Object(map)
}

fn bson_to_json(value: Bson) -> Value {
    match value {
        Bson::ObjectId(value) => Value::String(value.to_hex()),
        Bson::DateTime(value) => Value::String(date_time_to_mongoose_string(value)),
        Bson::String(value) => Value::String(value),
        Bson::Boolean(value) => Value::Bool(value),
        Bson::Int32(value) => serde_json::json!(value),
        Bson::Int64(value) => serde_json::json!(value),
        Bson::Double(value) => serde_json::json!(value),
        Bson::Array(values) => Value::Array(values.into_iter().map(bson_to_json).collect()),
        Bson::Document(document) => document_to_json(document),
        Bson::Null => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

fn date_time_to_mongoose_string(value: DateTime) -> String {
    let millis = value.timestamp_millis();
    let ms = millis.rem_euclid(1000);
    let base = value
        .try_to_rfc3339_string()
        .unwrap_or_else(|_| value.to_string());
    let Some((date_time, _)) = base.split_once('.') else {
        return base.replace('Z', &format!(".{ms:03}Z"));
    };
    format!("{date_time}.{ms:03}Z")
}

#[cfg(test)]
mod avatar_serialization_tests {
    use super::*;
    use mongodb::bson::doc;

    // The admin header renders an avatar before the profile page is ever opened, so the field
    // has to ride along on every session payload, not just on the staff profile response.
    #[test]
    fn session_user_carries_the_avatar_url() {
        let user = doc! { "name": "Staff", "avatarUrl": "/uploads/avatars/abc.png" };
        assert_eq!(
            serialize_auth_user(&user)["avatarUrl"],
            Value::String("/uploads/avatars/abc.png".to_string())
        );
    }

    #[test]
    fn session_user_reports_an_empty_avatar_when_unset() {
        let user = doc! { "name": "Staff" };
        assert_eq!(
            serialize_auth_user(&user)["avatarUrl"],
            Value::String(String::new())
        );
    }
}
