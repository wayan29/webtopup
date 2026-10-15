use super::types::{MyPreferences, MyProfile};

pub(super) fn my_profile_from_sql(user: &crate::sql_auth::User) -> MyProfile {
    let preferences = &user.preferences;
    MyProfile {
        id: user.id.to_string(),
        name: user.name.clone(),
        email: user.email.clone(),
        phone: user.phone.clone(),
        address: user.address.clone(),
        role: user.role.clone(),
        level: user.level.clone(),
        balance: user.balance as f64,
        points: user.points,
        active: user.active,
        created_at: user
            .created_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        updated_at: user
            .updated_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        preferences: MyPreferences {
            email_notifications: preferences
                .get("emailNotifications")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            sms_notifications: preferences
                .get("smsNotifications")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            show_balance: preferences
                .get("showBalance")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            ui_theme: preferences
                .get("uiTheme")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("ember-premium")
                .to_string(),
        },
    }
}

pub(super) fn preferences_from_sql(value: &serde_json::Value) -> MyPreferences {
    MyPreferences {
        email_notifications: value.get("emailNotifications").and_then(serde_json::Value::as_bool).unwrap_or(true),
        sms_notifications: value.get("smsNotifications").and_then(serde_json::Value::as_bool).unwrap_or(false),
        show_balance: value.get("showBalance").and_then(serde_json::Value::as_bool).unwrap_or(true),
        ui_theme: value.get("uiTheme").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty()).unwrap_or("ember-premium").to_owned(),
    }
}

#[cfg(test)]
mod sql_profile_tests {
    use super::my_profile_from_sql;

    #[test]
    fn sql_profile_preserves_member_contract_and_preference_defaults() {
        use chrono::{TimeZone, Utc};
        use serde_json::json;
        use uuid::Uuid;

        let timestamp = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
        let user = crate::sql_auth::User {
            id: Uuid::from_u128(0x00112233445566778899aabbccddeeff),
            email: "member@example.test".to_string(),
            name: "SQL Member".to_string(),
            role: "member".to_string(),
            password_hash: "unused".to_string(),
            active: true,
            session_version: 0,
            security_generation: 0,
            two_factor_enabled: false,
            two_factor_secret: None,
            last_otp_counter: None,
            permissions: Vec::new(),
            two_factor_enrollment_required_at: None,
            two_factor_enrollment_completed_at: None,
            phone: "62812345678".to_string(),
            address: "Bandung".to_string(),
            avatar_url: String::new(),
            level: "member".to_string(),
            balance: 125_000,
            points: 42,
            preferences: json!({"uiTheme": "forest-trusted"}),
            created_at: timestamp,
            updated_at: timestamp,
        };

        let profile = my_profile_from_sql(&user);
        let value = serde_json::to_value(profile).unwrap();
        assert_eq!(value["id"], "00112233-4455-6677-8899-aabbccddeeff");
        assert_eq!(value["balance"], 125_000.0);
        assert_eq!(value["points"], 42);
        assert_eq!(value["createdAt"], "2023-11-14T22:13:20.000Z");
        assert_eq!(value["updatedAt"], "2023-11-14T22:13:20.000Z");
        assert_eq!(value["preferences"]["emailNotifications"], true);
        assert_eq!(value["preferences"]["smsNotifications"], false);
        assert_eq!(value["preferences"]["showBalance"], true);
        assert_eq!(value["preferences"]["uiTheme"], "forest-trusted");
    }
}
