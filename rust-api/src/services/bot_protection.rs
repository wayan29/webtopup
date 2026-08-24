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

#[cfg(test)]
mod tests {
    use super::*;

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
}
