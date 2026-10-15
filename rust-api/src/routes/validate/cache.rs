use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use redis::aio::MultiplexedConnection;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::types::{
    CachedGameValidation, CachedValidation, GameValidationResponse, NicknameResultKind,
    ValidationResponse,
};

/// Redis-backed validation cache for the public `/v2/validate/*` endpoints.
///
/// Contract:
/// - Keys live under `{REDIS_NAMESPACE}:validate:*` (default namespace `webtopup`),
///   read from `REDIS_URL` exactly like the other SQL-candidate Redis consumers.
/// - Successful responses are cached for 30s, definitive (non-provider) failures
///   for 10s. Provider errors are never cached.
/// - Entries are versioned by a generation counter; `invalidate_validation_cache`
///   bumps the generation and deletes every registered entry, so old payloads can
///   never be served after an invalidation.
/// - Each registry (operator, game) is bounded at `MAX_CACHE_ENTRIES` keys; the
///   bound is enforced atomically with the write.
/// - A Redis outage is an error, never a silent cache miss or a fake success:
///   callers must answer 503 when `ValidationCacheError` is returned.
///
/// `Promise`-style note: this module uses `tokio::sync::Mutex` only to keep one
/// multiplexed connection; the lock is never held across a Redis round trip.

const SUCCESS_CACHE_TTL_MS: u64 = 30_000;
const FAILURE_CACHE_TTL_MS: u64 = 10_000;
const MAX_CACHE_ENTRIES: usize = 10_000;
const REGISTRY_TTL_MS: u64 = 120_000;

pub(super) const CACHE_UNAVAILABLE_MESSAGE: &str =
    "Cache validasi sedang tidak tersedia. Silakan coba lagi beberapa saat lagi.";

pub(super) fn should_cache_nickname_result(kind: NicknameResultKind) -> bool {
    !matches!(kind, NicknameResultKind::ProviderError)
}

#[derive(Debug)]
pub struct ValidationCacheError;

impl std::fmt::Display for ValidationCacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("validation cache unavailable")
    }
}

impl std::error::Error for ValidationCacheError {}

#[derive(Serialize, Deserialize)]
struct CachedEnvelope<T> {
    status: u16,
    payload: T,
}

const GET_SCRIPT_SOURCE: &str = r#"
local generation = redis.call('GET', KEYS[1])
if not generation then
    return false
end
return redis.call('GET', ARGV[1] .. ':g' .. generation .. ':' .. ARGV[2])
"#;

const SET_SCRIPT_SOURCE: &str = r#"
local generation = redis.call('GET', KEYS[1])
if not generation then
    generation = '1'
    redis.call('SET', KEYS[1], generation)
end
local entry_key = ARGV[1] .. ':g' .. generation .. ':' .. ARGV[2]
local ttl_ms = tonumber(ARGV[3])
redis.call('SET', entry_key, ARGV[6], 'PX', ttl_ms)
redis.call('ZADD', KEYS[2], tonumber(ARGV[4]) + ttl_ms, entry_key)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[4]))
local size = redis.call('ZCARD', KEYS[2])
local max_entries = tonumber(ARGV[5])
if size > max_entries then
    local evicted = redis.call('ZRANGE', KEYS[2], 0, size - max_entries - 1)
    for _, key in ipairs(evicted) do
        redis.call('DEL', key)
        redis.call('ZREM', KEYS[2], key)
    end
end
redis.call('PEXPIRE', KEYS[2], ARGV[7])
return 1
"#;

const INVALIDATE_SCRIPT_SOURCE: &str = r#"
local generation = redis.call('INCR', KEYS[1])
for index = 2, #KEYS do
    local stale = redis.call('ZRANGE', KEYS[index], 0, -1)
    for _, key in ipairs(stale) do
        redis.call('DEL', key)
    end
    redis.call('DEL', KEYS[index])
end
return generation
"#;

static GET_SCRIPT: LazyLock<redis::Script> = LazyLock::new(|| redis::Script::new(GET_SCRIPT_SOURCE));
static SET_SCRIPT: LazyLock<redis::Script> = LazyLock::new(|| redis::Script::new(SET_SCRIPT_SOURCE));
static INVALIDATE_SCRIPT: LazyLock<redis::Script> =
    LazyLock::new(|| redis::Script::new(INVALIDATE_SCRIPT_SOURCE));

struct ValidationCache {
    client: Option<redis::Client>,
    namespace: String,
    connection: Mutex<Option<MultiplexedConnection>>,
}

static CACHE: LazyLock<ValidationCache> = LazyLock::new(|| {
    let namespace = std::env::var("REDIS_NAMESPACE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "webtopup".to_string());

    let client = match std::env::var("REDIS_URL") {
        Ok(url) => {
            let url = url.trim();
            if url.is_empty() {
                tracing::error!("REDIS_URL is empty; validation cache unavailable");
                None
            } else {
                match redis::Client::open(url) {
                    Ok(client) => Some(client),
                    Err(error) => {
                        tracing::error!(%error, "invalid REDIS_URL; validation cache unavailable");
                        None
                    }
                }
            }
        }
        Err(_) => {
            tracing::error!("REDIS_URL is not configured; validation cache unavailable");
            None
        }
    };

    ValidationCache {
        client,
        namespace,
        connection: Mutex::new(None),
    }
});

impl ValidationCache {
    fn generation_key(&self) -> String {
        format!("{}:validate:generation", self.namespace)
    }

    fn registry_key(&self, game: bool) -> String {
        if game {
            format!("{}:validate:game:registry", self.namespace)
        } else {
            format!("{}:validate:operator:registry", self.namespace)
        }
    }

    fn entry_prefix(&self, game: bool) -> String {
        if game {
            format!("{}:validate:game", self.namespace)
        } else {
            format!("{}:validate:operator", self.namespace)
        }
    }

    async fn connection(&self) -> Result<MultiplexedConnection, ValidationCacheError> {
        let mut slot = self.connection.lock().await;
        if let Some(connection) = slot.as_ref() {
            return Ok(connection.clone());
        }
        let client = self.client.as_ref().ok_or(ValidationCacheError)?;
        let connection = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "validation cache redis connection failed");
                ValidationCacheError
            })?;
        *slot = Some(connection.clone());
        Ok(connection)
    }

    async fn forget_connection(&self) {
        self.connection.lock().await.take();
    }
}

async fn run_script<T>(
    script: &'static redis::Script,
    keys: Vec<String>,
    args: Vec<String>,
) -> Result<T, ValidationCacheError>
where
    T: redis::FromRedisValue,
{
    let cache = &*CACHE;
    let mut connection = cache.connection().await?;
    let mut invocation = script.prepare_invoke();
    for key in keys {
        invocation.key(key);
    }
    for arg in args {
        invocation.arg(arg);
    }
    match invocation.invoke_async::<T>(&mut connection).await {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::warn!(%error, "validation cache redis command failed");
            cache.forget_connection().await;
            Err(ValidationCacheError)
        }
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn ttl_ms_for_status(status: StatusCode) -> u64 {
    if status.as_u16() >= 400 {
        FAILURE_CACHE_TTL_MS
    } else {
        SUCCESS_CACHE_TTL_MS
    }
}

fn decode_envelope<T: DeserializeOwned>(raw: &Option<String>) -> Option<CachedEnvelope<T>> {
    let raw = raw.as_ref()?;
    match serde_json::from_str::<CachedEnvelope<T>>(raw) {
        Ok(envelope) => {
            if StatusCode::from_u16(envelope.status).is_ok() {
                Some(envelope)
            } else {
                tracing::warn!("validation cache entry carries a non-HTTP status; treating as miss");
                None
            }
        }
        Err(error) => {
            tracing::warn!(%error, "corrupt validation cache entry; treating as miss");
            None
        }
    }
}

async fn store_entry(
    game: bool,
    cache_key: String,
    status: StatusCode,
    value_json: String,
) -> Result<(), ValidationCacheError> {
    let ttl_ms = ttl_ms_for_status(status);
    run_script::<i64>(
        &SET_SCRIPT,
        vec![CACHE.generation_key(), CACHE.registry_key(game)],
        vec![
            CACHE.entry_prefix(game),
            cache_key,
            ttl_ms.to_string(),
            unix_now_ms().to_string(),
            MAX_CACHE_ENTRIES.to_string(),
            value_json,
            REGISTRY_TTL_MS.to_string(),
        ],
    )
    .await
    .map(|_| ())
}

pub async fn get_cached_validation(
    cache_key: &str,
) -> Result<Option<CachedValidation>, ValidationCacheError> {
    let raw = run_script::<Option<String>>(
        &GET_SCRIPT,
        vec![CACHE.generation_key()],
        vec![CACHE.entry_prefix(false), cache_key.to_string()],
    )
    .await?;

    match decode_envelope::<ValidationResponse>(&raw) {
        Some(envelope) => Ok(Some(CachedValidation {
            status: StatusCode::from_u16(envelope.status)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            payload: envelope.payload,
        })),
        None => Ok(None),
    }
}

pub async fn set_cached_validation(
    cache_key: String,
    status: StatusCode,
    payload: ValidationResponse,
) -> Result<(), ValidationCacheError> {
    let envelope = CachedEnvelope {
        status: status.as_u16(),
        payload,
    };
    let value_json = serde_json::to_string(&envelope).map_err(|error| {
        tracing::error!(%error, "validation cache serialization failed");
        ValidationCacheError
    })?;
    store_entry(false, cache_key, status, value_json).await
}

pub async fn get_cached_game_validation(
    cache_key: &str,
) -> Result<Option<CachedGameValidation>, ValidationCacheError> {
    let raw = run_script::<Option<String>>(
        &GET_SCRIPT,
        vec![CACHE.generation_key()],
        vec![CACHE.entry_prefix(true), cache_key.to_string()],
    )
    .await?;

    match decode_envelope::<GameValidationResponse>(&raw) {
        Some(envelope) => Ok(Some(CachedGameValidation {
            status: StatusCode::from_u16(envelope.status)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            payload: envelope.payload,
        })),
        None => Ok(None),
    }
}

pub async fn set_cached_game_validation_if_allowed(
    cache_key: String,
    kind: NicknameResultKind,
    status: StatusCode,
    payload: GameValidationResponse,
) -> Result<(), ValidationCacheError> {
    if !should_cache_nickname_result(kind) {
        return Ok(());
    }
    set_cached_game_validation(cache_key, status, payload).await
}

pub async fn set_cached_game_validation(
    cache_key: String,
    status: StatusCode,
    payload: GameValidationResponse,
) -> Result<(), ValidationCacheError> {
    let envelope = CachedEnvelope {
        status: status.as_u16(),
        payload,
    };
    let value_json = serde_json::to_string(&envelope).map_err(|error| {
        tracing::error!(%error, "validation cache serialization failed");
        ValidationCacheError
    })?;
    store_entry(true, cache_key, status, value_json).await
}

/// Bump the cache generation and delete every registered entry. Reads after this
/// call can never observe pre-invalidation payloads. Intended for post-commit
/// invalidation from domain mutations (e.g. catalog/product changes).
pub async fn invalidate_validation_cache() -> Result<u64, ValidationCacheError> {
    let generation = run_script::<i64>(
        &INVALIDATE_SCRIPT,
        vec![
            CACHE.generation_key(),
            CACHE.registry_key(false),
            CACHE.registry_key(true),
        ],
        vec![],
    )
    .await?;
    Ok(generation as u64)
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
    fn success_responses_use_the_thirty_second_ttl() {
        assert_eq!(
            ttl_ms_for_status(StatusCode::OK),
            SUCCESS_CACHE_TTL_MS
        );
    }

    #[test]
    fn definitive_failures_use_the_ten_second_ttl() {
        assert_eq!(
            ttl_ms_for_status(StatusCode::BAD_REQUEST),
            FAILURE_CACHE_TTL_MS
        );
        assert_eq!(
            ttl_ms_for_status(StatusCode::BAD_GATEWAY),
            FAILURE_CACHE_TTL_MS
        );
    }

    #[test]
    fn envelope_round_trips_game_payloads() {
        let payload = GameValidationResponse {
            success: true,
            data: Some(crate::routes::validate::types::GameValidationData {
                user_id: "123456789".to_string(),
                zone_id: Some("1234".to_string()),
                nickname: "tester".to_string(),
            }),
            message: "Nickname berhasil ditemukan".to_string(),
        };
        let envelope = CachedEnvelope {
            status: StatusCode::OK.as_u16(),
            payload: payload.clone(),
        };
        let encoded = serde_json::to_string(&envelope).expect("serialize envelope");
        let decoded: CachedEnvelope<GameValidationResponse> =
            serde_json::from_str(&encoded).expect("deserialize envelope");
        assert_eq!(decoded.status, StatusCode::OK.as_u16());
        assert_eq!(decoded.payload.message, payload.message);
        assert_eq!(
            decoded.payload.data.expect("data").nickname,
            payload.data.expect("original data").nickname
        );
    }

    #[test]
    fn envelope_with_unknown_status_is_treated_as_a_miss() {
        let envelope = CachedEnvelope {
            status: 99,
            payload: sample_game_payload("corrupt"),
        };
        let encoded = serde_json::to_string(&envelope).expect("serialize envelope");
        let raw = Some(encoded);
        assert!(decode_envelope::<GameValidationResponse>(&raw).is_none());
    }

    #[test]
    fn corrupt_entry_is_treated_as_a_miss() {
        let raw = Some("{not json".to_string());
        assert!(decode_envelope::<GameValidationResponse>(&raw).is_none());
    }

    #[test]
    fn missing_entry_is_a_miss() {
        assert!(decode_envelope::<GameValidationResponse>(&None).is_none());
    }
}
