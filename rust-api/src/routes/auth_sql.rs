#[path = "auth/access_session.rs"]
pub mod access_session;
pub(crate) use access_session::resolve_optional_member_access;

use axum::{
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

const ACTION_GROUPS: &[&str] = &[
    "finance.adjust_balance",
    "finance.refund",
    "finance.deposit_approval",
    "transactions.manual",
    "integrations.credentials",
    "team.manage_privileged",
    "team.reset_2fa",
    "security.sessions_all",
    "exports.sensitive",
    "security.password",
];

/// Accept only the gateway-stamped group header; the SQL auth verifier also validates its signed
/// grant against the authenticated user/session on handlers that have an actor context.
pub fn require_trusted_step_up_group(
    headers: &HeaderMap,
    expected_group: &str,
) -> Result<(), Response> {
    if ACTION_GROUPS.contains(&expected_group)
        && headers
            .get("x-webtopup-step-up-group")
            .and_then(|value| value.to_str().ok())
            == Some(expected_group)
    {
        return Ok(());
    }
    Err((
        axum::http::StatusCode::FORBIDDEN,
        Json(json!({"error":{"code":"AUTH_STEP_UP_REQUIRED","actionGroup":expected_group,"message":"Verifikasi ulang diperlukan untuk aksi sensitif"}})),
    )
        .into_response())
}
