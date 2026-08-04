use std::collections::HashMap;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, DateTime, Document};

use crate::utils::bson::{read_i64, read_string};

use super::types::{
    AdminDepositItem, MemberDepositItem, MemberUserBrief, PaymentMethodBrief, UserBrief,
};

pub(super) fn admin_deposit_item_from_doc(mut document: Document) -> AdminDepositItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();

    AdminDepositItem {
        id,
        amount: read_i64(&document, "amount"),
        unique_code: read_i64(&document, "uniqueCode"),
        admin_fee: read_i64(&document, "adminFee"),
        total_amount: read_i64(&document, "totalAmount"),
        net_amount: read_i64(&document, "netAmount"),
        status: read_string(&document, "status"),
        created_at: date_string(&document, "createdAt").unwrap_or_default(),
        updated_at: date_string(&document, "updatedAt").unwrap_or_default(),
        assigned_at: date_string(&document, "assignedAt"),
        processed_at: date_string(&document, "processedAt"),
        processing_note: read_string(&document, "processingNote"),
        invoice_code: read_string(&document, "invoiceCode"),
        user: document
            .get_document("user")
            .ok()
            .and_then(user_brief_from_doc)
            .unwrap_or_default(),
        payment_method: document
            .get_document("paymentMethod")
            .ok()
            .and_then(payment_method_from_doc)
            .unwrap_or_default(),
        assigned_to: document
            .get_document("assignedTo")
            .ok()
            .and_then(user_brief_from_doc)
            .unwrap_or_default(),
        processed_by: document
            .get_document("processedBy")
            .ok()
            .and_then(user_brief_from_doc)
            .unwrap_or_default(),
    }
}

pub(super) fn build_admin_deposits_csv(items: &[AdminDepositItem]) -> String {
    let mut rows = vec![vec![
        "ID".to_string(),
        "Invoice".to_string(),
        "Created At".to_string(),
        "User".to_string(),
        "Email".to_string(),
        "Amount".to_string(),
        "Unique Code".to_string(),
        "Admin Fee".to_string(),
        "Net Amount".to_string(),
        "Total Transfer".to_string(),
        "Payment Method".to_string(),
        "Account Number".to_string(),
        "Account Name".to_string(),
        "Status".to_string(),
        "Assigned To".to_string(),
        "Assigned At".to_string(),
        "Processed By".to_string(),
        "Processed At".to_string(),
        "Processing Note".to_string(),
        "Updated At".to_string(),
    ]];

    for item in items {
        rows.push(vec![
            item.id.clone(),
            item.invoice_code.clone(),
            item.created_at.clone(),
            item.user.name.clone(),
            item.user.email.clone(),
            item.amount.to_string(),
            item.unique_code.to_string(),
            item.admin_fee.to_string(),
            item.net_amount.to_string(),
            item.total_amount.to_string(),
            item.payment_method.name.clone(),
            item.payment_method.account_number.clone(),
            item.payment_method.account_name.clone(),
            item.status.clone(),
            if item.assigned_to.email.is_empty() {
                item.assigned_to.name.clone()
            } else {
                item.assigned_to.email.clone()
            },
            item.assigned_at.clone().unwrap_or_default(),
            if item.processed_by.email.is_empty() {
                item.processed_by.name.clone()
            } else {
                item.processed_by.email.clone()
            },
            item.processed_at.clone().unwrap_or_default(),
            item.processing_note.clone(),
            item.updated_at.clone(),
        ]);
    }

    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|value| csv_escape(&value))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn csv_escape(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(super) fn date_key(date: DateTime) -> String {
    date.try_to_rfc3339_string()
        .ok()
        .and_then(|value| value.get(0..10).map(ToString::to_string))
        .unwrap_or_else(|| "unknown-date".to_string())
}

pub(super) fn member_deposit_item_from_doc(
    mut document: Document,
    users: &HashMap<String, MemberUserBrief>,
    payment_methods: &HashMap<String, PaymentMethodBrief>,
) -> MemberDepositItem {
    let id = document
        .remove("_id")
        .and_then(|value| value.as_object_id())
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let user_id = document
        .get_object_id("user")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let payment_method_id = document
        .get_object_id("paymentMethod")
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let has_admin_fee = has_numeric_value(&document, "adminFee");
    let admin_fee = if has_admin_fee {
        Some(read_i64(&document, "adminFee"))
    } else {
        Some(0)
    };
    let admin_fee_before_id = !has_admin_fee || key_is_before(&document, "adminFee", "_id");
    let admin_fee_before_total =
        !admin_fee_before_id && key_is_before(&document, "adminFee", "totalAmount");

    MemberDepositItem {
        admin_fee_before_id: if admin_fee_before_id { admin_fee } else { None },
        id,
        user: users.get(&user_id).cloned().unwrap_or_default(),
        amount: read_i64(&document, "amount"),
        unique_code: read_i64(&document, "uniqueCode"),
        admin_fee_before_total: if admin_fee_before_total {
            admin_fee
        } else {
            None
        },
        admin_fee_after_version: if admin_fee_before_total {
            None
        } else {
            admin_fee
        },
        total_amount: read_i64(&document, "totalAmount"),
        payment_method: payment_methods
            .get(&payment_method_id)
            .cloned()
            .unwrap_or_default(),
        status: read_string(&document, "status"),
        proof: document.get_str("proof").ok().map(ToString::to_string),
        created_at: member_date_string(&document, "createdAt"),
        updated_at: member_date_string(&document, "updatedAt"),
        version: read_i64(&document, "__v"),
    }
}

pub(super) async fn member_deposit_users(
    db: &mongodb::Database,
    deposits: &[Document],
) -> HashMap<String, MemberUserBrief> {
    let mut ids = deposits
        .iter()
        .filter_map(|doc| doc.get_object_id("user").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>("users")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "email": 1, "name": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| member_user_brief_from_doc(&doc).map(|user| (user.id.clone(), user)))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) async fn member_deposit_payment_methods(
    db: &mongodb::Database,
    deposits: &[Document],
) -> HashMap<String, PaymentMethodBrief> {
    let mut ids = deposits
        .iter()
        .filter_map(|doc| doc.get_object_id("paymentMethod").ok())
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.to_hex());
    ids.dedup();
    if ids.is_empty() {
        return HashMap::new();
    }
    match db
        .collection::<Document>("paymentmethods")
        .find(doc! { "_id": { "$in": ids } })
        .projection(doc! { "name": 1, "accountNumber": 1, "accountName": 1 })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|doc| {
                payment_method_from_doc(&doc).map(|method| (method.id.clone(), method))
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

pub(super) fn member_user_brief_from_doc(document: &Document) -> Option<MemberUserBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(MemberUserBrief {
        id,
        email: read_string(document, "email"),
        name: read_string(document, "name"),
    })
}

fn has_numeric_value(document: &Document, key: &str) -> bool {
    matches!(
        document.get(key),
        Some(Bson::Int32(_)) | Some(Bson::Int64(_)) | Some(Bson::Double(_))
    )
}

fn key_is_before(document: &Document, left: &str, right: &str) -> bool {
    let mut left_index = None;
    let mut right_index = None;
    for (index, key) in document.keys().enumerate() {
        if key == left {
            left_index = Some(index);
        } else if key == right {
            right_index = Some(index);
        }
    }
    matches!((left_index, right_index), (Some(left), Some(right)) if left < right)
}

fn user_brief_from_doc(document: &Document) -> Option<UserBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    if id.is_empty() {
        return None;
    }

    Some(UserBrief {
        id,
        name: read_string(document, "name"),
        email: read_string(document, "email"),
        role: document.get_str("role").ok().map(ToString::to_string),
    })
}

pub(super) fn payment_method_from_doc(document: &Document) -> Option<PaymentMethodBrief> {
    let id = document.get_object_id("_id").map(|id| id.to_hex()).ok()?;
    Some(PaymentMethodBrief {
        id,
        name: read_string(document, "name"),
        account_number: read_string(document, "accountNumber"),
        account_name: read_string(document, "accountName"),
    })
}

fn date_string(document: &Document, key: &str) -> Option<String> {
    document
        .get_datetime(key)
        .map(|value| {
            value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string())
        })
        .ok()
}

fn member_date_string(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .map(|value| {
            let mut text = value
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| value.to_string());
            if let Some((prefix, suffix)) =
                text.strip_suffix('Z').and_then(|body| body.split_once('.'))
            {
                let millis = format!("{suffix:0<3}");
                text = format!("{prefix}.{}Z", &millis[..3]);
            }
            text
        })
        .unwrap_or_default()
}
