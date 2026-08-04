use axum::{http::StatusCode, response::IntoResponse, Json};

use super::{
    cache::{
        get_cached_game_validation, get_cached_validation, set_cached_game_validation_if_allowed,
        set_cached_validation,
    },
    normalize::{normalize_digit_input, normalize_phone_input},
    operators::operators,
    provider::PUBLIC_PROVIDER_OUTAGE_MESSAGE,
    provider::{inquire_freefire_nickname, inquire_mobilelegends_nickname},
    types::NicknameResultKind,
    types::{
        FreeFireValidationPayload, GameValidationData, GameValidationResponse,
        MobileLegendsValidationPayload, OperatorValidationData, OperatorValidationPayload,
        ValidationResponse,
    },
};

pub async fn operator(Json(payload): Json<OperatorValidationPayload>) -> impl IntoResponse {
    let normalized = normalize_phone_input(payload.phone_number);
    let Some(phone_number) = normalized.value else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ValidationResponse {
                success: false,
                data: None,
                message: normalized.message.unwrap_or_default(),
            }),
        );
    };
    let original_number = normalized.original.unwrap_or_default();
    let cache_key = format!("operator:{phone_number}");
    if let Some(cached) = get_cached_validation(&cache_key) {
        return (cached.status, Json(cached.payload));
    }
    let prefix = phone_number.chars().take(4).collect::<String>();
    if let Some(operator) = operators()
        .iter()
        .find(|operator| operator.prefixes.contains(&prefix.as_str()))
    {
        let response = ValidationResponse {
            success: true,
            data: Some(OperatorValidationData {
                phone_number,
                original_number,
                operator: Some(operator.name),
                prefix: Some(prefix),
                color: Some(operator.color),
            }),
            message: "Operator berhasil dideteksi".to_string(),
        };
        set_cached_validation(cache_key, StatusCode::OK, response.clone());
        return (StatusCode::OK, Json(response));
    }

    let response = ValidationResponse {
        success: false,
        data: Some(OperatorValidationData {
            phone_number,
            original_number,
            operator: None,
            prefix: None,
            color: None,
        }),
        message: "Operator tidak dapat diidentifikasi. Prefix nomor tidak terdaftar.".to_string(),
    };
    set_cached_validation(cache_key, StatusCode::BAD_REQUEST, response.clone());
    (StatusCode::BAD_REQUEST, Json(response))
}

pub async fn freefire(Json(payload): Json<FreeFireValidationPayload>) -> impl IntoResponse {
    let normalized_user_id = normalize_digit_input(payload.user_id, "User ID", 5, 20);
    let Some(user_id) = normalized_user_id.value else {
        return (
            StatusCode::BAD_REQUEST,
            Json(GameValidationResponse {
                success: false,
                data: None,
                message: normalized_user_id.message.unwrap_or_default(),
            }),
        );
    };
    let cache_key = format!("freefire:{user_id}:");
    if let Some(cached) = get_cached_game_validation(&cache_key) {
        return (cached.status, Json(cached.payload));
    }

    let result = inquire_freefire_nickname(&user_id).await;
    if result.is_success {
        let response = GameValidationResponse {
            success: true,
            data: Some(GameValidationData {
                user_id,
                zone_id: None,
                nickname: result.nickname.unwrap_or_default(),
            }),
            message: result
                .message
                .unwrap_or_else(|| "Nickname berhasil ditemukan".to_string()),
        };
        set_cached_game_validation_if_allowed(
            cache_key,
            NicknameResultKind::Success,
            StatusCode::OK,
            response.clone(),
        );
        return (StatusCode::OK, Json(response));
    }

    if result.kind == NicknameResultKind::ProviderError {
        let response = GameValidationResponse {
            success: false,
            data: None,
            message: result
                .message
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| PUBLIC_PROVIDER_OUTAGE_MESSAGE.to_string()),
        };
        return (StatusCode::BAD_GATEWAY, Json(response));
    }

    let response = GameValidationResponse {
        success: false,
        data: None,
        message: result
            .message
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "User ID tidak ditemukan".to_string()),
    };
    set_cached_game_validation_if_allowed(
        cache_key,
        NicknameResultKind::NotFound,
        StatusCode::BAD_REQUEST,
        response.clone(),
    );
    (StatusCode::BAD_REQUEST, Json(response))
}

pub async fn mobilelegends(
    Json(payload): Json<MobileLegendsValidationPayload>,
) -> impl IntoResponse {
    let normalized_user_id = normalize_digit_input(payload.user_id, "User ID", 5, 20);
    let Some(user_id) = normalized_user_id.value else {
        return (
            StatusCode::BAD_REQUEST,
            Json(GameValidationResponse {
                success: false,
                data: None,
                message: normalized_user_id.message.unwrap_or_default(),
            }),
        );
    };
    let normalized_zone_id = normalize_digit_input(payload.zone_id, "Zone ID", 1, 10);
    let Some(zone_id) = normalized_zone_id.value else {
        return (
            StatusCode::BAD_REQUEST,
            Json(GameValidationResponse {
                success: false,
                data: None,
                message: normalized_zone_id.message.unwrap_or_default(),
            }),
        );
    };
    let cache_key = format!("mobilelegends:{user_id}:{zone_id}");
    if let Some(cached) = get_cached_game_validation(&cache_key) {
        return (cached.status, Json(cached.payload));
    }

    let result = inquire_mobilelegends_nickname(&user_id, &zone_id).await;
    if result.is_success {
        let response = GameValidationResponse {
            success: true,
            data: Some(GameValidationData {
                user_id,
                zone_id: Some(zone_id),
                nickname: result.nickname.unwrap_or_default(),
            }),
            message: result
                .message
                .unwrap_or_else(|| "Nickname berhasil ditemukan".to_string()),
        };
        set_cached_game_validation_if_allowed(
            cache_key,
            NicknameResultKind::Success,
            StatusCode::OK,
            response.clone(),
        );
        return (StatusCode::OK, Json(response));
    }

    if result.kind == NicknameResultKind::ProviderError {
        let response = GameValidationResponse {
            success: false,
            data: None,
            message: result
                .message
                .filter(|message| !message.is_empty())
                .unwrap_or_else(|| PUBLIC_PROVIDER_OUTAGE_MESSAGE.to_string()),
        };
        return (StatusCode::BAD_GATEWAY, Json(response));
    }

    let response = GameValidationResponse {
        success: false,
        data: None,
        message: result
            .message
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "User ID/Zone ID tidak ditemukan".to_string()),
    };
    set_cached_game_validation_if_allowed(
        cache_key,
        NicknameResultKind::NotFound,
        StatusCode::BAD_REQUEST,
        response.clone(),
    );
    (StatusCode::BAD_REQUEST, Json(response))
}
