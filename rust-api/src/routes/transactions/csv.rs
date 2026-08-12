use super::ManualTransactionItem;

pub(super) fn build_transaction_csv(items: &[ManualTransactionItem]) -> String {
    let mut rows = vec![vec![
        "Internal ID".to_string(),
        "Ref ID".to_string(),
        "Ref vendor".to_string(),
        "Customer Ref ID".to_string(),
        "Member".to_string(),
        "Email".to_string(),
        "Produk".to_string(),
        "Kode Produk".to_string(),
        "Kategori".to_string(),
        "Brand".to_string(),
        "Vendor".to_string(),
        "Target".to_string(),
        "Nominal".to_string(),
        "Status".to_string(),
        "Sumber".to_string(),
        "Refunded".to_string(),
        "Refunded At".to_string(),
        "Refund Reason".to_string(),
        "SN".to_string(),
        "Vendor Message".to_string(),
        "Catatan Admin".to_string(),
        "Dibuat".to_string(),
        "Diupdate".to_string(),
        "Update Manual".to_string(),
        "Updated By".to_string(),
    ]];

    for item in items {
        rows.push(vec![
            item.id.clone(),
            item.reference_id.clone(),
            item.vendor_trx_id.clone(),
            item.customer_ref_id.clone(),
            item.user.name.clone(),
            item.user.email.clone(),
            item.product.name.clone(),
            item.product.code.clone(),
            item.product.category.clone(),
            item.product.brand.clone(),
            item.product.vendor_name.clone(),
            item.target.clone(),
            item.amount.to_string(),
            item.status.clone(),
            item.source.clone(),
            if item.refunded { "yes" } else { "no" }.to_string(),
            item.refunded_at.clone().unwrap_or_default(),
            item.refund_reason.clone(),
            item.sn.clone(),
            item.message.clone(),
            item.status_update_note.clone(),
            item.created_at.clone(),
            item.updated_at.clone(),
            item.status_updated_at.clone().unwrap_or_default(),
            if item.status_updated_by.email.is_empty() {
                item.status_updated_by.name.clone()
            } else {
                item.status_updated_by.email.clone()
            },
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
