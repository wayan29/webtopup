use std::collections::HashMap;

use mongodb::bson::Document;
use serde_json::{Map, Value};

use crate::utils::bson::{read_i64, read_string};

use super::{
    types::{
        DepositStats, GuestStats, MethodStats, PaymentCategoryBrief, PaymentCategoryItem,
        PaymentMethodDependency, PaymentMethodItem,
    },
    utils::{
        date_string, is_operational_now, number_value, read_f64, read_f64_default,
        read_i64_optional, read_string_default, visibility_issues,
    },
};

pub(super) fn payment_category_item_from_doc(
    document: Document,
    stats: &HashMap<String, MethodStats>,
) -> PaymentCategoryItem {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let stats = stats.get(&id);
    let method_count = stats.map(|item| item.method_count).unwrap_or(0);
    PaymentCategoryItem {
        id,
        name: read_string(&document, "name"),
        slug: read_string(&document, "slug"),
        icon: read_string(&document, "icon"),
        order: read_i64(&document, "order"),
        status: read_string(&document, "status"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        method_count,
        active_method_count: stats.map(|item| item.active_method_count).unwrap_or(0),
        inactive_method_count: stats.map(|item| item.inactive_method_count).unwrap_or(0),
        can_delete: method_count == 0,
        delete_blocked_reason: if method_count > 0 {
            format!("Kategori masih dipakai oleh {method_count} metode pembayaran.")
        } else {
            String::new()
        },
    }
}

pub(super) fn payment_method_item_from_doc(
    document: Document,
    deposit_stats: &HashMap<String, DepositStats>,
    guest_stats: &HashMap<String, GuestStats>,
) -> PaymentMethodItem {
    let id = document
        .get_object_id("_id")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let deposit = deposit_stats.get(&id);
    let guest = guest_stats.get(&id);
    let deposit_count = deposit.map(|item| item.deposit_count).unwrap_or(0);
    let pending_deposit_count = deposit.map(|item| item.pending_deposit_count).unwrap_or(0);
    let guest_transaction_count = guest.map(|item| item.guest_transaction_count).unwrap_or(0);
    let waiting_payment_count = guest.map(|item| item.waiting_payment_count).unwrap_or(0);
    let total_usage_count = deposit_count + guest_transaction_count;
    let operational_start = read_string(&document, "operationalStart");
    let operational_end = read_string(&document, "operationalEnd");
    let category = document
        .get_document("categoryData")
        .ok()
        .and_then(payment_category_brief);
    let status = read_string(&document, "status");
    let is_operational_now = is_operational_now(&operational_start, &operational_end);
    let visibility_issues = visibility_issues(
        &status,
        category.as_ref(),
        is_operational_now,
        &operational_start,
        &operational_end,
    );
    PaymentMethodItem {
        id,
        name: read_string(&document, "name"),
        category,
        account_number: read_string(&document, "accountNumber"),
        account_name: read_string(&document, "accountName"),
        icon: read_string(&document, "icon"),
        min_amount: read_f64(&document, "minAmount"),
        max_amount: read_f64(&document, "maxAmount"),
        admin_fee: read_f64(&document, "adminFee"),
        admin_percent: read_f64(&document, "adminPercent"),
        operational_start,
        operational_end,
        use_unique_code: document.get_bool("useUniqueCode").unwrap_or(true),
        status,
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
        dependency: PaymentMethodDependency {
            deposit_count,
            pending_deposit_count,
            guest_transaction_count,
            waiting_payment_count,
            total_usage_count,
        },
        can_delete: total_usage_count == 0,
        delete_blocked_reason: if total_usage_count > 0 {
            format!("Metode ini sudah dipakai {total_usage_count} transaksi/deposit historis.")
        } else {
            String::new()
        },
        is_operational_now,
        is_visible_to_users: visibility_issues.is_empty(),
        visibility_issues,
    }
}

pub(super) fn public_payment_method_from_doc(document: Document) -> Option<Value> {
    let operational_start = read_string_default(&document, "operationalStart", "00:00");
    let operational_end = read_string_default(&document, "operationalEnd", "23:59");
    let mut item = Map::new();
    item.insert(
        "_id".to_string(),
        Value::String(document.get_object_id("_id").ok()?.to_hex()),
    );
    item.insert(
        "name".to_string(),
        Value::String(read_string(&document, "name")),
    );
    item.insert(
        "category".to_string(),
        category_brief_value(document.get_document("categoryData").ok()?)?,
    );
    item.insert(
        "accountNumber".to_string(),
        Value::String(read_string(&document, "accountNumber")),
    );
    item.insert(
        "accountName".to_string(),
        Value::String(read_string(&document, "accountName")),
    );
    item.insert(
        "minAmount".to_string(),
        number_value(read_f64_default(&document, "minAmount", 10_000.0)),
    );
    item.insert(
        "maxAmount".to_string(),
        number_value(read_f64_default(&document, "maxAmount", 5_000_000.0)),
    );
    item.insert(
        "adminFee".to_string(),
        number_value(read_f64(&document, "adminFee")),
    );
    item.insert(
        "adminPercent".to_string(),
        number_value(read_f64(&document, "adminPercent")),
    );
    item.insert(
        "operationalStart".to_string(),
        Value::String(operational_start),
    );
    item.insert("operationalEnd".to_string(), Value::String(operational_end));
    item.insert(
        "status".to_string(),
        Value::String(read_string_default(&document, "status", "active")),
    );
    item.insert(
        "createdAt".to_string(),
        Value::String(date_string(&document, "createdAt")),
    );
    item.insert(
        "updatedAt".to_string(),
        Value::String(date_string(&document, "updatedAt")),
    );
    if let Some(version) = read_i64_optional(&document, "__v") {
        item.insert("__v".to_string(), Value::Number(version.into()));
    }
    item.insert(
        "icon".to_string(),
        Value::String(read_string(&document, "icon")),
    );
    if let Ok(use_unique_code) = document.get_bool("useUniqueCode") {
        item.insert("useUniqueCode".to_string(), Value::Bool(use_unique_code));
    }
    Some(Value::Object(item))
}

pub(super) fn public_payment_category_from_doc(document: Document) -> Value {
    let mut item = Map::new();
    if let Ok(id) = document.get_object_id("_id") {
        item.insert("_id".to_string(), Value::String(id.to_hex()));
    }
    item.insert(
        "name".to_string(),
        Value::String(read_string(&document, "name")),
    );
    item.insert(
        "slug".to_string(),
        Value::String(read_string(&document, "slug")),
    );
    item.insert(
        "icon".to_string(),
        Value::String(read_string(&document, "icon")),
    );
    item.insert(
        "order".to_string(),
        Value::Number(read_i64(&document, "order").into()),
    );
    item.insert(
        "status".to_string(),
        Value::String(read_string_default(&document, "status", "active")),
    );
    item.insert(
        "createdAt".to_string(),
        Value::String(date_string(&document, "createdAt")),
    );
    item.insert(
        "updatedAt".to_string(),
        Value::String(date_string(&document, "updatedAt")),
    );
    if let Some(version) = read_i64_optional(&document, "__v") {
        item.insert("__v".to_string(), Value::Number(version.into()));
    }
    Value::Object(item)
}

pub(super) fn public_payment_method_raw_from_doc(document: Document) -> Value {
    let mut item = Map::new();
    if let Ok(id) = document.get_object_id("_id") {
        item.insert("_id".to_string(), Value::String(id.to_hex()));
    }
    item.insert(
        "name".to_string(),
        Value::String(read_string(&document, "name")),
    );
    if let Ok(category) = document.get_object_id("category") {
        item.insert("category".to_string(), Value::String(category.to_hex()));
    }
    item.insert(
        "accountNumber".to_string(),
        Value::String(read_string(&document, "accountNumber")),
    );
    item.insert(
        "accountName".to_string(),
        Value::String(read_string(&document, "accountName")),
    );
    item.insert(
        "icon".to_string(),
        Value::String(read_string(&document, "icon")),
    );
    item.insert(
        "minAmount".to_string(),
        number_value(read_f64_default(&document, "minAmount", 10_000.0)),
    );
    item.insert(
        "maxAmount".to_string(),
        number_value(read_f64_default(&document, "maxAmount", 5_000_000.0)),
    );
    item.insert(
        "adminFee".to_string(),
        number_value(read_f64(&document, "adminFee")),
    );
    item.insert(
        "adminPercent".to_string(),
        number_value(read_f64(&document, "adminPercent")),
    );
    item.insert(
        "operationalStart".to_string(),
        Value::String(read_string_default(&document, "operationalStart", "00:00")),
    );
    item.insert(
        "operationalEnd".to_string(),
        Value::String(read_string_default(&document, "operationalEnd", "23:59")),
    );
    item.insert(
        "useUniqueCode".to_string(),
        Value::Bool(document.get_bool("useUniqueCode").unwrap_or(true)),
    );
    item.insert(
        "status".to_string(),
        Value::String(read_string_default(&document, "status", "active")),
    );
    item.insert(
        "createdAt".to_string(),
        Value::String(date_string(&document, "createdAt")),
    );
    item.insert(
        "updatedAt".to_string(),
        Value::String(date_string(&document, "updatedAt")),
    );
    if let Some(version) = read_i64_optional(&document, "__v") {
        item.insert("__v".to_string(), Value::Number(version.into()));
    }
    Value::Object(item)
}

fn payment_category_brief(document: &Document) -> Option<PaymentCategoryBrief> {
    Some(PaymentCategoryBrief {
        id: document.get_object_id("_id").ok()?.to_hex(),
        name: read_string(document, "name"),
        slug: read_string(document, "slug"),
        icon: read_string(document, "icon"),
        status: read_string(document, "status"),
    })
}

fn category_brief_value(document: &Document) -> Option<Value> {
    let mut item = Map::new();
    item.insert(
        "_id".to_string(),
        Value::String(document.get_object_id("_id").ok()?.to_hex()),
    );
    item.insert(
        "name".to_string(),
        Value::String(read_string(document, "name")),
    );
    item.insert(
        "slug".to_string(),
        Value::String(read_string(document, "slug")),
    );
    item.insert(
        "icon".to_string(),
        Value::String(read_string(document, "icon")),
    );
    item.insert(
        "status".to_string(),
        Value::String(read_string(document, "status")),
    );
    Some(Value::Object(item))
}
