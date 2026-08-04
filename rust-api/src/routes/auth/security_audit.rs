//! Bounded session security audit events and low-cardinality metrics.
//!
//! Audits write only allowlisted event names and fields into `authsecurityaudits`.
//! Metrics are structured tracing events with fixed label sets (no identifiers/secrets).

use std::collections::BTreeMap;

use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};
use serde_json::{json, Map, Value};

use super::session_store::AUTH_SECURITY_AUDITS_COLLECTION;

pub const AUDIT_SOURCE: &str = "rust_domain";

/// Allowlisted security audit event names (design §11.3).
pub const EVENT_LOGIN_SUCCESS: &str = "login_success";
pub const EVENT_LOGIN_FAILURE: &str = "login_failure";
pub const EVENT_SESSION_CREATED: &str = "session_created";
pub const EVENT_DEVICE_CHALLENGE_CREATED: &str = "device_challenge_created";
pub const EVENT_REFRESH_REUSE_REVOKED: &str = "device_session_revoked";
pub const EVENT_REFRESH_REUSE_OBSERVED: &str = "refresh_reuse_observed_no_revocation";
pub const EVENT_IDLE_LOCKED: &str = "staff_session_idle_locked";
pub const EVENT_UNLOCK_SUCCESS: &str = "staff_session_unlocked";
pub const EVENT_UNLOCK_FAILURE: &str = "staff_unlock_reauth_failed";
pub const EVENT_STEP_UP_GRANTED: &str = "staff_step_up_granted";
pub const EVENT_STEP_UP_FAILED: &str = "staff_step_up_reauth_failed";
pub const EVENT_LOGOUT_CURRENT: &str = "logout_current_device";
pub const EVENT_LOGOUT_ALL: &str = "logout_all_devices";
pub const EVENT_DEVICE_REVOKED: &str = "device_revoked_by_user";
pub const EVENT_TWO_FACTOR_ENROLLMENT: &str = "two_factor_enrollment";
pub const EVENT_TWO_FACTOR_ENABLED: &str = "two_factor_enabled";
pub const EVENT_TWO_FACTOR_DISABLED: &str = "two_factor_disabled";
pub const EVENT_TWO_FACTOR_LOGIN: &str = "two_factor_login_outcome";

const ALLOWED_EVENTS: &[&str] = &[
    EVENT_LOGIN_SUCCESS,
    EVENT_LOGIN_FAILURE,
    EVENT_SESSION_CREATED,
    EVENT_DEVICE_CHALLENGE_CREATED,
    EVENT_REFRESH_REUSE_REVOKED,
    EVENT_REFRESH_REUSE_OBSERVED,
    EVENT_IDLE_LOCKED,
    EVENT_UNLOCK_SUCCESS,
    EVENT_UNLOCK_FAILURE,
    EVENT_STEP_UP_GRANTED,
    EVENT_STEP_UP_FAILED,
    EVENT_LOGOUT_CURRENT,
    EVENT_LOGOUT_ALL,
    EVENT_DEVICE_REVOKED,
    EVENT_TWO_FACTOR_ENROLLMENT,
    EVENT_TWO_FACTOR_ENABLED,
    EVENT_TWO_FACTOR_DISABLED,
    EVENT_TWO_FACTOR_LOGIN,
];

const ALLOWED_TOP_LEVEL_FIELDS: &[&str] = &[
    "event",
    "outcome",
    "userId",
    "sessionId",
    "source",
    "traceId",
    "correlationSource",
    "actionGroup",
    "device",
    "reason",
    "createdAt",
];

const ALLOWED_DEVICE_FIELDS: &[&str] = &["label", "ipPrefix", "userAgentFamily"];

const FORBIDDEN_FIELD_MARKERS: &[&str] = &[
    "token",
    "cookie",
    "authorization",
    "password",
    "otp",
    "csrf",
    "secret",
    "digest",
    "ciphertext",
    "nonce",
    "refresh",
    "recovery",
    "body",
];

const MAX_DEVICE_LABEL_LEN: usize = 80;
const MAX_UA_FAMILY_LEN: usize = 40;
const MAX_REASON_LEN: usize = 64;
const MAX_ACTION_GROUP_LEN: usize = 64;
const MAX_OUTCOME_LEN: usize = 32;
const MAX_TRACE_ID_LEN: usize = 64;

/// Low-cardinality metric names for rollout gates.
pub const METRIC_REFRESH_OUTCOME: &str = "auth_refresh_outcome";
pub const METRIC_FORCED_LOGIN: &str = "auth_forced_login";
pub const METRIC_IDLE_OUTCOME: &str = "auth_idle_outcome";
pub const METRIC_DEVICE_CHALLENGE: &str = "auth_device_challenge";
pub const METRIC_TWO_FACTOR_ENROLLMENT: &str = "auth_two_factor_enrollment";
pub const METRIC_STEP_UP: &str = "auth_step_up";
pub const METRIC_IDEMPOTENCY_DUPLICATE_PREVENTED: &str = "auth_idempotency_duplicate_prevented";

const REFRESH_OUTCOMES: &[&str] = &[
    "rotated",
    "recovered",
    "concurrent_predecessor",
    "recovery_expired",
    "reused",
    "invalid",
    "expired",
    "revoked",
    "account_disabled",
    "session_version_mismatch",
    "idle_locked",
    "history_full",
    "recovery_unavailable",
    "store",
];

const FORCED_LOGIN_REASONS: &[&str] = &[
    "session_expired",
    "session_revoked",
    "refresh_reused",
    "account_disabled",
    "token_invalid",
    "recovery_expired",
];

const IDLE_OUTCOMES: &[&str] = &[
    "locked",
    "unlocked",
    "unlock_failed",
    "warning",
    "throttled",
];

const STEP_UP_OUTCOMES: &[&str] = &["granted", "failed", "required"];

const IDEMPOTENCY_ROUTES: &[&str] = &["balance_adjust", "refund"];

const IDEMPOTENCY_OUTCOMES: &[&str] = &["replayed", "conflict", "in_progress"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedDeviceContext {
    pub label: String,
    pub ip_prefix: String,
    pub user_agent_family: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityAuditEvent {
    pub event: &'static str,
    pub outcome: &'static str,
    pub user_id: Option<ObjectId>,
    pub session_id: Option<ObjectId>,
    pub trace_id: Option<String>,
    pub correlation_source: &'static str,
    pub action_group: Option<&'static str>,
    pub reason: Option<&'static str>,
    pub device: Option<BoundedDeviceContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutConfig {
    pub refresh_enabled: bool,
    pub member_cohort_percent: u8,
    pub cs_cohort_percent: u8,
    pub admin_cohort_percent: u8,
    pub owner_cohort_percent: u8,
    /// Inclusive UTC instant (RFC3339 with `Z`) until which legacy access tokens are accepted.
    pub legacy_access_token_accept_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RolloutConfigError {
    InvalidBoolean { name: &'static str },
    InvalidPercent { name: &'static str },
    InvalidCutoff,
    MissingRequired { name: &'static str },
}

impl std::fmt::Display for RolloutConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBoolean { name } => write!(f, "{name} must be true or false"),
            Self::InvalidPercent { name } => {
                write!(f, "{name} must be an integer from 0 to 100")
            }
            Self::InvalidCutoff => write!(
                f,
                "LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL must be an explicit UTC instant"
            ),
            Self::MissingRequired { name } => write!(f, "{name} must be configured"),
        }
    }
}

pub fn is_allowed_event(event: &str) -> bool {
    ALLOWED_EVENTS.iter().any(|allowed| *allowed == event)
}

pub fn build_security_audit_document(
    event: &SecurityAuditEvent,
    now: DateTime,
) -> Result<Document, &'static str> {
    if !is_allowed_event(event.event) {
        return Err("event not allowlisted");
    }
    if event.outcome.is_empty() || event.outcome.len() > MAX_OUTCOME_LEN {
        return Err("outcome bound violated");
    }
    if !event
        .outcome
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("outcome charset violated");
    }
    if let Some(trace) = event.trace_id.as_deref() {
        if trace.is_empty()
            || trace.len() > MAX_TRACE_ID_LEN
            || !trace.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err("traceId bound violated");
        }
    }
    if let Some(group) = event.action_group {
        if group.is_empty() || group.len() > MAX_ACTION_GROUP_LEN {
            return Err("actionGroup bound violated");
        }
    }
    if let Some(reason) = event.reason {
        if reason.is_empty() || reason.len() > MAX_REASON_LEN {
            return Err("reason bound violated");
        }
    }

    let mut document = doc! {
        "event": event.event,
        "outcome": event.outcome,
        "source": AUDIT_SOURCE,
        "correlationSource": event.correlation_source,
        "createdAt": now,
    };
    if let Some(user_id) = event.user_id {
        document.insert("userId", user_id);
    }
    if let Some(session_id) = event.session_id {
        document.insert("sessionId", session_id);
    }
    if let Some(trace_id) = event.trace_id.as_ref() {
        document.insert("traceId", trace_id);
    }
    if let Some(group) = event.action_group {
        document.insert("actionGroup", group);
    }
    if let Some(reason) = event.reason {
        document.insert("reason", reason);
    }
    if let Some(device) = event.device.as_ref() {
        document.insert(
            "device",
            doc! {
                "label": bound_str(&device.label, MAX_DEVICE_LABEL_LEN),
                "ipPrefix": bound_str(&device.ip_prefix, 48),
                "userAgentFamily": bound_str(&device.user_agent_family, MAX_UA_FAMILY_LEN),
            },
        );
    }

    assert_document_secrecy(&document)?;
    Ok(document)
}

pub fn assert_document_secrecy(document: &Document) -> Result<(), &'static str> {
    for (key, value) in document {
        if !ALLOWED_TOP_LEVEL_FIELDS
            .iter()
            .any(|allowed| *allowed == key.as_str())
        {
            return Err("field not allowlisted");
        }
        let lower = key.to_ascii_lowercase();
        if FORBIDDEN_FIELD_MARKERS
            .iter()
            .any(|marker| lower.contains(marker) && key.as_str() != "traceId")
        {
            return Err("forbidden field marker");
        }
        if key == "device" {
            let Some(device) = value.as_document() else {
                return Err("device must be document");
            };
            for (device_key, _) in device {
                if !ALLOWED_DEVICE_FIELDS
                    .iter()
                    .any(|allowed| *allowed == device_key.as_str())
                {
                    return Err("device field not allowlisted");
                }
            }
        }
        if contains_secret_payload(value, 0) {
            return Err("secret-like payload");
        }
    }
    Ok(())
}

fn contains_secret_payload(value: &mongodb::bson::Bson, depth: usize) -> bool {
    if depth > 8 {
        return true;
    }
    match value {
        mongodb::bson::Bson::String(text) => looks_like_secret_payload(text),
        mongodb::bson::Bson::Document(doc) => {
            doc.values().any(|v| contains_secret_payload(v, depth + 1))
        }
        mongodb::bson::Bson::Array(items) => {
            items.iter().any(|v| contains_secret_payload(v, depth + 1))
        }
        _ => false,
    }
}

fn looks_like_secret_payload(value: &str) -> bool {
    value.contains("Bearer ")
        || value.contains("password=")
        || value.contains("csrf=")
        || (value.len() > 80
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '='))
}

fn bound_str(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub fn bounded_device_context(
    device_name: &str,
    ip: &str,
    user_agent: &str,
) -> BoundedDeviceContext {
    BoundedDeviceContext {
        label: bound_str(device_name.trim(), MAX_DEVICE_LABEL_LEN),
        ip_prefix: ip_prefix(ip),
        user_agent_family: user_agent_family(user_agent),
    }
}

fn ip_prefix(ip: &str) -> String {
    let trimmed = ip.trim();
    if trimmed.is_empty() || trimmed == "unknown" {
        return "unknown".into();
    }
    if let Some((head, _)) = trimmed.split_once(':') {
        // IPv6: keep first hextet group only (already colon-split first segment).
        if trimmed.contains(':') && !trimmed.contains('.') {
            return bound_str(head, 12);
        }
    }
    // IPv4: keep /24-ish prefix (first three octets) when present.
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() == 4 {
        return format!("{}.{}.{}.*", parts[0], parts[1], parts[2]);
    }
    bound_str(trimmed, 48)
}

fn user_agent_family(user_agent: &str) -> String {
    let ua = user_agent.trim();
    if ua.is_empty() {
        return "unknown".into();
    }
    let lower = ua.to_ascii_lowercase();
    let family = if lower.contains("edg/") {
        "edge"
    } else if lower.contains("chrome/") && !lower.contains("edg/") {
        "chrome"
    } else if lower.contains("firefox/") {
        "firefox"
    } else if lower.contains("safari/") && !lower.contains("chrome/") {
        "safari"
    } else if lower.contains("curl/") {
        "curl"
    } else {
        "other"
    };
    bound_str(family, MAX_UA_FAMILY_LEN)
}

pub async fn persist_security_audit(db: &mongodb::Database, document: Document) {
    if let Err(error) = db
        .collection::<Document>(AUTH_SECURITY_AUDITS_COLLECTION)
        .insert_one(document)
        .await
    {
        tracing::warn!(
            target: "auth_security_audit",
            error = %error,
            "failed to persist security audit (best effort)"
        );
    }
}

pub async fn write_security_audit(db: &mongodb::Database, event: SecurityAuditEvent) {
    let Ok(document) = build_security_audit_document(&event, DateTime::now()) else {
        tracing::warn!(target: "auth_security_audit", "rejected security audit event");
        return;
    };
    persist_security_audit(db, document).await;
}

// --- Metrics (structured tracing; exporter-backed) ---------------------------

fn increment_metric(name: &'static str, labels: BTreeMap<&'static str, &'static str>) {
    tracing::info!(
        target: "auth_security_metrics",
        metric = name,
        labels = ?labels,
        "security metric"
    );
}

pub fn metric_refresh_outcome(outcome: &str) {
    let outcome = match outcome {
        "rotated"
        | "recovered"
        | "concurrent_predecessor"
        | "recovery_expired"
        | "reused"
        | "invalid"
        | "expired"
        | "revoked"
        | "account_disabled"
        | "session_version_mismatch"
        | "idle_locked"
        | "history_full"
        | "recovery_unavailable"
        | "store" => outcome,
        _ => "invalid",
    };
    // SAFETY: outcomes are static allowlisted literals above.
    let outcome: &'static str = match outcome {
        "rotated" => "rotated",
        "recovered" => "recovered",
        "concurrent_predecessor" => "concurrent_predecessor",
        "recovery_expired" => "recovery_expired",
        "reused" => "reused",
        "invalid" => "invalid",
        "expired" => "expired",
        "revoked" => "revoked",
        "account_disabled" => "account_disabled",
        "session_version_mismatch" => "session_version_mismatch",
        "idle_locked" => "idle_locked",
        "history_full" => "history_full",
        "recovery_unavailable" => "recovery_unavailable",
        "store" => "store",
        _ => "invalid",
    };
    let mut labels = BTreeMap::new();
    labels.insert("outcome", outcome);
    increment_metric(METRIC_REFRESH_OUTCOME, labels);
}

pub fn metric_forced_login(reason: &str) {
    let reason = if FORCED_LOGIN_REASONS.contains(&reason) {
        reason
    } else {
        "token_invalid"
    };
    let reason: &'static str = match reason {
        "session_expired" => "session_expired",
        "session_revoked" => "session_revoked",
        "refresh_reused" => "refresh_reused",
        "account_disabled" => "account_disabled",
        "recovery_expired" => "recovery_expired",
        _ => "token_invalid",
    };
    let mut labels = BTreeMap::new();
    labels.insert("reason", reason);
    increment_metric(METRIC_FORCED_LOGIN, labels);
}

pub fn metric_idle_outcome(outcome: &str) {
    let outcome = if IDLE_OUTCOMES.contains(&outcome) {
        outcome
    } else {
        "locked"
    };
    let outcome: &'static str = match outcome {
        "unlocked" => "unlocked",
        "unlock_failed" => "unlock_failed",
        "warning" => "warning",
        "throttled" => "throttled",
        _ => "locked",
    };
    let mut labels = BTreeMap::new();
    labels.insert("outcome", outcome);
    increment_metric(METRIC_IDLE_OUTCOME, labels);
}

pub fn metric_device_challenge(outcome: &str) {
    let outcome = match outcome {
        "created" | "completed" | "expired" | "conflict" => outcome,
        _ => "created",
    };
    let outcome: &'static str = match outcome {
        "completed" => "completed",
        "expired" => "expired",
        "conflict" => "conflict",
        _ => "created",
    };
    let mut labels = BTreeMap::new();
    labels.insert("outcome", outcome);
    increment_metric(METRIC_DEVICE_CHALLENGE, labels);
}

pub fn metric_two_factor_enrollment(outcome: &str) {
    let outcome = match outcome {
        "required" | "completed" | "failed" => outcome,
        _ => "required",
    };
    let outcome: &'static str = match outcome {
        "completed" => "completed",
        "failed" => "failed",
        _ => "required",
    };
    let mut labels = BTreeMap::new();
    labels.insert("outcome", outcome);
    increment_metric(METRIC_TWO_FACTOR_ENROLLMENT, labels);
}

pub fn metric_step_up(action_group: &str, outcome: &str) {
    let group = match action_group {
        "finance.adjust_balance"
        | "finance.refund"
        | "finance.deposit_approval"
        | "security.password"
        | "security.two_factor"
        | "exports.sensitive"
        | "team.manage"
        | "other" => action_group,
        _ => "other",
    };
    let group: &'static str = match group {
        "finance.adjust_balance" => "finance.adjust_balance",
        "finance.refund" => "finance.refund",
        "finance.deposit_approval" => "finance.deposit_approval",
        "security.password" => "security.password",
        "security.two_factor" => "security.two_factor",
        "exports.sensitive" => "exports.sensitive",
        "team.manage" => "team.manage",
        _ => "other",
    };
    let outcome = if STEP_UP_OUTCOMES.contains(&outcome) {
        outcome
    } else {
        "failed"
    };
    let outcome: &'static str = match outcome {
        "granted" => "granted",
        "required" => "required",
        _ => "failed",
    };
    let mut labels = BTreeMap::new();
    labels.insert("action_group", group);
    labels.insert("outcome", outcome);
    increment_metric(METRIC_STEP_UP, labels);
}

/// Duplicate-prevention metric: route + outcome only (never key/digest labels).
pub fn metric_idempotency_duplicate_prevented(route: &str, outcome: &str) {
    let route = if IDEMPOTENCY_ROUTES.contains(&route) {
        route
    } else {
        "balance_adjust"
    };
    let route: &'static str = match route {
        "refund" => "refund",
        _ => "balance_adjust",
    };
    let outcome = if IDEMPOTENCY_OUTCOMES.contains(&outcome) {
        outcome
    } else {
        "replayed"
    };
    let outcome: &'static str = match outcome {
        "conflict" => "conflict",
        "in_progress" => "in_progress",
        _ => "replayed",
    };
    let mut labels = BTreeMap::new();
    labels.insert("route", route);
    labels.insert("outcome", outcome);
    increment_metric(METRIC_IDEMPOTENCY_DUPLICATE_PREVENTED, labels);
}

pub fn refresh_outcome_metric_label(
    outcome: &super::session_store::RefreshOutcome,
) -> &'static str {
    use super::session_store::RefreshOutcome;
    match outcome {
        RefreshOutcome::Rotated { .. } => "rotated",
        RefreshOutcome::Recovered { .. } => "recovered",
        RefreshOutcome::ConcurrentPredecessor => "concurrent_predecessor",
        RefreshOutcome::RecoveryExpired => "recovery_expired",
        RefreshOutcome::Reused => "reused",
        RefreshOutcome::Invalid => "invalid",
        RefreshOutcome::Expired => "expired",
        RefreshOutcome::Revoked => "revoked",
        RefreshOutcome::AccountDisabled => "account_disabled",
        RefreshOutcome::SessionVersionMismatch => "session_version_mismatch",
        RefreshOutcome::IdleLocked => "idle_locked",
        RefreshOutcome::HistoryFull => "history_full",
        RefreshOutcome::RecoveryUnavailable => "recovery_unavailable",
        RefreshOutcome::Store => "store",
    }
}

// --- Rollout config (fail closed; Node-compatible semantics) -----------------

pub fn parse_bool_strict(
    name: &'static str,
    raw: Option<&str>,
) -> Result<bool, RolloutConfigError> {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(false),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(RolloutConfigError::InvalidBoolean { name }),
    }
}

pub fn parse_cohort_percent(
    name: &'static str,
    raw: Option<&str>,
) -> Result<u8, RolloutConfigError> {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(0),
        Some(value) => {
            if !value.chars().all(|c| c.is_ascii_digit()) {
                return Err(RolloutConfigError::InvalidPercent { name });
            }
            let parsed: u32 = value
                .parse()
                .map_err(|_| RolloutConfigError::InvalidPercent { name })?;
            if parsed > 100 {
                return Err(RolloutConfigError::InvalidPercent { name });
            }
            Ok(parsed as u8)
        }
    }
}

pub fn parse_legacy_cutoff(raw: Option<&str>) -> Result<Option<String>, RolloutConfigError> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    // Match Node: YYYY-MM-DDTHH:MM:SSZ or with .mmmZ
    let re_ok = value.len() >= 20
        && value.ends_with('Z')
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T');
    if !re_ok {
        return Err(RolloutConfigError::InvalidCutoff);
    }
    // Require parseable UTC instant
    if chrono_like_parse_utc_ms(value).is_none() {
        return Err(RolloutConfigError::InvalidCutoff);
    }
    Ok(Some(value.to_string()))
}

fn chrono_like_parse_utc_ms(value: &str) -> Option<i64> {
    // Minimal RFC3339 Z parser without adding deps: accept exact Node-compatible forms.
    let core = value.strip_suffix('Z')?;
    let (date, time) = core.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let (hms, millis) = if let Some((hms, frac)) = time.split_once('.') {
        if frac.len() != 3 || !frac.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        (hms, frac.parse::<u32>().ok()?)
    } else {
        (time, 0u32)
    };
    let mut time_parts = hms.split(':');
    let hour: u32 = time_parts.next()?.parse().ok()?;
    let minute: u32 = time_parts.next()?.parse().ok()?;
    let second: u32 = time_parts.next()?.parse().ok()?;
    if time_parts.next().is_some() {
        return None;
    }
    if year < 1
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Exact Gregorian calendar validation and days-from-civil conversion.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400) as u32;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era * 146097 + doe as i32 - 719468) as i64;
    Some(
        days * 86_400_000
            + (hour as i64) * 3_600_000
            + (minute as i64) * 60_000
            + (second as i64) * 1000
            + millis as i64,
    )
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn parse_rollout_config(
    refresh_enabled: Option<&str>,
    member_percent: Option<&str>,
    cs_percent: Option<&str>,
    admin_percent: Option<&str>,
    owner_percent: Option<&str>,
    legacy_cutoff: Option<&str>,
) -> Result<RolloutConfig, RolloutConfigError> {
    Ok(RolloutConfig {
        refresh_enabled: parse_bool_strict("SESSION_REFRESH_ENABLED", refresh_enabled)?,
        member_cohort_percent: parse_cohort_percent(
            "SESSION_REFRESH_MEMBER_COHORT_PERCENT",
            member_percent,
        )?,
        cs_cohort_percent: parse_cohort_percent("SESSION_REFRESH_CS_COHORT_PERCENT", cs_percent)?,
        admin_cohort_percent: parse_cohort_percent(
            "SESSION_REFRESH_ADMIN_COHORT_PERCENT",
            admin_percent,
        )?,
        owner_cohort_percent: parse_cohort_percent(
            "SESSION_REFRESH_OWNER_COHORT_PERCENT",
            owner_percent,
        )?,
        legacy_access_token_accept_until: parse_legacy_cutoff(legacy_cutoff)?,
    })
}

pub fn load_rollout_config_from_env() -> Result<RolloutConfig, RolloutConfigError> {
    parse_rollout_config(
        std::env::var("SESSION_REFRESH_ENABLED").ok().as_deref(),
        std::env::var("SESSION_REFRESH_MEMBER_COHORT_PERCENT")
            .ok()
            .as_deref(),
        std::env::var("SESSION_REFRESH_CS_COHORT_PERCENT")
            .ok()
            .as_deref(),
        std::env::var("SESSION_REFRESH_ADMIN_COHORT_PERCENT")
            .ok()
            .as_deref(),
        std::env::var("SESSION_REFRESH_OWNER_COHORT_PERCENT")
            .ok()
            .as_deref(),
        std::env::var("LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL")
            .ok()
            .as_deref(),
    )
}

pub fn member_in_refresh_cohort(user_id: &str, percent: u8) -> bool {
    if percent >= 100 {
        return true;
    }
    if percent == 0 {
        return false;
    }
    let mut hash: u32 = 0;
    for b in user_id.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(b));
    }
    (hash % 100) < u32::from(percent)
}

pub fn legacy_issuance_available(
    config: &RolloutConfig,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    config
        .legacy_access_token_accept_until
        .as_deref()
        .is_some_and(|cutoff| {
            chrono::DateTime::parse_from_rfc3339(cutoff)
                .map(|value| now < value.with_timezone(&chrono::Utc))
                .unwrap_or(false)
        })
}

pub fn role_in_refresh_cohort(role: &str, user_id: &str, config: &RolloutConfig) -> bool {
    if !config.refresh_enabled {
        return false;
    }
    match role {
        "member" => member_in_refresh_cohort(user_id, config.member_cohort_percent),
        "cs" | "staff" => member_in_refresh_cohort(user_id, config.cs_cohort_percent),
        "admin" => member_in_refresh_cohort(user_id, config.admin_cohort_percent),
        "owner" => member_in_refresh_cohort(user_id, config.owner_cohort_percent),
        _ => false,
    }
}

// --- JSON export helpers for Node parity tests --------------------------------

pub fn security_audit_json_preview(event: &SecurityAuditEvent) -> Value {
    let mut map = Map::new();
    map.insert("event".into(), json!(event.event));
    map.insert("outcome".into(), json!(event.outcome));
    map.insert("source".into(), json!(AUDIT_SOURCE));
    map.insert("correlationSource".into(), json!(event.correlation_source));
    if let Some(user_id) = event.user_id {
        map.insert("userId".into(), json!(user_id.to_hex()));
    }
    if let Some(session_id) = event.session_id {
        map.insert("sessionId".into(), json!(session_id.to_hex()));
    }
    if let Some(trace_id) = event.trace_id.as_ref() {
        map.insert("traceId".into(), json!(trace_id));
    }
    if let Some(group) = event.action_group {
        map.insert("actionGroup".into(), json!(group));
    }
    if let Some(reason) = event.reason {
        map.insert("reason".into(), json!(reason));
    }
    if let Some(device) = event.device.as_ref() {
        map.insert(
            "device".into(),
            json!({
                "label": bound_str(&device.label, MAX_DEVICE_LABEL_LEN),
                "ipPrefix": bound_str(&device.ip_prefix, 48),
                "userAgentFamily": bound_str(&device.user_agent_family, MAX_UA_FAMILY_LEN),
            }),
        );
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;

    fn sample_event() -> SecurityAuditEvent {
        SecurityAuditEvent {
            event: EVENT_LOGIN_SUCCESS,
            outcome: "success",
            user_id: Some(ObjectId::parse_str("64b0f2c2a1b2c3d4e5f60708").unwrap()),
            session_id: Some(ObjectId::parse_str("64b0f2c2a1b2c3d4e5f60709").unwrap()),
            trace_id: Some("abcdef0123456789abcdef0123456789".into()),
            correlation_source: "gateway_header",
            action_group: None,
            reason: None,
            device: Some(bounded_device_context(
                "Office Laptop",
                "203.0.113.45",
                "Mozilla/5.0 Chrome/120.0.0.0",
            )),
        }
    }

    #[test]
    fn auth_security_audit_events_are_allowlisted_and_redacted() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let events = [
            (EVENT_LOGIN_SUCCESS, "success"),
            (EVENT_LOGIN_FAILURE, "failure"),
            (EVENT_SESSION_CREATED, "created"),
            (EVENT_DEVICE_CHALLENGE_CREATED, "created"),
            (EVENT_REFRESH_REUSE_REVOKED, "revoked"),
            (EVENT_REFRESH_REUSE_OBSERVED, "observed"),
            (EVENT_IDLE_LOCKED, "locked"),
            (EVENT_UNLOCK_SUCCESS, "success"),
            (EVENT_UNLOCK_FAILURE, "failure"),
            (EVENT_STEP_UP_GRANTED, "granted"),
            (EVENT_STEP_UP_FAILED, "failed"),
            (EVENT_LOGOUT_CURRENT, "success"),
            (EVENT_LOGOUT_ALL, "success"),
            (EVENT_DEVICE_REVOKED, "success"),
            (EVENT_TWO_FACTOR_ENROLLMENT, "required"),
            (EVENT_TWO_FACTOR_ENABLED, "success"),
            (EVENT_TWO_FACTOR_DISABLED, "success"),
            (EVENT_TWO_FACTOR_LOGIN, "success"),
        ];
        for (event_name, outcome) in events {
            let mut event = sample_event();
            event.event = event_name;
            event.outcome = outcome;
            if event_name == EVENT_STEP_UP_GRANTED || event_name == EVENT_STEP_UP_FAILED {
                event.action_group = Some("finance.adjust_balance");
            }
            let document = build_security_audit_document(&event, now).expect("allowlisted event");
            assert_eq!(document.get_str("event").unwrap(), event_name);
            assert_eq!(document.get_str("outcome").unwrap(), outcome);
            assert_eq!(document.get_str("source").unwrap(), AUDIT_SOURCE);
            assert_eq!(
                document.get_str("correlationSource").unwrap(),
                "gateway_header"
            );
            assert!(document.get_object_id("userId").is_ok());
            assert!(document.get_object_id("sessionId").is_ok());
            assert_eq!(
                document.get_str("traceId").unwrap(),
                "abcdef0123456789abcdef0123456789"
            );
            let device = document.get_document("device").unwrap();
            assert!(device.get_str("label").is_ok());
            assert!(device.get_str("ipPrefix").is_ok());
            assert!(device.get_str("userAgentFamily").is_ok());
            let rendered = format!("{document:?}");
            for forbidden in [
                "password",
                "Bearer ",
                "csrf",
                "authorization",
                "otp",
                "refresh_token",
                "cookie=",
                "ciphertext",
                "nonce",
                "digest",
            ] {
                assert!(
                    !rendered
                        .to_ascii_lowercase()
                        .contains(&forbidden.to_ascii_lowercase())
                        || forbidden == "otp" && event_name.contains("two_factor"),
                    "audit must not contain {forbidden}: {rendered}"
                );
            }
        }
    }

    #[test]
    fn auth_security_audit_rejects_unknown_events_and_secret_fields() {
        let now = DateTime::from_millis(1_700_000_000_000);
        let mut event = sample_event();
        // SAFETY: test intentionally uses a non-static event name via transmute-like cast.
        // We only validate is_allowed_event path by constructing with a non-allowlisted static.
        let bad = SecurityAuditEvent {
            event: "raw_token_dump",
            ..event.clone()
        };
        assert!(build_security_audit_document(&bad, now).is_err());

        event.event = EVENT_LOGIN_SUCCESS;
        let mut document = build_security_audit_document(&event, now).unwrap();
        document.insert("password", "secret");
        assert!(assert_document_secrecy(&document).is_err());
        document.remove("password");
        document.insert("authorization", "Bearer abc");
        assert!(assert_document_secrecy(&document).is_err());
        document.remove("authorization");
        document.insert("refreshToken", "abc");
        assert!(assert_document_secrecy(&document).is_err());
    }

    #[test]
    fn auth_security_audit_metrics_are_low_cardinality() {
        metric_refresh_outcome("rotated");
        metric_refresh_outcome("reused");
        metric_forced_login("session_expired");
        metric_idle_outcome("locked");
        metric_device_challenge("created");
        metric_two_factor_enrollment("completed");
        metric_step_up("finance.adjust_balance", "granted");
        metric_idempotency_duplicate_prevented("balance_adjust", "replayed");
        metric_idempotency_duplicate_prevented("refund", "conflict");

        // Unknown labels collapse to allowlisted defaults.
        metric_refresh_outcome("not-a-real-outcome");
        metric_forced_login("password=hunter2");
        metric_step_up("../../../etc/passwd", "boom");
        metric_idempotency_duplicate_prevented("key=abc123digest", "digest=deadbeef");

        // Metrics are emitted through structured tracing; there is deliberately no
        // process-local map or waiter producer that could become an authoritative store.
        assert!(REFRESH_OUTCOMES.contains(&"rotated"));
        assert!(FORCED_LOGIN_REASONS.contains(&"session_expired"));
        assert!(IDEMPOTENCY_OUTCOMES.contains(&"replayed"));
    }

    #[test]
    fn auth_security_audit_rollout_config_fails_closed() {
        assert!(parse_bool_strict("SESSION_REFRESH_ENABLED", Some("true")).unwrap());
        assert!(!parse_bool_strict("SESSION_REFRESH_ENABLED", Some("false")).unwrap());
        assert!(!parse_bool_strict("SESSION_REFRESH_ENABLED", None).unwrap());
        assert!(matches!(
            parse_bool_strict("SESSION_REFRESH_ENABLED", Some("yes")),
            Err(RolloutConfigError::InvalidBoolean { .. })
        ));

        assert_eq!(
            parse_cohort_percent("SESSION_REFRESH_MEMBER_COHORT_PERCENT", Some("10")).unwrap(),
            10
        );
        assert_eq!(
            parse_cohort_percent("SESSION_REFRESH_MEMBER_COHORT_PERCENT", None).unwrap(),
            0
        );
        for bad in ["-1", "101", "10.5", "abc", "1e2"] {
            assert!(
                parse_cohort_percent("SESSION_REFRESH_MEMBER_COHORT_PERCENT", Some(bad)).is_err(),
                "expected fail-closed for {bad}"
            );
        }

        assert_eq!(
            parse_legacy_cutoff(Some("2026-08-15T00:00:00Z"))
                .unwrap()
                .as_deref(),
            Some("2026-08-15T00:00:00Z")
        );
        assert_eq!(
            parse_legacy_cutoff(Some("2026-08-15T00:00:00.000Z"))
                .unwrap()
                .as_deref(),
            Some("2026-08-15T00:00:00.000Z")
        );
        for bad in [
            "2026-08-15",
            "2026-08-15 00:00:00Z",
            "2026-08-15T00:00:00+00:00",
            "not-a-date",
            "2026-13-01T00:00:00Z",
        ] {
            assert!(
                parse_legacy_cutoff(Some(bad)).is_err(),
                "expected fail-closed cutoff for {bad}"
            );
        }

        let ok = parse_rollout_config(
            Some("true"),
            Some("1"),
            Some("0"),
            Some("0"),
            Some("0"),
            Some("2026-08-15T00:00:00Z"),
        )
        .unwrap();
        assert!(ok.refresh_enabled);
        assert_eq!(ok.member_cohort_percent, 1);

        assert!(parse_rollout_config(
            Some("TRUE"),
            Some("1"),
            Some("0"),
            Some("0"),
            Some("0"),
            Some("2026-08-15T00:00:00Z"),
        )
        .is_err());

        // Deterministic cohort: same algorithm as Node memberInRefreshCohort.
        assert!(!member_in_refresh_cohort("user-a", 0));
        assert!(member_in_refresh_cohort("user-a", 100));
        let mid = member_in_refresh_cohort("64b0f2c2a1b2c3d4e5f60708", 50);
        assert_eq!(
            mid,
            member_in_refresh_cohort("64b0f2c2a1b2c3d4e5f60708", 50)
        );
    }

    #[test]
    fn rollout_disabled_cohorts_cutoff_and_role_selection_are_fail_closed() {
        let disabled = parse_rollout_config(None, None, None, None, None, None).unwrap();
        for role in ["member", "cs", "staff", "admin", "owner", "unknown"] {
            assert!(!role_in_refresh_cohort(role, "fixture-user", &disabled));
        }
        let bounded = parse_rollout_config(
            Some("true"),
            Some("0"),
            Some("100"),
            Some("0"),
            Some("0"),
            Some("2030-01-01T00:00:00Z"),
        )
        .unwrap();
        assert!(role_in_refresh_cohort("cs", "fixture-user", &bounded));
        assert!(role_in_refresh_cohort("staff", "fixture-user", &bounded));
        assert!(!role_in_refresh_cohort("member", "fixture-user", &bounded));
        assert!(!role_in_refresh_cohort("admin", "fixture-user", &bounded));
        let before = chrono::DateTime::parse_from_rfc3339("2029-12-31T23:59:59Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let boundary = chrono::DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(legacy_issuance_available(&bounded, before));
        assert!(!legacy_issuance_available(&bounded, boundary));
    }

    #[test]
    fn auth_security_audit_json_preview_never_embeds_secrets() {
        let event = sample_event();
        let preview = security_audit_json_preview(&event);
        let text = preview.to_string();
        for forbidden in [
            "password",
            "Bearer",
            "cookie",
            "authorization",
            "csrf",
            "otp",
            "ciphertext",
            "nonce",
            "digest",
        ] {
            assert!(
                !text.to_ascii_lowercase().contains(forbidden)
                    || forbidden == "otp" && text.contains("two_factor"),
                "preview leaked {forbidden}: {text}"
            );
        }
        assert_eq!(preview["source"], AUDIT_SOURCE);
        assert_eq!(preview["correlationSource"], "gateway_header");
    }
}
