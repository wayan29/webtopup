//! SQL store primitives shared by the settings domain: consistent revisioned snapshots,
//! transactional mutation locks, frozen idempotent replies, and atomic audit rows.

use serde_json::{Map, Value};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
use super::defaults::default_site_settings;
use crate::services::correlation::{
    self, validate_trace_id, CorrelationResolution, CorrelationSource, GATEWAY_CORRELATION_HEADER,
};

/// Revision domains stored in `content_revisions`.
pub const SETTINGS_DOMAIN: &str = "settings";
pub const SLIDERS_DOMAIN: &str = "sliders";

/// Single-statement snapshot: the domain revision and every stored setting row are read from one
/// statement snapshot, so a concurrent committed mutation can never split a read.
const DOMAIN_SNAPSHOT_QUERY: &str =
    "SELECT (SELECT revision FROM content_revisions WHERE domain = $1) AS revision, \
     COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) AS settings FROM site_settings";

pub async fn load_settings(pool: &PgPool, selected: &[&str]) -> Result<Map<String, Value>, sqlx::Error> {
    let (_, settings) = load_domain_snapshot(pool, SETTINGS_DOMAIN).await?;
    Ok(retain_selected(settings, selected))
}

pub async fn load_domain_snapshot(
    pool: &PgPool,
    domain: &str,
) -> Result<(i64, Map<String, Value>), sqlx::Error> {
    let row = sqlx::query(DOMAIN_SNAPSHOT_QUERY)
        .bind(domain)
        .fetch_one(pool)
        .await?;
    Ok((row.try_get::<i64, _>("revision")?, settings_from_row(&row)?))
}

pub async fn load_domain_snapshot_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    domain: &str,
) -> Result<(i64, Map<String, Value>), sqlx::Error> {
    let row = sqlx::query(DOMAIN_SNAPSHOT_QUERY)
        .bind(domain)
        .fetch_one(&mut **tx)
        .await?;
    Ok((row.try_get::<i64, _>("revision")?, settings_from_row(&row)?))
}

/// Authoritative in-transaction settings read used by the bulk mutation.
pub async fn load_settings_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    selected: &[&str],
) -> Result<Map<String, Value>, sqlx::Error> {
    let (_, settings) = load_domain_snapshot_in_tx(tx, SETTINGS_DOMAIN).await?;
    Ok(retain_selected(settings, selected))
}

fn settings_from_row(row: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, sqlx::Error> {
    let stored = row.try_get::<Value, _>("settings")?;
    let mut settings = default_site_settings();
    if let Value::Object(stored) = stored {
        for (key, value) in stored {
            settings.insert(key, value);
        }
    }
    Ok(settings)
}

fn retain_selected(mut settings: Map<String, Value>, selected: &[&str]) -> Map<String, Value> {
    if !selected.is_empty() {
        settings.retain(|key, _| selected.contains(&key.as_str()));
    }
    settings
}

/// Serialize mutations inside one domain: the row lock also pins the revision the caller reads.
pub async fn lock_revision(tx: &mut Transaction<'_, Postgres>, domain: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT revision FROM content_revisions WHERE domain=$1 FOR UPDATE")
        .bind(domain)
        .fetch_one(&mut **tx)
        .await
}

pub async fn bump_revision(tx: &mut Transaction<'_, Postgres>, domain: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("UPDATE content_revisions SET revision = revision + 1 WHERE domain=$1 RETURNING revision")
        .bind(domain)
        .fetch_one(&mut **tx)
        .await
}

pub async fn upsert_setting(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    value: &Value,
    revision: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO site_settings(key, value, revision, updated_at) VALUES($1, $2, $3, now()) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .bind(revision)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    operation: &str,
    key: &str,
    digest: &str,
) -> Result<Option<(i32, Value)>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT digest, status, response FROM content_mutation_replies \
         WHERE actor=$1 AND operation=$2 AND key=$3",
    )
    .bind(actor)
    .bind(operation)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|r| {
        if r.get::<String, _>("digest") != digest {
            (
                409,
                serde_json::json!({
                    "message": "Idempotency key digunakan untuk payload berbeda",
                    "error": {"code": "IDEMPOTENCY_CONFLICT"}
                }),
            )
        } else {
            (r.get("status"), r.get("response"))
        }
    }))
}

pub async fn freeze(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    operation: &str,
    key: &str,
    digest: &str,
    status: i32,
    body: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO content_mutation_replies(actor, operation, key, digest, status, response) \
         VALUES($1, $2, $3, $4, $5, $6)",
    )
    .bind(actor)
    .bind(operation)
    .bind(key)
    .bind(digest)
    .bind(status)
    .bind(body)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A frozen reply replay marks the stored body so clients can distinguish the retry.
pub fn completed_replay_body(mut stored: Value) -> Value {
    if let Some(object) = stored.as_object_mut() {
        object.insert("replayed".to_string(), Value::Bool(true));
    }
    stored
}
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    action: &str,
    correlation: &str,
    payload: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events(actor, action, outcome, correlation, payload) \
         VALUES($1, $2, 'success', $3, $4)",
    )
    .bind(actor.to_string())
    .bind(action)
    .bind(correlation)
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Trusted correlation resolution: callers must have verified the exact proxy secret first.
pub fn trusted_correlation(headers: &axum::http::HeaderMap) -> CorrelationResolution {
    let span_trace = correlation::current_span_correlation_trace_id();
    if let Some(value) = headers
        .get(GATEWAY_CORRELATION_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| validate_trace_id(value))
    {
        return CorrelationResolution {
            trace_id: Some(value.to_ascii_lowercase()),
            source: CorrelationSource::GatewayHeader,
        };
    }
    correlation::resolve_correlation_untrusted(headers, span_trace.as_deref())
}

/// Managed reference for a settings field: acquire the new managed path, retire the previous one.
pub async fn acquire_setting_reference(
    tx: &mut Transaction<'_, Postgres>,
    path: &str,
    resource: &str,
) -> Result<(), crate::services::managed_asset_registry::RegistryError> {
    crate::services::managed_asset_registry::acquire_reference(tx, path, resource).await
}

/// Retiring a previous reference must never fail on legacy data that predates the registry.
pub async fn retire_reference(
    tx: &mut Transaction<'_, Postgres>,
    path: &str,
    resource: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM asset_references WHERE path=$1 AND resource=$2")
        .bind(path)
        .bind(resource)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub fn mutation_key(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| v.len() >= 8 && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)))
        .map(str::to_owned)
}

