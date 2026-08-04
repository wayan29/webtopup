use std::collections::HashMap;

use mongodb::bson::{Bson, Document};

use crate::utils::bson::{read_i64, read_string};

use super::types::{
    AdjustmentActor, BalanceAdjustmentItem, BalanceHistoryItem, LoginActivityItem, MyPreferences,
    MyProfile, UserItem,
};

pub(super) fn balance_deposit_item(document: Document) -> Option<BalanceHistoryItem> {
    let id = object_id_hex(&document);
    let admin_fee = read_f64(&document, "adminFee").max(0.0);
    let net_amount = (read_f64(&document, "amount") - admin_fee).max(0.0);
    if net_amount <= 0.0 {
        return None;
    }
    Some(BalanceHistoryItem {
        id: id.clone(),
        source: "deposit".to_string(),
        item_type: "credit".to_string(),
        amount: net_amount,
        description: if admin_fee > 0.0 {
            format!(
                "Deposit saldo disetujui (fee Rp {})",
                format_id_amount(admin_fee)
            )
        } else {
            "Deposit saldo disetujui".to_string()
        },
        reference: format!("DEP-{}", id_suffix(&id)),
        created_at: date_string(&document, "createdAt"),
        balance_before: None,
        balance_after: None,
        meta: None,
    })
}

pub(super) fn balance_transaction_item(
    document: Document,
    products: &HashMap<String, (String, String)>,
) -> BalanceHistoryItem {
    let id = object_id_hex(&document);
    let product = document
        .get_object_id("product")
        .ok()
        .and_then(|id| products.get(&id.to_hex()));
    BalanceHistoryItem {
        id: id.clone(),
        source: "purchase".to_string(),
        item_type: "debit".to_string(),
        amount: read_f64(&document, "amount"),
        description: product
            .map(|(name, _)| name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Pembelian produk".to_string()),
        reference: format!("TRX-{}", id_suffix(&id)),
        created_at: date_string(&document, "createdAt"),
        balance_before: None,
        balance_after: None,
        meta: Some(serde_json::json!({
            "productCode": product.map(|(_, code)| code.as_str()).filter(|code| !code.is_empty())
        })),
    }
}

pub(super) fn balance_voucher_item(document: Document) -> BalanceHistoryItem {
    let id = object_id_hex(&document);
    let code = read_string(&document, "code");
    let redeemed_at = date_string(&document, "redeemedAt");
    BalanceHistoryItem {
        id,
        source: "voucher".to_string(),
        item_type: "credit".to_string(),
        amount: read_f64(&document, "amount"),
        description: format!("Redeem voucher {}", code),
        reference: code,
        created_at: if redeemed_at.is_empty() {
            date_string(&document, "createdAt")
        } else {
            redeemed_at
        },
        balance_before: read_optional_f64(&document, "redeemedBalanceBefore"),
        balance_after: read_optional_f64(&document, "redeemedBalanceAfter"),
        meta: None,
    }
}

pub(super) fn balance_adjustment_history_item(
    document: Document,
    actors: &HashMap<String, AdjustmentActor>,
) -> BalanceHistoryItem {
    let id = object_id_hex(&document);
    let actor_name = document
        .get_object_id("adjustedBy")
        .ok()
        .and_then(|id| actors.get(&id.to_hex()))
        .map(|actor| {
            if actor.name.is_empty() {
                actor.email.clone()
            } else {
                actor.name.clone()
            }
        })
        .filter(|value| !value.is_empty());
    BalanceHistoryItem {
        id: id.clone(),
        source: "adjustment".to_string(),
        item_type: if read_string(&document, "type") == "add" {
            "credit".to_string()
        } else {
            "debit".to_string()
        },
        amount: read_f64(&document, "amount"),
        description: Some(read_string(&document, "reason"))
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| "Penyesuaian saldo admin".to_string()),
        reference: format!("ADJ-{}", id_suffix(&id)),
        created_at: date_string(&document, "createdAt"),
        balance_before: read_optional_f64(&document, "balanceBefore"),
        balance_after: read_optional_f64(&document, "balanceAfter"),
        meta: Some(serde_json::json!({ "adjustedBy": actor_name })),
    }
}

pub(super) fn my_profile_from_doc(document: &Document) -> MyProfile {
    MyProfile {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(document, "name"),
        email: read_string(document, "email"),
        phone: read_string(document, "phone"),
        address: read_string(document, "address"),
        role: read_string(document, "role"),
        level: read_string(document, "level"),
        balance: read_f64(document, "balance"),
        points: read_i64(document, "points"),
        active: document.get_bool("active").unwrap_or(true),
        created_at: date_string(document, "createdAt"),
        updated_at: date_string(document, "updatedAt"),
        preferences: preferences_from_doc(document.get_document("preferences").ok()),
    }
}

pub(super) fn preferences_from_doc(document: Option<&Document>) -> MyPreferences {
    MyPreferences {
        email_notifications: document
            .and_then(|doc| doc.get_bool("emailNotifications").ok())
            .unwrap_or(true),
        sms_notifications: document
            .and_then(|doc| doc.get_bool("smsNotifications").ok())
            .unwrap_or(false),
        show_balance: document
            .and_then(|doc| doc.get_bool("showBalance").ok())
            .unwrap_or(true),
        ui_theme: document
            .map(|doc| read_string(doc, "uiTheme"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "ember-premium".to_string()),
    }
}

pub(super) fn preferences_doc_from_doc(document: Option<&Document>) -> Document {
    let preferences = preferences_from_doc(document);
    mongodb::bson::doc! {
        "emailNotifications": preferences.email_notifications,
        "smsNotifications": preferences.sms_notifications,
        "showBalance": preferences.show_balance,
        "uiTheme": preferences.ui_theme,
    }
}

pub(super) fn login_activity_from_doc(document: Document) -> LoginActivityItem {
    LoginActivityItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        ip: read_string(&document, "ip"),
        user_agent: read_string(&document, "userAgent"),
        created_at: date_string(&document, "createdAt"),
    }
}

pub(super) fn user_item_from_doc(document: Document) -> UserItem {
    let member_code = read_string(&document, "memberCode");
    let api_key = read_string(&document, "apiKey");
    UserItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        name: read_string(&document, "name"),
        email: read_string(&document, "email"),
        level: read_string(&document, "level"),
        balance: read_f64(&document, "balance"),
        points: read_i64(&document, "points"),
        active: document.get_bool("active").unwrap_or(true),
        member_code: if member_code.is_empty() {
            None
        } else {
            Some(member_code)
        },
        // Presence-only; never expose apiKey/apiSecret values to admin clients.
        has_open_api_key: !api_key.is_empty(),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn balance_adjustment_from_doc(
    document: Document,
    actors: &HashMap<String, AdjustmentActor>,
) -> BalanceAdjustmentItem {
    let actor_id = document
        .get_object_id("adjustedBy")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    BalanceAdjustmentItem {
        id: document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default(),
        user: document.get_object_id("user").ok().map(|id| id.to_hex()),
        adjusted_by: actors.get(&actor_id).cloned(),
        adjustment_type: read_string(&document, "type"),
        amount: read_f64(&document, "amount"),
        balance_before: read_f64(&document, "balanceBefore"),
        balance_after: read_f64(&document, "balanceAfter"),
        reason: read_string(&document, "reason"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

pub(super) fn read_f64(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        _ => 0.0,
    }
}

fn read_optional_f64(document: &Document, key: &str) -> Option<f64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(f64::from(*value)),
        Some(Bson::Int64(value)) => Some(*value as f64),
        Some(Bson::Double(value)) => Some(*value),
        _ => None,
    }
}

fn object_id_hex(document: &Document) -> String {
    document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default()
}

fn id_suffix(id: &str) -> String {
    id.chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_uppercase()
}

fn format_id_amount(value: f64) -> String {
    let mut digits = format!("{:.0}", value.trunc().abs());
    let mut parts = Vec::new();
    while digits.len() > 3 {
        let rest = digits.split_off(digits.len() - 3);
        parts.push(rest);
    }
    parts.push(digits);
    parts.reverse();
    let formatted = parts.join(".");
    if value < 0.0 {
        format!("-{}", formatted)
    } else {
        formatted
    }
}

pub(super) fn date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .unwrap_or_default()
}


#[cfg(test)]
mod open_api_admin_item_tests {
    use mongodb::bson::{doc, oid::ObjectId};

    use super::user_item_from_doc;

    #[test]
    fn maps_open_api_presence_and_member_code_without_secrets() {
        let id = ObjectId::new();
        let item = user_item_from_doc(doc! {
            "_id": id,
            "name": "Member A",
            "email": "a@example.com",
            "level": "basic",
            "balance": 10.0,
            "points": 1_i64,
            "active": true,
            "memberCode": "MBR123",
            "apiKey": "tv_live_key",
            "apiSecret": "should-never-surface",
        });
        assert_eq!(item.id, id.to_hex());
        assert_eq!(item.member_code.as_deref(), Some("MBR123"));
        assert!(item.has_open_api_key);
        let json = serde_json::to_value(&item).expect("serialize");
        assert_eq!(json.get("hasOpenApiKey"), Some(&serde_json::json!(true)));
        assert_eq!(json.get("memberCode"), Some(&serde_json::json!("MBR123")));
        assert!(json.get("apiKey").is_none());
        assert!(json.get("apiSecret").is_none());
        assert!(json.get("api_secret").is_none());
    }

    #[test]
    fn empty_api_key_is_not_active_open_api() {
        let item = user_item_from_doc(doc! {
            "_id": ObjectId::new(),
            "name": "Member B",
            "email": "b@example.com",
            "level": "gold",
            "balance": 0.0,
            "points": 0_i64,
            "active": true,
            "memberCode": "MBR456",
            "apiKey": "",
        });
        assert_eq!(item.member_code.as_deref(), Some("MBR456"));
        assert!(!item.has_open_api_key);
    }

    #[test]
    fn missing_open_api_fields_default_inactive() {
        let item = user_item_from_doc(doc! {
            "_id": ObjectId::new(),
            "name": "Member C",
            "email": "c@example.com",
            "level": "platinum",
            "balance": 1.0,
            "points": 2_i64,
            "active": false,
        });
        assert_eq!(item.member_code, None);
        assert!(!item.has_open_api_key);
        let json = serde_json::to_value(&item).expect("serialize");
        // memberCode skipped when absent
        assert!(json.get("memberCode").is_none());
        assert_eq!(json.get("hasOpenApiKey"), Some(&serde_json::json!(false)));
    }
}
