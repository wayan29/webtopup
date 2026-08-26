use serde_json::{json, Map, Value};

pub fn default_site_settings() -> Map<String, Value> {
    Map::from_iter([
        ("brand".to_string(), json!("Danayasa")),
        (
            "title".to_string(),
            json!("Danayasa - Top Up Game Termurah"),
        ),
        (
            "favicon".to_string(),
            json!("/danayasa-favicon.svg"),
        ),
        ("logo".to_string(), json!("/danayasa-logo.svg")),
        (
            "description".to_string(),
            json!("Topup Game Terlengkap & Termurah"),
        ),
        ("whatsapp".to_string(), json!("")),
        ("telegram".to_string(), json!("")),
        ("email".to_string(), json!("")),
        ("instagram".to_string(), json!("")),
        ("facebook".to_string(), json!("")),
        ("twitter".to_string(), json!("")),
        ("youtube".to_string(), json!("")),
        ("address".to_string(), json!("")),
        ("maintenanceMode".to_string(), json!(false)),
        (
            "maintenanceMessage".to_string(),
            json!("Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi."),
        ),
        ("registrationEnabled".to_string(), json!(true)),
        ("guestCheckoutEnabled".to_string(), json!(true)),
        ("botProtectionEnabled".to_string(), json!(false)),
        ("turnstileSiteKey".to_string(), json!("")),
        ("minDeposit".to_string(), json!(10000)),
        ("maxDeposit".to_string(), json!(10000000)),
        ("depositFee".to_string(), json!(0)),
        ("depositFeeType".to_string(), json!("fixed")),
        (
            "footerText".to_string(),
            json!("© 2026 Danayasa. All Rights Reserved."),
        ),
        ("termsUrl".to_string(), json!("")),
        ("privacyUrl".to_string(), json!("")),
        ("googleAnalyticsId".to_string(), json!("")),
        ("facebookPixelId".to_string(), json!("")),
        ("popupBannerEnabled".to_string(), json!(false)),
        ("popupBannerImage".to_string(), json!("")),
        ("popupBannerLink".to_string(), json!("")),
        ("popupBannerTitle".to_string(), json!("")),
        ("popupBannerDescription".to_string(), json!("")),
        ("refIdPrefix".to_string(), json!("REF")),
        ("refIdDateFormat".to_string(), json!("DDMMYYYY")),
        ("refIdSeparator".to_string(), json!("")),
        ("refIdSequenceDigits".to_string(), json!(4)),
        ("invoicePrefix".to_string(), json!("INV")),
        ("invoiceDateFormat".to_string(), json!("YYYYMMDD")),
        ("invoiceSeparator".to_string(), json!("")),
        ("invoiceRandomLength".to_string(), json!(8)),
        ("invoiceRandomType".to_string(), json!("alphanumeric")),
    ])
}

pub fn public_site_setting_keys() -> &'static [&'static str] {
    &[
        "brand",
        "title",
        "favicon",
        "logo",
        "description",
        "whatsapp",
        "telegram",
        "email",
        "instagram",
        "facebook",
        "twitter",
        "youtube",
        "maintenanceMode",
        "maintenanceMessage",
        "registrationEnabled",
        "guestCheckoutEnabled",
        "botProtectionEnabled",
        "turnstileSiteKey",
        "footerText",
        "termsUrl",
        "privacyUrl",
        "popupBannerEnabled",
        "popupBannerImage",
        "popupBannerLink",
        "popupBannerTitle",
        "popupBannerDescription",
    ]
}

pub fn default_text(key: &str) -> &str {
    match key {
        "brand" => "Danayasa",
        "title" => "Danayasa - Top Up Game Termurah",
        "favicon" => "/danayasa-favicon.svg",
        "logo" => "/danayasa-logo.svg",
        "description" => "Topup Game Terlengkap & Termurah",
        "maintenanceMessage" => {
            "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi."
        }
        "depositFeeType" => "fixed",
        "footerText" => "© 2026 Danayasa. All Rights Reserved.",
        "refIdPrefix" => "REF",
        "refIdDateFormat" => "DDMMYYYY",
        "invoicePrefix" => "INV",
        "invoiceDateFormat" => "YYYYMMDD",
        "invoiceRandomType" => "alphanumeric",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::{default_site_settings, default_text, public_site_setting_keys};
    use serde_json::json;

    #[test]
    fn bot_protection_defaults_are_off_and_public() {
        let defaults = default_site_settings();
        assert_eq!(defaults.get("botProtectionEnabled"), Some(&json!(false)));
        assert_eq!(defaults.get("turnstileSiteKey"), Some(&json!("")));
        assert!(public_site_setting_keys().contains(&"botProtectionEnabled"));
        assert!(public_site_setting_keys().contains(&"turnstileSiteKey"));
    }

    #[test]
    fn bundled_brand_assets_are_the_settings_defaults() {
        let defaults = default_site_settings();

        assert_eq!(
            defaults.get("favicon").and_then(|value| value.as_str()),
            Some("/danayasa-favicon.svg")
        );
        assert_eq!(
            defaults.get("logo").and_then(|value| value.as_str()),
            Some("/danayasa-logo.svg")
        );
        assert_eq!(default_text("favicon"), "/danayasa-favicon.svg");
        assert_eq!(default_text("logo"), "/danayasa-logo.svg");
    }
}
