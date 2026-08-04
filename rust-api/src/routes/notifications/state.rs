use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use super::types::{date_to_string, AdminNotificationItem};

pub async fn apply_user_state(
    db: &mongodb::Database,
    user_id: Option<&str>,
    notifications: Vec<AdminNotificationItem>,
) -> Vec<AdminNotificationItem> {
    let Some(user_id) = user_id.and_then(|value| ObjectId::parse_str(value).ok()) else {
        return notifications;
    };
    let ids = notifications
        .iter()
        .map(|item| Bson::String(item.id.to_string()))
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return notifications;
    }

    let mut states_by_key = std::collections::HashMap::new();
    if let Ok(mut cursor) = db
        .collection::<Document>("adminnotificationstates")
        .find(doc! { "user": user_id, "notificationId": { "$in": ids } })
        .await
    {
        while let Ok(Some(state)) = futures_util::TryStreamExt::try_next(&mut cursor).await {
            let notification_id = state.get_str("notificationId").unwrap_or_default();
            let fingerprint = state.get_str("fingerprint").unwrap_or_default();
            states_by_key.insert(
                format!("{notification_id}:{fingerprint}"),
                (
                    state.get_datetime("readAt").ok().map(date_to_string),
                    state.get_datetime("dismissedAt").ok().map(date_to_string),
                ),
            );
        }
    }

    notifications
        .into_iter()
        .filter_map(|mut item| {
            if let Some((read_at, dismissed_at)) =
                states_by_key.get(&format!("{}:{}", item.id, item.fingerprint))
            {
                if dismissed_at.is_some() {
                    return None;
                }
                item.read_at = read_at.clone();
                item.dismissed_at = dismissed_at.clone();
                item.unread = read_at.is_none();
            }
            Some(item)
        })
        .collect()
}

pub async fn upsert_notification_state(
    states: &mongodb::Collection<Document>,
    user_id: ObjectId,
    notification_id: &str,
    fingerprint: &str,
    now: DateTime,
    dismiss: bool,
) -> mongodb::error::Result<mongodb::results::UpdateResult> {
    let mut set_doc = doc! { "readAt": now, "updatedAt": now };
    if dismiss {
        set_doc.insert("dismissedAt", now);
    }
    states
        .update_one(
            doc! { "user": user_id, "notificationId": notification_id, "fingerprint": fingerprint },
            doc! {
                "$set": set_doc,
                "$setOnInsert": {
                    "user": user_id,
                    "notificationId": notification_id,
                    "fingerprint": fingerprint,
                    "createdAt": now,
                    "__v": 0,
                },
            },
        )
        .upsert(true)
        .await
}
