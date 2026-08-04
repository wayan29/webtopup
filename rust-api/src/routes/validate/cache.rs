use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::http::StatusCode;

use super::types::{
    CachedGameValidation, CachedValidation, GameValidationResponse, NicknameResultKind,
    ValidationResponse,
};

pub(super) fn should_cache_nickname_result(kind: NicknameResultKind) -> bool {
    !matches!(kind, NicknameResultKind::ProviderError)
}

static OPERATOR_CACHE: LazyLock<Mutex<HashMap<String, CachedValidation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static GAME_CACHE: LazyLock<Mutex<HashMap<String, CachedGameValidation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const SUCCESS_CACHE_TTL: Duration = Duration::from_secs(30);
const FAILURE_CACHE_TTL: Duration = Duration::from_secs(10);
const MAX_CACHE_ENTRIES: usize = 10_000;

fn prune_cache<T>(
    cache: &mut HashMap<String, T>,
    now: Instant,
    expires_at: impl Fn(&T) -> Instant,
) {
    cache.retain(|_, value| expires_at(value) > now);
    if cache.len() > MAX_CACHE_ENTRIES {
        let mut entries = cache
            .iter()
            .map(|(key, value)| (key.clone(), expires_at(value)))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(_, expires_at)| *expires_at);
        let remove_count = cache.len().saturating_sub(MAX_CACHE_ENTRIES);
        for (key, _) in entries.into_iter().take(remove_count) {
            cache.remove(&key);
        }
    }
}

pub fn get_cached_validation(cache_key: &str) -> Option<CachedValidation> {
    let mut cache = OPERATOR_CACHE.lock().ok()?;
    let cached = cache.get(cache_key)?.clone();
    if cached.expires_at <= Instant::now() {
        cache.remove(cache_key);
        return None;
    }
    Some(cached)
}

pub fn set_cached_validation(cache_key: String, status: StatusCode, payload: ValidationResponse) {
    let ttl = if status.as_u16() >= 400 {
        FAILURE_CACHE_TTL
    } else {
        SUCCESS_CACHE_TTL
    };
    if let Ok(mut cache) = OPERATOR_CACHE.lock() {
        prune_cache(&mut cache, Instant::now(), |value| value.expires_at);
        cache.insert(
            cache_key,
            CachedValidation {
                expires_at: Instant::now() + ttl,
                status,
                payload,
            },
        );
    }
}

pub fn get_cached_game_validation(cache_key: &str) -> Option<CachedGameValidation> {
    let mut cache = GAME_CACHE.lock().ok()?;
    let cached = cache.get(cache_key)?.clone();
    if cached.expires_at <= Instant::now() {
        cache.remove(cache_key);
        return None;
    }
    Some(cached)
}

pub fn set_cached_game_validation_if_allowed(
    cache_key: String,
    kind: NicknameResultKind,
    status: StatusCode,
    payload: GameValidationResponse,
) {
    if !should_cache_nickname_result(kind) {
        return;
    }
    set_cached_game_validation(cache_key, status, payload);
}

pub fn set_cached_game_validation(
    cache_key: String,
    status: StatusCode,
    payload: GameValidationResponse,
) {
    let ttl = if status.as_u16() >= 400 {
        FAILURE_CACHE_TTL
    } else {
        SUCCESS_CACHE_TTL
    };
    if let Ok(mut cache) = GAME_CACHE.lock() {
        prune_cache(&mut cache, Instant::now(), |value| value.expires_at);
        cache.insert(
            cache_key,
            CachedGameValidation {
                expires_at: Instant::now() + ttl,
                status,
                payload,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_game_payload(message: &str) -> GameValidationResponse {
        GameValidationResponse {
            success: false,
            data: None,
            message: message.to_string(),
        }
    }

    #[test]
    fn provider_error_is_not_cached() {
        assert!(!should_cache_nickname_result(
            NicknameResultKind::ProviderError
        ));
    }

    #[test]
    fn not_found_is_cached() {
        assert!(should_cache_nickname_result(NicknameResultKind::NotFound));
    }

    #[test]
    fn success_is_cached() {
        assert!(should_cache_nickname_result(NicknameResultKind::Success));
    }

    #[test]
    fn set_cached_game_validation_if_allowed_skips_provider_error() {
        let cache_key = format!(
            "test-provider-error-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        set_cached_game_validation_if_allowed(
            cache_key.clone(),
            NicknameResultKind::ProviderError,
            StatusCode::BAD_GATEWAY,
            sample_game_payload("outage"),
        );
        assert!(get_cached_game_validation(&cache_key).is_none());
    }

    #[test]
    fn set_cached_game_validation_if_allowed_stores_not_found() {
        let cache_key = format!(
            "test-not-found-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let payload = sample_game_payload("User ID tidak ditemukan");
        set_cached_game_validation_if_allowed(
            cache_key.clone(),
            NicknameResultKind::NotFound,
            StatusCode::BAD_REQUEST,
            payload.clone(),
        );
        let cached = get_cached_game_validation(&cache_key).expect("cached not found");
        assert_eq!(cached.status, StatusCode::BAD_REQUEST);
        assert_eq!(cached.payload.message, payload.message);
    }
}
