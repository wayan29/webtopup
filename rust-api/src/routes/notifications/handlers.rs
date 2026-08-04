use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use mongodb::bson::{oid::ObjectId, DateTime, Document};

use crate::{security::require_proxy_context, state::AppState, utils::dates::timestamp_now};

use super::{
    builders::{build_notifications, category_counts, notification_stats},
    responses::{internal_error, status_message, unavailable},
    state::{apply_user_state, upsert_notification_state},
    types::{
        MarkAllReadResponse, NotificationListResponse, NotificationStatePayload,
        NotificationStateResponse, NotificationSummaryResponse,
    },
};

pub async fn admin_summary(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let notifications = build_notifications(&db).await;
    let visible = apply_user_state(&db, proxy_context.user_id.as_deref(), notifications).await;
    let categories = category_counts(&visible);
    let stats = notification_stats(&visible);
    let top = visible.into_iter().take(5).collect();
    Json(NotificationSummaryResponse {
        ok: true,
        service: "webtopup-api-v2",
        api_prefix: "/v2",
        generated_at: timestamp_now(),
        source: "mongodb-snapshot",
        user: proxy_context.into_response(),
        total: stats.total,
        unread: stats.unread,
        critical: stats.critical,
        warning: stats.warning,
        info: stats.info,
        categories,
        top,
    })
    .into_response()
}

pub async fn admin_list(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let db = client.database(&state.mongo_db);
    let notifications = build_notifications(&db).await;
    let visible = apply_user_state(&db, proxy_context.user_id.as_deref(), notifications).await;
    let stats = notification_stats(&visible);
    Json(NotificationListResponse {
        generated_at: DateTime::now()
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| timestamp_now()),
        total: stats.total,
        unread: stats.unread,
        critical: stats.critical,
        warning: stats.warning,
        info: stats.info,
        notifications: visible,
    })
    .into_response()
}

pub async fn mark_read(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<NotificationStatePayload>,
) -> Response {
    update_notification_state(headers, state, id, payload, false).await
}

pub async fn dismiss(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<NotificationStatePayload>,
) -> Response {
    update_notification_state(headers, state, id, payload, true).await
}

pub async fn mark_all_read(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = proxy_context.user_id else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Ok(user_id) = ObjectId::parse_str(&user_id) else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let db = client.database(&state.mongo_db);
    let notifications = build_notifications(&db).await;
    let visible = apply_user_state(&db, Some(&user_id.to_hex()), notifications).await;
    let now = DateTime::now();
    let states = db.collection::<Document>("adminnotificationstates");
    let mut updated = 0;
    for notification in visible {
        if upsert_notification_state(
            &states,
            user_id,
            notification.id,
            &notification.fingerprint,
            now,
            false,
        )
        .await
        .is_err()
        {
            return internal_error();
        }
        updated += 1;
    }
    Json(MarkAllReadResponse {
        success: true,
        updated,
    })
    .into_response()
}

async fn update_notification_state(
    headers: axum::http::HeaderMap,
    state: Arc<AppState>,
    id: String,
    payload: NotificationStatePayload,
    dismiss: bool,
) -> Response {
    let proxy_context = match require_proxy_context(&headers, &state) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(client) = &state.mongo_client else {
        return unavailable();
    };
    let Some(user_id) = proxy_context.user_id else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Ok(user_id) = ObjectId::parse_str(&user_id) else {
        return status_message(axum::http::StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let notification_id = id.trim().to_string();
    let fingerprint = payload.fingerprint.unwrap_or_default().trim().to_string();
    if notification_id.is_empty() || fingerprint.is_empty() {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Notifikasi tidak valid",
        );
    }

    let db = client.database(&state.mongo_db);
    let notifications = build_notifications(&db).await;
    let is_active_fingerprint = notifications.iter().any(|notification| {
        notification.id == notification_id && notification.fingerprint == fingerprint
    });

    if !is_active_fingerprint {
        return status_message(
            axum::http::StatusCode::BAD_REQUEST,
            "Notifikasi sudah berubah atau tidak aktif. Segarkan halaman lalu coba lagi.",
        );
    }

    let states = db.collection::<Document>("adminnotificationstates");
    if upsert_notification_state(
        &states,
        user_id,
        &notification_id,
        &fingerprint,
        DateTime::now(),
        dismiss,
    )
    .await
    .is_err()
    {
        return internal_error();
    }
    Json(NotificationStateResponse { success: true }).into_response()
}
