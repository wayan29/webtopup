use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum LoginAudience {
    Member,
    Staff,
}

impl LoginAudience {
    pub(super) fn accepts_role(self, role: &str) -> bool {
        match self {
            Self::Member => role == "member",
            Self::Staff => matches!(role, "owner" | "admin" | "cs"),
        }
    }
}

#[derive(Deserialize)]
pub struct RegisterPayload {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) password: Option<String>,
    #[serde(rename = "deviceName")]
    pub(super) device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginPayload {
    pub(super) email: Option<String>,
    pub(super) password: Option<String>,
    #[serde(rename = "rememberMe")]
    pub(super) remember_me: Option<bool>,
    #[serde(rename = "deviceName")]
    pub(super) device_name: Option<String>,
    #[serde(rename = "turnstileToken")]
    pub(super) turnstile_token: Option<String>,
}

#[derive(Deserialize)]
pub struct DeviceSelectionPayload {
    #[serde(rename = "challengeToken")]
    pub challenge_token: String,
    #[serde(rename = "revokeSessionId")]
    pub revoke_session_id: String,
}

#[derive(Deserialize)]
pub struct TwoFactorLoginPayload {
    #[serde(rename = "challengeToken")]
    pub(super) challenge_token: Option<String>,
    pub(super) code: Option<String>,
}

#[derive(Deserialize)]
pub struct TwoFactorCodePayload {
    pub(super) code: Option<String>,
    pub(super) password: Option<String>,
    /// Forwarded HttpOnly recovery cookie / proof for recoverable security-change retries.
    #[serde(rename = "recoveryToken")]
    pub(super) recovery_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Claims {
    pub(super) id: String,
    pub(super) email: Option<String>,
    pub(super) role: Option<String>,
    pub(super) level: Option<String>,
    #[serde(rename = "sessionVersion")]
    pub(super) session_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) purpose: Option<String>,
    #[serde(
        rename = "loginAudience",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) login_audience: Option<LoginAudience>,
    pub(super) exp: usize,
    pub(super) iat: usize,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct DeviceSelectionClaims {
    pub(super) sub: String,
    pub(super) nonce: String,
    pub(super) purpose: String,
    pub(super) exp: i64,
    pub(super) iat: i64,
    #[serde(rename = "loginAudience")]
    pub(super) login_audience: LoginAudience,
    #[serde(rename = "rememberMe")]
    pub(super) remember_me: bool,
    #[serde(rename = "deviceName")]
    pub(super) device_name: String,
    #[serde(rename = "sessionVersion")]
    pub(super) session_version: i64,
    #[serde(rename = "role")]
    pub(super) role: String,
    #[serde(rename = "twoFactorEnabled")]
    pub(super) two_factor_enabled: bool,
    #[serde(rename = "twoFactorVerified")]
    pub(super) two_factor_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct AccessClaims {
    pub(super) sub: String,
    pub(super) sid: String,
    #[serde(rename = "sessionVersion")]
    pub(super) session_version: i64,
    pub(super) role: String,
    pub(super) iat: i64,
    pub(super) exp: i64,
    pub(super) jti: String,
    #[serde(rename = "tokenType")]
    pub(super) token_type: String,
}

/// Five-minute step-up grant claims. No role/sessionVersion authority — only
/// identity, session binding, action group, purpose, and temporal bounds.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct StepUpClaims {
    pub(super) sub: String,
    pub(super) sid: String,
    pub(super) action_group: String,
    pub(super) purpose: String,
    pub(super) iat: i64,
    pub(super) exp: i64,
    pub(super) jti: String,
}

pub(super) struct RuntimeSettings {
    pub(super) maintenance_mode: bool,
    pub(super) maintenance_message: String,
    pub(super) registration_enabled: bool,
}

#[cfg(test)]
mod tests {
    #[test]
    fn login_audience_accepts_only_the_exact_role_matrix() {
        use super::LoginAudience::{Member, Staff};

        assert!(Member.accepts_role("member"));
        for role in ["owner", "admin", "cs", "staff", "", "unknown"] {
            assert!(!Member.accepts_role(role), "member accepted {role}");
        }

        for role in ["owner", "admin", "cs"] {
            assert!(Staff.accepts_role(role), "staff rejected {role}");
        }
        for role in ["member", "staff", "", "unknown"] {
            assert!(!Staff.accepts_role(role), "staff accepted {role}");
        }
    }
}
