use axum::{http::HeaderMap, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use uuid::Uuid;
use serde::Serialize;
use subtle::ConstantTimeEq;

use crate::services::correlation::{
    self, validate_trace_id, CorrelationResolution, CorrelationSource, GATEWAY_CORRELATION_HEADER,
};
use crate::state::AppState;

#[derive(Clone)]
pub struct ProxyContext {
    pub user_id: Option<String>,
    pub user_role: Option<String>,
    pub user_email: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyContextResponse {
    pub id: Option<String>,
    pub role: Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub message: &'static str,
}

pub struct AuthenticatedProxyUser {
    pub id: Uuid,
    pub role: String,
    pub email: String,
    pub permissions: Vec<String>,
    pub two_factor_enrollment_required_at: Option<DateTime<Utc>>,
    pub two_factor_enrollment_completed_at: Option<DateTime<Utc>>,
    pub two_factor_enabled: bool,
}


pub fn require_proxy_context(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<ProxyContext, axum::response::Response> {
    let provided_secret = headers
        .get("x-api-v2-proxy-secret")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let provided = provided_secret.as_bytes();
    let expected = state.proxy_secret.as_bytes();
    let exact_secret = provided.len() == expected.len() && provided.ct_eq(expected).into();
    if !exact_secret {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                message: "API v2 proxy access required",
            }),
        )
            .into_response());
    }

    Ok(ProxyContext {
        user_id: header_text(headers, "x-webtopup-user-id"),
        user_role: header_text(headers, "x-webtopup-user-role"),
        user_email: header_text(headers, "x-webtopup-user-email"),
        session_id: header_text(headers, "x-webtopup-session-id"),
    })
}

/// SQL authorization rechecks signed access credentials and current database state per request.
pub async fn require_sql_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<crate::sql_auth::SqlAuthenticatedUser, axum::response::Response> {
    require_proxy_context(headers, state)?;
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":{"code":"AUTH_TOKEN_INVALID","message":"Unauthorized: Invalid token"}})),
        ).into_response())?;
    crate::sql_auth::admit_access(&state.pg_pool, token, &state.jwt_secret, chrono::Utc::now())
        .await.map_err(IntoResponse::into_response)
}

pub async fn require_sql_permission(
    headers: &HeaderMap,
    state: &AppState,
    permission: &str,
) -> Result<crate::sql_auth::SqlAuthenticatedUser, axum::response::Response> {
    let user = require_sql_user(headers, state).await?;
    if user.role != "owner" && !user.permissions.iter().any(|granted| granted == permission) {
        return Err((axum::http::StatusCode::FORBIDDEN,
            Json(serde_json::json!({"message":"Forbidden: Insufficient permissions"}))).into_response());
    }
    Ok(user)
}

/// Trusted session identity is accepted only after exact proxy-secret validation.
pub fn trusted_session_id(headers: &HeaderMap, state: &AppState) -> Option<String> {
    require_proxy_context(headers, state)
        .ok()
        .and_then(|ctx| ctx.session_id)
        .filter(|sid| Uuid::parse_str(sid).is_ok())
}

/// TraceLayer and other request-scoped callers must use this entry point so gateway header trust
/// is gated on exact proxy-secret validation in this module only.
pub fn resolve_request_trace_layer_correlation(
    headers: &HeaderMap,
    state: &AppState,
    request_span_trace_id: Option<&str>,
) -> CorrelationResolution {
    if require_proxy_context(headers, state).is_ok() {
        resolve_trusted_span_or_gateway_correlation(headers, request_span_trace_id)
    } else {
        correlation::resolve_correlation_untrusted(headers, request_span_trace_id)
    }
}

pub async fn load_active_proxy_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<AuthenticatedProxyUser, axum::response::Response> {
    let user = crate::sql_auth::current(headers, state)
        .await
        .map_err(IntoResponse::into_response)?;
    Ok(AuthenticatedProxyUser {
        id: user.id,
        role: user.role,
        email: user.email,
        permissions: user.permissions,
        two_factor_enrollment_required_at: user.two_factor_enrollment_required_at,
        two_factor_enrollment_completed_at: user.two_factor_enrollment_completed_at,
        two_factor_enabled: user.two_factor_enabled,
    })
}
async fn load_active_sql_proxy_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<(String, bool, Option<DateTime<Utc>>), axum::response::Response> {
    let user = load_active_proxy_user(headers, state).await?;
    Ok((user.role, true, user.two_factor_enrollment_required_at))
}

pub async fn enforce_two_factor_enrollment(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    // Unlock authenticates the locked session using its credential pair, password, and OTP.
    // Ordinary bearer admission here would reject it before that verification can run.
    if request.method() == axum::http::Method::POST && request.uri().path() == "/v2/auth/unlock" {
        return next.run(request).await;
    }
    if require_proxy_context(request.headers(), &state)
        .ok()
        .and_then(|context| context.user_id)
        .is_some()
    {
        match load_active_sql_proxy_user(request.headers(), &state).await {
            Ok((role, enabled, required_at))
                if two_factor_enrollment_overdue(
                    &role,
                    enabled,
                    required_at,
                    Utc::now(),
                ) && !is_two_factor_enrollment_allowed_route(
                    request.method(),
                    request.uri().path(),
                ) =>
            {
                return crate::sql_auth::AuthError::new(
                    axum::http::StatusCode::FORBIDDEN,
                    "AUTH_2FA_ENROLLMENT_REQUIRED",
                    "Aktifkan autentikasi dua faktor untuk melanjutkan",
                )
                .into_response();
            }
            Ok(_) => {}
            Err(response) => return response,
        }
    }
    next.run(request).await
}


pub async fn require_member_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<AuthenticatedProxyUser, axum::response::Response> {
    let user = load_active_proxy_user(headers, state).await?;
    if user.role != "member" {
        return Err(error_response(
            axum::http::StatusCode::FORBIDDEN,
            "Hanya member yang dapat mengakses data ini",
        ));
    }
    Ok(user)
}

pub async fn require_team_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<AuthenticatedProxyUser, axum::response::Response> {
    let user = load_active_proxy_user(headers, state).await?;
    if !matches!(user.role.as_str(), "owner" | "admin" | "cs") {
        return Err(error_response(
            axum::http::StatusCode::FORBIDDEN,
            "Forbidden: No access to admin panel",
        ));
    }
    Ok(user)
}

pub async fn require_permission(
    headers: &HeaderMap,
    state: &AppState,
    permission: &str,
) -> Result<AuthenticatedProxyUser, axum::response::Response> {
    require_any_permission(headers, state, &[permission]).await
}

pub async fn require_any_permission(
    headers: &HeaderMap,
    state: &AppState,
    permissions: &[&str],
) -> Result<AuthenticatedProxyUser, axum::response::Response> {
    let user = require_team_user(headers, state).await?;
    if team_user_has_any_permission(&user.role, &user.permissions, permissions) {
        return Ok(user);
    }
    Err(error_response(
        axum::http::StatusCode::FORBIDDEN,
        "Forbidden: Permission denied",
    ))
}

pub(crate) fn team_user_has_any_permission(
    role: &str,
    permissions: &[String],
    required: &[&str],
) -> bool {
    if role == "owner" {
        return true;
    }
    if !matches!(role, "admin" | "cs") {
        return false;
    }
    required
        .iter()
        .any(|permission| has_resolved_permission(permissions, permission))
}

pub(crate) fn staff_two_factor_deadline(assigned_at: DateTime<Utc>) -> DateTime<Utc> {
    assigned_at + chrono::Duration::days(7)
}

pub(crate) fn two_factor_enrollment_overdue(
    role: &str,
    enabled: bool,
    required_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    matches!(role, "owner" | "admin" | "cs")
        && !enabled
        && required_at.is_some_and(|deadline| deadline <= now)
}

pub(crate) fn is_two_factor_enrollment_allowed_route(
    method: &axum::http::Method,
    path: &str,
) -> bool {
    matches!(
        (method, path),
        (&axum::http::Method::GET, "/v2/auth/me")
            | (&axum::http::Method::POST, "/v2/auth/logout")
            | (&axum::http::Method::GET, "/v2/auth/2fa/status")
            | (&axum::http::Method::POST, "/v2/auth/2fa/setup")
            | (&axum::http::Method::POST, "/v2/auth/2fa/confirm")
            // /admin/profile is where an overdue staff member is redirected, and it hosts the
            // 2FA panel. Reading the own-profile header must survive the block or the only
            // page they are allowed to reach cannot render. Writes stay blocked.
            | (&axum::http::Method::GET, "/v2/staff/me/profile")
    )
}

fn has_resolved_permission(permissions: &[String], permission: &str) -> bool {
    permissions.iter().any(|value| value == permission)
        || implied_manage_permission(permission)
            .is_some_and(|manage| permissions.iter().any(|value| value == manage))
}



fn implied_manage_permission(permission: &str) -> Option<&'static str> {
    match permission {
        "viewUsers" => Some("manageUsers"),
        "viewDeposits" => Some("approveDeposits"),
        "viewProducts" => Some("manageProducts"),
        "manageVouchers" => Some("manageProducts"),
        "viewPayment" => Some("managePayment"),
        "viewTeam" => Some("manageTeam"),
        "viewSettings" => Some("manageSettings"),
        "viewVendors" => Some("manageVendors"),
        _ => None,
    }
}

#[cfg(test)]
mod auth_2fa_enrollment_tests {
    use super::*;
    use chrono::TimeZone;

    #[tokio::test]
    async fn credential_unlock_reaches_handler_without_ordinary_bearer_admission() {
        let state = test_app_state_with_proxy_secret("01234567890123456789012345678901");
        let app = axum::Router::new()
            .route("/v2/auth/unlock", axum::routing::post(|| async { axum::http::StatusCode::NO_CONTENT }).get(|| async { axum::http::StatusCode::NO_CONTENT }))
            .route("/v2/auth/unlock/extra", axum::routing::post(|| async { axum::http::StatusCode::NO_CONTENT }))
            .layer(axum::middleware::from_fn_with_state(state, enforce_two_factor_enrollment));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let client = reqwest::Client::new();
        for (method, path, expected) in [
            (reqwest::Method::POST, "/v2/auth/unlock", 204),
            (reqwest::Method::GET, "/v2/auth/unlock", 401),
            (reqwest::Method::POST, "/v2/auth/unlock/extra", 401),
        ] {
            let response = client.request(method, format!("http://{address}{path}"))
                .header("x-api-v2-proxy-secret", "01234567890123456789012345678901")
                .header("x-webtopup-user-id", "00000000-0000-4000-8000-000000000001")
                .send().await.unwrap();
            assert_eq!(response.status().as_u16(), expected, "{path}");
        }
        server.abort();
    }

    #[test]
    fn deposit_permission_approval_implies_view_only() {
        assert!(team_user_has_any_permission(
            "admin",
            &["approveDeposits".to_string()],
            &["viewDeposits"],
        ));
        assert!(!team_user_has_any_permission(
            "admin",
            &["approveDeposits".to_string()],
            &["viewProducts"],
        ));
    }

    #[test]
    fn auth_2fa_enrollment_assigns_exact_seven_day_utc_deadline() {
        let assigned_at = chrono::Utc.timestamp_millis_opt(1_800_000_000_000).single().unwrap();
        assert_eq!(
            staff_two_factor_deadline(assigned_at).timestamp_millis(),
            assigned_at.timestamp_millis() + 7 * 24 * 60 * 60 * 1_000
        );
    }

    #[test]
    fn auth_2fa_enrollment_grace_and_members_are_not_restricted() {
        let now = chrono::Utc.timestamp_millis_opt(1_800_000_000_000).single().unwrap();
        let future = now + chrono::Duration::milliseconds(1);
        assert!(!two_factor_enrollment_overdue(
            "admin",
            false,
            Some(future),
            now
        ));
        assert!(!two_factor_enrollment_overdue(
            "member",
            false,
            Some(now),
            now
        ));
    }

    #[test]
    fn auth_2fa_enrollment_overdue_allowlist_is_exact() {
        for path in [
            "/v2/auth/me",
            "/v2/auth/logout",
            "/v2/auth/2fa/status",
            "/v2/auth/2fa/setup",
            "/v2/auth/2fa/confirm",
        ] {
            let method = if path == "/v2/auth/me" || path.ends_with("/status") {
                axum::http::Method::GET
            } else {
                axum::http::Method::POST
            };
            assert!(
                is_two_factor_enrollment_allowed_route(&method, path),
                "{path}"
            );
        }
        for path in [
            "/v2/auth/activity",
            "/v2/auth/sessions",
            "/v2/auth/2fa/disable",
            "/v2/admin/security",
            "/v2/auth/2fa/setup/extra",
        ] {
            assert!(
                !is_two_factor_enrollment_allowed_route(&axum::http::Method::POST, path),
                "{path}"
            );
        }
    }

    #[test]
    fn overdue_staff_may_read_but_not_write_their_own_profile() {
        // The redirect target must be able to load itself, otherwise enrollment is a dead end.
        assert!(is_two_factor_enrollment_allowed_route(
            &axum::http::Method::GET,
            "/v2/staff/me/profile"
        ));
        // Credential changes stay blocked until enrollment completes.
        for method in [
            axum::http::Method::PUT,
            axum::http::Method::POST,
            axum::http::Method::DELETE,
        ] {
            assert!(
                !is_two_factor_enrollment_allowed_route(&method, "/v2/staff/me/profile"),
                "{method} should stay blocked"
            );
        }
        assert!(!is_two_factor_enrollment_allowed_route(
            &axum::http::Method::PUT,
            "/v2/staff/me/password"
        ));
        assert!(!is_two_factor_enrollment_allowed_route(
            &axum::http::Method::GET,
            "/v2/staff/me/profile/extra"
        ));
    }

    #[test]
    fn auth_2fa_enrollment_allowlist_binds_method_and_exact_path() {
        assert!(!is_two_factor_enrollment_allowed_route(
            &axum::http::Method::DELETE,
            "/v2/auth/me"
        ));
        assert!(!is_two_factor_enrollment_allowed_route(
            &axum::http::Method::GET,
            "/v2/auth/logout"
        ));
        assert!(!is_two_factor_enrollment_allowed_route(
            &axum::http::Method::POST,
            "/v2/auth/2fa/confirm/extra"
        ));
        // Queries do not alter URI::path(), so the exact route remains allowed.
        let uri: axum::http::Uri = "/v2/auth/me?view=compact".parse().unwrap();
        assert!(is_two_factor_enrollment_allowed_route(
            &axum::http::Method::GET,
            uri.path()
        ));
    }

    #[test]
    fn auth_2fa_enrollment_completed_or_enabled_is_not_overdue() {
        let now = chrono::Utc.timestamp_millis_opt(1_800_000_000_000).single().unwrap();
        let past = now - chrono::Duration::milliseconds(1);
        assert!(!two_factor_enrollment_overdue(
            "owner",
            true,
            Some(past),
            now
        ));
        assert!(two_factor_enrollment_overdue("cs", false, Some(past), now));
        assert!(two_factor_enrollment_overdue(
            "admin",
            false,
            Some(now),
            now
        ));
    }
}

fn error_response(
    status: axum::http::StatusCode,
    message: &'static str,
) -> axum::response::Response {
    (status, Json(ErrorResponse { message })).into_response()
}

fn gateway_correlation_header_candidate(headers: &HeaderMap) -> Option<String> {
    headers
        .get(GATEWAY_CORRELATION_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| validate_trace_id(value))
        .map(|value| value.to_ascii_lowercase())
}

fn resolve_trusted_span_or_gateway_correlation(
    headers: &HeaderMap,
    active_span_trace_id: Option<&str>,
) -> CorrelationResolution {
    if let Some(span_id) = active_span_trace_id {
        if validate_trace_id(span_id) {
            return CorrelationResolution {
                trace_id: Some(span_id.to_ascii_lowercase()),
                source: CorrelationSource::OtelSpan,
            };
        }
    }

    if let Some(header_id) = gateway_correlation_header_candidate(headers) {
        return CorrelationResolution {
            trace_id: Some(header_id),
            source: CorrelationSource::GatewayHeader,
        };
    }

    CorrelationResolution {
        trace_id: None,
        source: CorrelationSource::Absent,
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

impl ProxyContext {
    pub fn into_response(self) -> Option<ProxyContextResponse> {
        if self.user_id.is_none() && self.user_role.is_none() && self.user_email.is_none() {
            return None;
        }

        Some(ProxyContextResponse {
            id: self.user_id,
            role: self.user_role,
            email: self.user_email,
        })
    }
}

impl AuthenticatedProxyUser {
    pub fn into_response(self) -> ProxyContextResponse {
        ProxyContextResponse {
            id: Some(self.id.to_string()),
            role: Some(self.role),
            email: Some(self.email),
        }
    }
}

#[cfg(test)]
pub(crate) fn test_authenticated_proxy_user(
    id: Uuid,
    role: &str,
    email: &str,
    permissions: Vec<String>,
) -> AuthenticatedProxyUser {
    AuthenticatedProxyUser {
        id,
        role: role.to_string(),
        email: email.to_string(),
        permissions,
        two_factor_enrollment_required_at: None,
        two_factor_enrollment_completed_at: None,
        two_factor_enabled: false,
    }
}

#[cfg(test)]
mod correlation_resolver_trusted_tests {
    use super::*;

    const VALID_TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
    const OTHER_TRACE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        use axum::http::header::HeaderName;
        for (name, value) in pairs {
            let header_name: HeaderName = name.parse().expect("header name");
            headers.insert(header_name, (*value).parse().expect("header value"));
        }
        headers
    }

    #[test]
    fn r2_uses_gateway_header_when_trusted_and_no_span() {
        let headers = header_map(&[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)]);
        let resolved = resolve_trusted_span_or_gateway_correlation(&headers, None);
        assert_eq!(
            resolved,
            CorrelationResolution {
                trace_id: Some(VALID_TRACE.to_string()),
                source: CorrelationSource::GatewayHeader,
            }
        );
    }

    #[test]
    fn r3_ignores_traceparent_without_gateway_header() {
        let headers = header_map(&[(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )]);
        let resolved = resolve_trusted_span_or_gateway_correlation(&headers, None);
        assert_eq!(
            resolved,
            CorrelationResolution {
                trace_id: None,
                source: CorrelationSource::Absent,
            }
        );
    }

    #[test]
    fn r4_rejects_invalid_gateway_correlation_ids() {
        let cases = [
            ("uppercase", "4BF92F3577B34DA6A3CE929D0E0E4736"),
            ("wrong length", "abcd"),
            ("all zero", "00000000000000000000000000000000"),
        ];
        for (_label, value) in cases {
            let headers = header_map(&[(GATEWAY_CORRELATION_HEADER, value)]);
            let resolved = resolve_trusted_span_or_gateway_correlation(&headers, None);
            assert_eq!(
                resolved.source,
                CorrelationSource::Absent,
                "expected absent for {_label}"
            );
            assert!(resolved.trace_id.is_none());
        }
    }

    #[test]
    fn trusted_marker_prefers_span_over_gateway_header() {
        let headers = header_map(&[(GATEWAY_CORRELATION_HEADER, OTHER_TRACE)]);
        let resolved = resolve_trusted_span_or_gateway_correlation(&headers, Some(VALID_TRACE));
        assert_eq!(resolved.source, CorrelationSource::OtelSpan);
        assert_eq!(resolved.trace_id.as_deref(), Some(VALID_TRACE));
    }
}

#[cfg(test)]
pub(crate) fn test_app_state_with_proxy_secret(secret: &str) -> std::sync::Arc<AppState> {
    std::sync::Arc::new(AppState {
        pg_pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/webtopup_ci_unit")
            .expect("valid unit-test pool URL"),
        proxy_secret: secret.to_string(),
        jwt_secret: "jwt-test-secret-at-least-32-chars-long".to_string(),
        session_token_hash_secret: "session-token-hash-test-secret-at-least-32-chars".to_string(),
        rotation_keys: crate::state::RotationKeyRing::parse(
            "test",
            "test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .expect("valid deterministic test rotation key"),
        recovery_encryption_keys: crate::state::RecoveryEncryptionKeyRing::parse(
            "enc-test",
            "enc-test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .expect("valid deterministic test recovery encryption key"),
        slider_mutation_readiness: crate::services::slider_readiness::SliderMutationReadiness::default(),
    })
}

#[cfg(test)]
mod proxy_correlation_security_tests {
    use super::*;
    use crate::services::correlation::{CorrelationSource, GATEWAY_CORRELATION_HEADER};

    const VALID_SECRET: &str = "01234567890123456789012345678901";
    const VALID_TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";

    fn headers_with_secret(secret: Option<&str>, extra: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(secret) = secret {
            headers.insert(
                "x-api-v2-proxy-secret",
                secret.parse().expect("secret header"),
            );
        }
        use axum::http::header::HeaderName;
        for (name, value) in extra {
            let header_name: HeaderName = name.parse().expect("header name");
            headers.insert(header_name, (*value).parse().expect("header value"));
        }
        headers
    }

    #[tokio::test]
    async fn require_proxy_context_returns_403_when_secret_absent() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(None, &[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)]);
        let err = require_proxy_context(&headers, &state)
            .err()
            .expect("expected 403");
        assert_eq!(err.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn require_proxy_context_returns_403_when_secret_wrong() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(
            Some("wrong-secret-that-does-not-match-at-all"),
            &[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)],
        );
        let err = require_proxy_context(&headers, &state)
            .err()
            .expect("expected 403");
        assert_eq!(err.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn spoofed_gateway_correlation_header_ignored_without_valid_proxy_secret() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(None, &[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)]);
        let resolved = resolve_request_trace_layer_correlation(&headers, &state, None);
        assert_eq!(resolved.source, CorrelationSource::Absent);
        assert!(resolved.trace_id.is_none());
    }

    #[tokio::test]
    async fn spoofed_gateway_correlation_header_ignored_with_wrong_proxy_secret() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(
            Some("not-the-configured-proxy-secret-value"),
            &[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)],
        );
        let resolved = resolve_request_trace_layer_correlation(&headers, &state, None);
        assert_eq!(resolved.source, CorrelationSource::Absent);
        assert!(resolved.trace_id.is_none());
    }

    #[tokio::test]
    async fn valid_proxy_secret_allows_trusted_gateway_correlation_fallback() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(
            Some(VALID_SECRET),
            &[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)],
        );
        let resolved = resolve_request_trace_layer_correlation(&headers, &state, None);
        assert_eq!(resolved.source, CorrelationSource::GatewayHeader);
        assert_eq!(resolved.trace_id.as_deref(), Some(VALID_TRACE));
    }

    #[tokio::test]
    async fn request_correlation_prefers_explicit_span_trace_over_gateway_header() {
        let state = test_app_state_with_proxy_secret(VALID_SECRET);
        let headers = headers_with_secret(
            Some(VALID_SECRET),
            &[(
                GATEWAY_CORRELATION_HEADER,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
        );
        let resolved = resolve_request_trace_layer_correlation(&headers, &state, Some(VALID_TRACE));
        assert_eq!(resolved.source, CorrelationSource::OtelSpan);
        assert_eq!(resolved.trace_id.as_deref(), Some(VALID_TRACE));
    }

}
