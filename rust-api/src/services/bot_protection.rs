use axum::{response::IntoResponse, Json};
use serde_json::json;

pub const BOT_PROTECTION_FAILED_MESSAGE: &str =
    "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.";
pub const BOT_PROTECTION_UNAVAILABLE_MESSAGE: &str =
    "Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.";

pub fn kill_switch_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

pub fn secret_is_configured(secret: &str) -> bool {
    secret.trim().len() >= 32
}

pub fn effective_bot_protection(stored_enabled: bool, kill_switch: bool) -> bool {
    stored_enabled && !kill_switch
}

#[derive(Debug)]
pub enum BotProtectionReject {
    Required,
    Unavailable,
}

#[derive(Debug)]
pub enum TurnstileAction {
    Skip,
    Verify(String),
}

pub fn evaluate_turnstile(
    stored_enabled: bool,
    site_key: &str,
    secret: &str,
    kill_switch: bool,
    token: Option<&str>,
) -> Result<TurnstileAction, BotProtectionReject> {
    if !effective_bot_protection(stored_enabled, kill_switch) {
        return Ok(TurnstileAction::Skip);
    }
    if site_key.trim().is_empty() || !secret_is_configured(secret) {
        return Err(BotProtectionReject::Unavailable);
    }
    let normalized = token.unwrap_or_default().trim();
    if normalized.is_empty() || normalized.len() > 2048 {
        return Err(BotProtectionReject::Required);
    }
    Ok(TurnstileAction::Verify(normalized.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnstileVerifyError {
    Failed,
    Unavailable,
}

pub trait TurnstileVerifier: Send + Sync {
    fn verify(
        &self,
        secret: &str,
        token: &str,
        remote_ip: Option<&str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TurnstileVerifyError>> + Send + '_>
    >;
}

pub struct CloudflareTurnstileVerifier {
    client: reqwest::Client,
}

impl CloudflareTurnstileVerifier {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("turnstile client"),
        }
    }
}

impl TurnstileVerifier for CloudflareTurnstileVerifier {
    fn verify(
        &self,
        secret: &str,
        token: &str,
        remote_ip: Option<&str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TurnstileVerifyError>> + Send + '_>
    > {
        let secret = secret.to_string();
        let token = token.to_string();
        let remote_ip = remote_ip.map(str::to_string);
        Box::pin(async move {
            let mut form = vec![("secret", secret), ("response", token)];
            if let Some(remote_ip) = remote_ip {
                form.push(("remoteip", remote_ip));
            }
            let response = self
                .client
                .post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
                .form(&form)
                .send()
                .await
                .map_err(|_| TurnstileVerifyError::Unavailable)?;
            if !response.status().is_success() {
                return Err(TurnstileVerifyError::Unavailable);
            }
            let body: serde_json::Value = response
                .json()
                .await
                .map_err(|_| TurnstileVerifyError::Unavailable)?;
            match body.get("success").and_then(serde_json::Value::as_bool) {
                Some(true) => Ok(()),
                Some(false) => Err(TurnstileVerifyError::Failed),
                None => Err(TurnstileVerifyError::Unavailable),
            }
        })
    }
}

fn status_message(status: axum::http::StatusCode, message: &'static str) -> axum::response::Response {
    (status, Json(json!({ "message": message }))).into_response()
}

pub fn reject_response(reject: BotProtectionReject) -> axum::response::Response {
    match reject {
        BotProtectionReject::Required => {
            status_message(axum::http::StatusCode::BAD_REQUEST, BOT_PROTECTION_FAILED_MESSAGE)
        }
        BotProtectionReject::Unavailable => status_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            BOT_PROTECTION_UNAVAILABLE_MESSAGE,
        ),
    }
}

pub fn verify_error_response(error: TurnstileVerifyError) -> axum::response::Response {
    match error {
        TurnstileVerifyError::Failed => {
            status_message(axum::http::StatusCode::FORBIDDEN, BOT_PROTECTION_FAILED_MESSAGE)
        }
        TurnstileVerifyError::Unavailable => status_message(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            BOT_PROTECTION_UNAVAILABLE_MESSAGE,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn kill_switch_truthy_values() {
        assert!(kill_switch_enabled(Some("1")));
        assert!(kill_switch_enabled(Some("true")));
        assert!(kill_switch_enabled(Some(" YES ")));
        assert!(!kill_switch_enabled(None));
        assert!(!kill_switch_enabled(Some("0")));
        assert!(!kill_switch_enabled(Some("false")));
    }

    #[test]
    fn secret_requires_32_trimmed_characters() {
        assert!(!secret_is_configured(""));
        assert!(!secret_is_configured("short"));
        assert!(secret_is_configured(&"a".repeat(32)));
        assert!(secret_is_configured(&format!("  {}  ", "b".repeat(32))));
    }

    #[test]
    fn disabled_or_kill_switch_skips_token() {
        let secret = "s".repeat(32);
        assert!(matches!(
            evaluate_turnstile(false, "site", &secret, false, None),
            Ok(TurnstileAction::Skip)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &secret, true, None),
            Ok(TurnstileAction::Skip)
        ));
    }

    #[test]
    fn effective_missing_config_is_unavailable_even_without_token() {
        assert!(matches!(
            evaluate_turnstile(true, "", &"s".repeat(32), false, None),
            Err(BotProtectionReject::Unavailable)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", "", false, Some("tok")),
            Err(BotProtectionReject::Unavailable)
        ));
    }

    #[test]
    fn effective_missing_token_is_required() {
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, None),
            Err(BotProtectionReject::Required)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, Some("  ")),
            Err(BotProtectionReject::Required)
        ));
        assert!(matches!(
            evaluate_turnstile(true, "site", &"s".repeat(32), false, Some(&"x".repeat(2049))),
            Err(BotProtectionReject::Required)
        ));
    }

    #[test]
    fn effective_valid_token_is_verify() {
        match evaluate_turnstile(true, "site", &"s".repeat(32), false, Some(" token ")) {
            Ok(TurnstileAction::Verify(token)) => assert_eq!(token, "token"),
            other => panic!("{other:?}"),
        }
    }

    struct FakeVerifier {
        result: Result<(), TurnstileVerifyError>,
        called: Mutex<u32>,
    }

    impl TurnstileVerifier for FakeVerifier {
        fn verify(
            &self,
            secret: &str,
            token: &str,
            _remote_ip: Option<&str>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), TurnstileVerifyError>> + Send + '_>
        > {
            assert!(secret_is_configured(secret));
            assert!(!token.is_empty());
            *self.called.lock().unwrap() += 1;
            let result = self.result;
            Box::pin(async move { result })
        }
    }

    #[tokio::test]
    async fn fake_success_and_failure_map_without_network() {
        let ok = FakeVerifier {
            result: Ok(()),
            called: Mutex::new(0),
        };
        assert!(ok.verify(&"s".repeat(32), "tok", None).await.is_ok());
        let failed = FakeVerifier {
            result: Err(TurnstileVerifyError::Failed),
            called: Mutex::new(0),
        };
        assert!(matches!(
            failed.verify(&"s".repeat(32), "tok", None).await,
            Err(TurnstileVerifyError::Failed)
        ));
    }

    async fn status_and_message(
        response: axum::response::Response,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let raw = String::from_utf8_lossy(&body).to_ascii_lowercase();
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("token"));
        assert!(!raw.contains("cloudflare"));
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        (status, value)
    }

    #[tokio::test]
    async fn reject_messages_are_generic() {
        // inspect status + JSON message; do not include secret/token/cloudflare
        let (status, body) = status_and_message(reject_response(BotProtectionReject::Required)).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], BOT_PROTECTION_FAILED_MESSAGE);

        let (status, body) =
            status_and_message(verify_error_response(TurnstileVerifyError::Failed)).await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(body["message"], BOT_PROTECTION_FAILED_MESSAGE);

        let (status, body) =
            status_and_message(reject_response(BotProtectionReject::Unavailable)).await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["message"], BOT_PROTECTION_UNAVAILABLE_MESSAGE);

        let (status, body) =
            status_and_message(verify_error_response(TurnstileVerifyError::Unavailable)).await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["message"], BOT_PROTECTION_UNAVAILABLE_MESSAGE);
    }
}
