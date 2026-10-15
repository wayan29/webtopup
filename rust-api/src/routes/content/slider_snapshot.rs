//! Versioned slider reads from `content_sliders` and `content_revisions`.

use std::{fmt::Write, time::{SystemTime, UNIX_EPOCH}};

use axum::http::{HeaderMap, HeaderValue, Method, Uri};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::{PgPool, Postgres, Row, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    security::require_proxy_context,
    services::correlation::validate_trace_id,
    state::AppState,
};

use super::{
    PublicSliderItem, MAX_CURRENT_SLIDERS, MAX_PUBLIC_SLIDERS, SLIDER_MUTATION_CONTRACT,
    normalize_slider_link,
};

pub const SLIDER_CAPABILITY_VERSION_HEADER: &str = "x-webtopup-slider-contract-version";
pub const SLIDER_CAPABILITY_TIMESTAMP_HEADER: &str = "x-webtopup-slider-contract-timestamp";
pub const SLIDER_CAPABILITY_ASSERTION_HEADER: &str = "x-webtopup-slider-contract-assertion";
const SLIDER_CAPABILITY_INPUT_VERSION: &str = "slider-contract-capability/v1";
const SLIDER_CAPABILITY_MAX_CLOCK_SKEW_MS: i128 = 30_000;
const SNAPSHOT_ATTEMPTS: usize = 3;
pub const SLIDER_METADATA_COLLECTION: &str = "content_revisions";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderSnapshotError {
    Unavailable,
    Unstable,
}

impl SliderSnapshotError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "SLIDER_SNAPSHOT_UNAVAILABLE",
            Self::Unstable => "SLIDER_SNAPSHOT_UNSTABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderAdminItem {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    pub image: String,
    pub link: String,
    pub sort_order: i64,
    pub status: bool,
    pub lifecycle: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub archived_by: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliderLimits {
    pub total: i64,
    pub active: i64,
    pub current_total: i64,
    pub current_active: i64,
    pub remaining_total: i64,
    pub remaining_active: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SliderAdminSnapshot {
    pub revision: i64,
    pub sliders: Vec<SliderAdminItem>,
    pub limits: SliderLimits,
    #[serde(rename = "mutationContract", skip_serializing_if = "Option::is_none")]
    pub mutation_contract: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct SliderRow {
    pub id: Uuid,
    pub name: String,
    pub image: String,
    pub link: String,
    pub sort_order: i64,
    pub status: bool,
    pub lifecycle: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub archived_by: Option<Uuid>,
}

pub(super) fn mongoose_timestamp(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn admin_item(row: &SliderRow) -> SliderAdminItem {
    SliderAdminItem {
        id: row.id.to_string(),
        name: row.name.clone(),
        image: row.image.clone(),
        link: row.link.clone(),
        sort_order: row.sort_order,
        status: row.status,
        lifecycle: row.lifecycle.clone(),
        created_at: mongoose_timestamp(row.created_at),
        updated_at: mongoose_timestamp(row.updated_at),
        archived_at: row.archived_at.map(mongoose_timestamp),
        archived_by: row.archived_by.map(|value| value.to_string()),
        revision: row.revision,
    }
}

fn public_item(row: &SliderRow) -> PublicSliderItem {
    let mut link = row.link.clone();
    if normalize_slider_link(&link).is_err() {
        link.clear();
    }
    PublicSliderItem { id: row.id.to_string(), name: row.name.clone(), image: row.image.clone(), link }
}

fn row_from(row: &sqlx::postgres::PgRow) -> SliderRow {
    SliderRow {
        id: row.get("id"),
        name: row.get("name"),
        image: row.get("image"),
        link: row.get("link"),
        sort_order: row.get("sort_order"),
        status: row.get("status"),
        lifecycle: row.get("lifecycle"),
        revision: row.get("revision"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        archived_at: row.get("archived_at"),
        archived_by: row.get("archived_by"),
    }
}

const ROW_SQL: &str = "SELECT id, name, image, link, sort_order, status, lifecycle, revision, created_at, updated_at, archived_at, archived_by FROM content_sliders";

pub async fn load_slider_revision(pool: &PgPool) -> Result<i64, SliderSnapshotError> {
    sqlx::query_scalar("SELECT revision FROM content_revisions WHERE domain='sliders'")
        .fetch_optional(pool)
        .await
        .map_err(|_| SliderSnapshotError::Unavailable)?
        .ok_or(SliderSnapshotError::Unavailable)
}

async fn load_rows(pool: &PgPool, lifecycle: &str) -> Result<Vec<SliderRow>, SliderSnapshotError> {
    let sql = format!("{ROW_SQL} WHERE lifecycle=$1 ORDER BY sort_order, id");
    Ok(sqlx::query(&sql)
        .bind(lifecycle)
        .fetch_all(pool)
        .await
        .map_err(|_| SliderSnapshotError::Unavailable)?
        .iter()
        .map(row_from)
        .collect())
}

fn limits(current: &[SliderRow]) -> SliderLimits {
    let current_total = current.len() as i64;
    let current_active = current.iter().filter(|row| row.status).count() as i64;
    SliderLimits {
        total: MAX_CURRENT_SLIDERS,
        active: MAX_PUBLIC_SLIDERS,
        current_total,
        current_active,
        remaining_total: (MAX_CURRENT_SLIDERS - current_total).max(0),
        remaining_active: (MAX_PUBLIC_SLIDERS - current_active).max(0),
    }
}

async fn load_admin(pool: &PgPool, lifecycle: &str) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    for _ in 0..SNAPSHOT_ATTEMPTS {
        let before = load_slider_revision(pool).await?;
        let current = load_rows(pool, "active").await?;
        let listed = if lifecycle == "active" { current.clone() } else { load_rows(pool, lifecycle).await? };
        let after = load_slider_revision(pool).await?;
        if before == after {
            return Ok(SliderAdminSnapshot {
                revision: before,
                limits: limits(&current),
                sliders: listed.iter().map(admin_item).collect(),
                mutation_contract: None,
            });
        }
    }
    Err(SliderSnapshotError::Unstable)
}

pub async fn load_current_snapshot(pool: &PgPool) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    load_admin(pool, "active").await
}

pub async fn load_archived_snapshot(pool: &PgPool) -> Result<SliderAdminSnapshot, SliderSnapshotError> {
    load_admin(pool, "archived").await
}

pub async fn load_public_snapshot(pool: &PgPool) -> Result<(i64, Vec<PublicSliderItem>), SliderSnapshotError> {
    for _ in 0..SNAPSHOT_ATTEMPTS {
        let before = load_slider_revision(pool).await?;
        let mut rows = load_rows(pool, "active").await?;
        rows.retain(|row| row.status);
        rows.truncate(MAX_PUBLIC_SLIDERS as usize);
        let after = load_slider_revision(pool).await?;
        if before == after {
            return Ok((before, rows.iter().map(public_item).collect()));
        }
    }
    Err(SliderSnapshotError::Unstable)
}

pub(super) async fn lock_rows(tx: &mut Transaction<'_, Postgres>) -> Result<(i64, Vec<SliderRow>), sqlx::Error> {
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM content_revisions WHERE domain='sliders' FOR UPDATE")
        .fetch_one(&mut **tx)
        .await?;
    let rows = sqlx::query(&format!("{ROW_SQL} ORDER BY lifecycle, sort_order, id FOR UPDATE"))
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(row_from)
        .collect();
    Ok((revision, rows))
}

pub fn slider_etag(revision: i64) -> String {
    format!("\"sliders-{revision}\"")
}

pub fn slider_capability_mac_input(method: &Method, path: &str, timestamp: &str, correlation_id: &str) -> String {
    [SLIDER_CAPABILITY_INPUT_VERSION, method.as_str(), path, timestamp, correlation_id].join("\n")
}

fn slider_capability_assertion(secret: &str, input: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of every length");
    mac.update(input.as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("String write cannot fail");
    }
    encoded
}

fn trusted_gateway_correlation_id(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(crate::services::correlation::GATEWAY_CORRELATION_HEADER)?.to_str().ok()?;
    if validate_trace_id(value) && value.bytes().all(|byte| !byte.is_ascii_uppercase()) { Some(value) } else { None }
}
fn valid_decimal_timestamp(value: &str) -> Option<i128> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { None } else { value.parse().ok() }
}

fn timestamp_is_fresh(timestamp: &str) -> bool {
    let Some(timestamp) = valid_decimal_timestamp(timestamp) else { return false; };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else { return false; };
    (timestamp - now.as_millis() as i128).abs() <= SLIDER_CAPABILITY_MAX_CLOCK_SKEW_MS
}

pub fn slider_capability_marker(headers: &HeaderMap, state: &AppState, method: &Method, uri: &Uri) -> bool {
    if !state.slider_mutation_readiness.mutation_ready
        || method != Method::GET
        || uri.query().is_some()
        || !matches!(uri.path(), "/v2/sliders/admin/all" | "/v2/sliders/admin/archived")
        || require_proxy_context(headers, state).is_err()
    {
        return false;
    }
    let Some(version) = headers.get(SLIDER_CAPABILITY_VERSION_HEADER).and_then(|value| value.to_str().ok()) else { return false; };
    if version != SLIDER_MUTATION_CONTRACT { return false; }
    let Some(timestamp) = headers.get(SLIDER_CAPABILITY_TIMESTAMP_HEADER).and_then(|value| value.to_str().ok()) else { return false; };
    if !timestamp_is_fresh(timestamp) { return false; }
    let Some(assertion) = headers.get(SLIDER_CAPABILITY_ASSERTION_HEADER).and_then(|value| value.to_str().ok()) else { return false; };
    if assertion.len() != 64 || !assertion.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) { return false; }
    let Some(correlation_id) = trusted_gateway_correlation_id(headers) else { return false; };
    let input = slider_capability_mac_input(method, uri.path(), timestamp, correlation_id);
    slider_capability_assertion(&state.proxy_secret, &input).as_bytes().ct_eq(assertion.as_bytes()).into()
}

pub fn matches_slider_etag(value: Option<&HeaderValue>, revision: i64) -> bool {
    let Some(raw) = value.and_then(|value| value.to_str().ok()) else { return false; };
    let Some(members) = split_entity_tag_list(raw) else { return false; };
    if members.is_empty() || members.iter().any(|member| !valid_entity_tag(member)) { return false; }
    let expected = slider_etag(revision);
    members.iter().any(|member| *member == expected)
}

fn split_entity_tag_list(raw: &str) -> Option<Vec<&str>> {
    let mut members = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    for (index, byte) in raw.bytes().enumerate() {
        if byte == b'"' { in_quotes = !in_quotes; }
        else if !in_quotes && byte == b',' { members.push(raw[start..index].trim()); start = index + 1; }
    }
    if in_quotes { return None; }
    members.push(raw[start..].trim());
    Some(members)
}

fn valid_entity_tag(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' && bytes[1..bytes.len() - 1].iter().all(|byte| byte.is_ascii() && *byte != b'"')
}
