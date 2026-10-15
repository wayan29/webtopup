use chrono::{DateTime as ChronoDateTime, Utc};
use sqlx::{postgres::PgRow, Row};

use super::types::{AdminDepositItem, MemberDepositItem, MemberUserBrief, PaymentMethodBrief, UserBrief};

fn row_date(row: &PgRow, key: &str) -> Option<String> {
    row.try_get::<Option<ChronoDateTime<Utc>>, _>(key)
        .ok()
        .flatten()
        .map(|value| value.to_rfc3339())
}

pub(super) fn admin_deposit_item_from_row(row: &PgRow) -> AdminDepositItem {
    let brief = |prefix: &str| {
        let id_column = format!("{prefix}_id");
        let name_column = format!("{prefix}_name");
        let email_column = format!("{prefix}_email");
        let role_column = format!("{prefix}_role");
        let id = row
            .try_get::<Option<uuid::Uuid>, _>(id_column.as_str())
            .ok()
            .flatten()
            .map(|id| id.to_string())
            .unwrap_or_default();
        if id.is_empty() {
            return UserBrief::default();
        }
        UserBrief {
            id,
            name: row.try_get::<Option<String>, _>(name_column.as_str()).ok().flatten().unwrap_or_default(),
            email: row.try_get::<Option<String>, _>(email_column.as_str()).ok().flatten().unwrap_or_default(),
            role: row.try_get::<Option<String>, _>(role_column.as_str()).ok().flatten(),
        }
    };
    let payment_method = row
        .try_get::<Option<uuid::Uuid>, _>("payment_method_id")
        .ok()
        .flatten()
        .map(|id| PaymentMethodBrief {
            id: id.to_string(),
            name: row.try_get::<Option<String>, _>("payment_method_name").ok().flatten().unwrap_or_default(),
            account_number: row.try_get::<Option<String>, _>("payment_method_account_number").ok().flatten().unwrap_or_default(),
            account_name: row.try_get::<Option<String>, _>("payment_method_account_name").ok().flatten().unwrap_or_default(),
        })
        .unwrap_or_default();
    AdminDepositItem {
        id: row.try_get::<uuid::Uuid, _>("id").map(|id| id.to_string()).unwrap_or_default(),
        amount: row.try_get("amount").unwrap_or_default(),
        unique_code: row.try_get("unique_code").unwrap_or_default(),
        admin_fee: row.try_get("admin_fee").unwrap_or_default(),
        total_amount: row.try_get::<Option<i64>, _>("total_amount").ok().flatten().unwrap_or_default(),
        net_amount: row.try_get::<Option<i64>, _>("net_amount").ok().flatten().unwrap_or_default(),
        status: row.try_get("status").unwrap_or_default(),
        created_at: row_date(row, "created_at").unwrap_or_default(),
        updated_at: row_date(row, "updated_at").unwrap_or_default(),
        assigned_at: row_date(row, "assigned_at"),
        processed_at: row_date(row, "processed_at"),
        processing_note: row.try_get::<Option<String>, _>("processing_note").ok().flatten().unwrap_or_default(),
        invoice_code: row.try_get::<Option<String>, _>("invoice_code").ok().flatten().unwrap_or_default(),
        user: brief("user"),
        payment_method,
        assigned_to: brief("assigned_to"),
        processed_by: brief("processed_by"),
    }
}
pub(super) fn member_deposit_item_from_row(row: &PgRow) -> MemberDepositItem {
    let id = row
        .try_get::<uuid::Uuid, _>("id")
        .map(|id| id.to_string())
        .unwrap_or_default();
    let user_id = row
        .try_get::<Option<uuid::Uuid>, _>("user_id")
        .ok()
        .flatten()
        .map(|id| id.to_string())
        .unwrap_or_default();
    let payment_method_id = row
        .try_get::<Option<uuid::Uuid>, _>("payment_method_id")
        .ok()
        .flatten()
        .map(|id| id.to_string())
        .unwrap_or_default();
    let admin_fee = row.try_get("admin_fee").unwrap_or_default();
    MemberDepositItem {
        admin_fee_before_id: Some(admin_fee),
        id,
        user: MemberUserBrief {
            id: user_id,
            email: row.try_get::<Option<String>, _>("user_email").ok().flatten().unwrap_or_default(),
            name: row.try_get::<Option<String>, _>("user_name").ok().flatten().unwrap_or_default(),
        },
        amount: row.try_get("amount").unwrap_or_default(),
        unique_code: row.try_get("unique_code").unwrap_or_default(),
        admin_fee_before_total: None,
        admin_fee_after_version: None,
        total_amount: row.try_get::<Option<i64>, _>("total_amount").ok().flatten().unwrap_or_default(),
        payment_method: PaymentMethodBrief {
            id: payment_method_id,
            name: row.try_get::<Option<String>, _>("payment_method_name").ok().flatten().unwrap_or_default(),
            account_number: row.try_get::<Option<String>, _>("payment_method_account_number").ok().flatten().unwrap_or_default(),
            account_name: row.try_get::<Option<String>, _>("payment_method_account_name").ok().flatten().unwrap_or_default(),
        },
        status: row.try_get("status").unwrap_or_default(),
        proof: row.try_get("proof").unwrap_or_default(),
        created_at: row_date(row, "created_at").unwrap_or_default(),
        updated_at: row_date(row, "updated_at").unwrap_or_default(),
        version: 0,
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

pub(super) fn date_key(date: ChronoDateTime<Utc>) -> String {
    date.format("%Y-%m-%d").to_string()
}
