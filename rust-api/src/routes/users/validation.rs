use std::collections::HashMap;

use axum::{response::IntoResponse, Json};

pub(super) const MAX_ADMIN_USERS_PAGE: i64 = 10_000;
pub(super) const MAX_BALANCE_ADJUSTMENT_AMOUNT: f64 = 100_000_000.0;
use mongodb::bson::{doc, Document};
use serde_json::Value;

use crate::{security::ErrorResponse, utils::bson::escape_regex};

pub(super) const COMMON_PASSWORDS: [&str; 7] = [
    "password",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty123",
    "admin123",
];

pub(super) fn build_filter(query: &HashMap<String, String>) -> Document {
    let mut filter = doc! { "role": "member" };

    if let Some(search) = query
        .get("search")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let pattern = escape_regex(search);
        filter.insert(
            "$or",
            vec![
                doc! { "name": { "$regex": &pattern, "$options": "i" } },
                doc! { "email": { "$regex": &pattern, "$options": "i" } },
            ],
        );
    }

    if let Some(level) = query.get("level").map(String::as_str) {
        if matches!(level, "basic" | "gold" | "platinum") {
            filter.insert("level", level);
        }
    }

    match query.get("status").map(String::as_str) {
        Some("active") => {
            filter.insert("active", true);
        }
        Some("inactive") => {
            filter.insert("active", false);
        }
        _ => {}
    }

    filter
}

pub(super) fn build_sort(query: &HashMap<String, String>) -> Document {
    let sort_by = match query.get("sortBy").map(String::as_str) {
        Some("updatedAt" | "name" | "email" | "balance") => query.get("sortBy").unwrap().as_str(),
        _ => "createdAt",
    };
    let sort_order = if query.get("sortOrder").map(String::as_str) == Some("asc") {
        1
    } else {
        -1
    };
    doc! { sort_by: sort_order }
}

pub(super) fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(super) fn normalize_phone(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

pub(super) fn is_valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

pub(super) fn is_valid_phone(value: &str) -> bool {
    (8..=20).contains(&value.len())
}

pub(super) fn is_valid_ui_theme(value: &str) -> bool {
    matches!(
        value,
        "ember-premium"
            | "ember-premium-light"
            | "forest-trusted"
            | "forest-trusted-light"
            | "royal-plum-luxury"
            | "royal-plum-luxury-light"
            | "graphite-operational"
            | "graphite-operational-light"
            | "horizon-clean"
            | "midnight-elegant"
            | "neobrutal-bold"
    )
}

pub(super) fn parse_positive_i64(value: Option<&String>, fallback: i64, max: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| std::cmp::min(value, max))
        .unwrap_or(fallback)
}

pub(super) fn normalize_adjustment_amount(
    value: Option<Value>,
) -> Result<f64, axum::response::Response> {
    let amount = match value {
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0),
        Some(Value::String(value)) => value.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    if !amount.is_finite() || amount <= 0.0 {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Nominal penyesuaian harus lebih besar dari 0",
            }),
        )
            .into_response());
    }
    if amount.fract() != 0.0 {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Nominal penyesuaian harus berupa angka Rupiah bulat",
            }),
        )
            .into_response());
    }
    if amount > MAX_BALANCE_ADJUSTMENT_AMOUNT {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Nominal penyesuaian melebihi batas maksimal Rp100.000.000",
            }),
        )
            .into_response());
    }
    Ok(amount)
}

/// Reason a staff self-service credential change is rejected. Ordered from cheapest check
/// upward so callers can surface the first problem without touching the database.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum StaffCredentialError {
    NameRequired,
    EmailRequired,
    EmailInvalid,
    PasswordFieldsRequired,
    PasswordTooShort,
    PasswordTooCommon,
    PasswordMismatch,
    PasswordUnchanged,
}

/// Validates a staff profile edit. Role is never accepted from the caller: privilege changes
/// belong to team management, not to self-service.
pub(super) fn validate_staff_profile(
    name: &str,
    email: &str,
) -> Result<(String, String), StaffCredentialError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StaffCredentialError::NameRequired);
    }
    let email = normalize_email(email);
    if email.is_empty() {
        return Err(StaffCredentialError::EmailRequired);
    }
    if !is_valid_email(&email) {
        return Err(StaffCredentialError::EmailInvalid);
    }
    Ok((name.to_string(), email))
}

/// Validates a staff password change. Mirrors the member rules so both paths enforce the same
/// floor, and rejects reuse of the current password.
pub(super) fn validate_staff_password(
    current: &str,
    next: &str,
    confirm: &str,
) -> Result<(), StaffCredentialError> {
    if current.is_empty() || next.is_empty() || confirm.is_empty() {
        return Err(StaffCredentialError::PasswordFieldsRequired);
    }
    if next.len() < 12 {
        return Err(StaffCredentialError::PasswordTooShort);
    }
    if COMMON_PASSWORDS.contains(&next.to_lowercase().as_str()) {
        return Err(StaffCredentialError::PasswordTooCommon);
    }
    if next != confirm {
        return Err(StaffCredentialError::PasswordMismatch);
    }
    if next == current {
        return Err(StaffCredentialError::PasswordUnchanged);
    }
    Ok(())
}

#[cfg(test)]
mod staff_credential_tests {
    use super::*;

    #[test]
    fn profile_trims_name_and_normalizes_email() {
        assert_eq!(
            validate_staff_profile("  Owner Satu  ", "  Owner@Example.COM "),
            Ok(("Owner Satu".to_string(), "owner@example.com".to_string()))
        );
    }

    #[test]
    fn profile_requires_a_name_and_a_wellformed_email() {
        assert_eq!(validate_staff_profile("   ", "a@b.co"), Err(StaffCredentialError::NameRequired));
        assert_eq!(validate_staff_profile("Owner", "  "), Err(StaffCredentialError::EmailRequired));
        for bad in ["no-at-sign", "@example.com", "owner@nodot", "owner@.com", "owner@com."] {
            assert_eq!(
                validate_staff_profile("Owner", bad),
                Err(StaffCredentialError::EmailInvalid),
                "should reject {bad}"
            );
        }
    }

    #[test]
    fn password_enforces_the_same_floor_as_the_member_path() {
        assert_eq!(
            validate_staff_password("", "", ""),
            Err(StaffCredentialError::PasswordFieldsRequired)
        );
        assert_eq!(
            validate_staff_password("old-secret-1", "short", "short"),
            Err(StaffCredentialError::PasswordTooShort)
        );
        assert_eq!(
            validate_staff_password("old-secret-1", "new-secret-12", "different-12"),
            Err(StaffCredentialError::PasswordMismatch)
        );
        assert_eq!(
            validate_staff_password("same-secret-1", "same-secret-1", "same-secret-1"),
            Err(StaffCredentialError::PasswordUnchanged)
        );
        assert_eq!(validate_staff_password("old-secret-1", "new-secret-12", "new-secret-12"), Ok(()));
    }

    #[test]
    fn the_shared_common_list_is_unreachable_behind_the_twelve_char_floor() {
        // Every COMMON_PASSWORDS entry is 8-11 characters, and the length floor is checked
        // first, so the list can never match. Asserted so the day someone adds a >=12
        // character entry, or lowers the floor, this documents which rule wins.
        for common in COMMON_PASSWORDS {
            assert!(common.len() < 12, "{common} would change this precedence");
            assert_eq!(
                validate_staff_password("old-secret-1", common, common),
                Err(StaffCredentialError::PasswordTooShort)
            );
        }
    }

    #[test]
    fn a_long_password_containing_a_common_word_is_still_accepted() {
        // The list matches whole strings only; it is not a substring blocklist.
        let padded = "password123-extra";
        assert!(padded.len() >= 12);
        assert_eq!(validate_staff_password("old-secret-1", padded, padded), Ok(()));
    }

    #[test]
    fn a_twelve_character_password_is_accepted_at_the_boundary() {
        let twelve = "abcdefghijkl";
        assert_eq!(twelve.len(), 12);
        assert_eq!(validate_staff_password("old-secret-1", twelve, twelve), Ok(()));
    }
}
