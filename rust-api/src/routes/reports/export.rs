use mongodb::bson::Document;

use crate::utils::bson::{read_i64, read_string};

pub(super) fn build_sales_export_csv(items: &[Document]) -> String {
    let mut rows = vec![vec![
        "Internal ID".to_string(),
        "Tanggal".to_string(),
        "Produk".to_string(),
        "Kode Produk".to_string(),
        "Kategori".to_string(),
        "Brand".to_string(),
        "Vendor".to_string(),
        "Member".to_string(),
        "Email".to_string(),
        "Target".to_string(),
        "Omset".to_string(),
        "Modal".to_string(),
        "Profit".to_string(),
        "Status".to_string(),
    ]];

    for item in items {
        let product = item.get_document("product").ok();
        let user = item.get_document("user").ok();
        let amount = read_i64(item, "amount");
        let cost_price = product
            .map(|product| read_i64(product, "costPrice"))
            .unwrap_or(0);
        let profit = if read_string(item, "status") == "success" && cost_price > 0 {
            amount - cost_price
        } else {
            0
        };
        let vendor_name = product
            .and_then(|product| product.get_document("vendor").ok())
            .map(|vendor| read_string(vendor, "name"))
            .unwrap_or_default();

        rows.push(vec![
            item.get_object_id("_id")
                .map(|id| id.to_hex())
                .unwrap_or_default(),
            csv_date(item, "createdAt"),
            product
                .map(|product| read_string(product, "name"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Unknown".to_string()),
            product
                .map(|product| read_string(product, "code"))
                .unwrap_or_default(),
            product
                .map(|product| read_string(product, "category"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Unknown".to_string()),
            product
                .map(|product| read_string(product, "brand"))
                .unwrap_or_default(),
            vendor_name,
            user.map(|user| read_string(user, "name"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Unknown".to_string()),
            user.map(|user| read_string(user, "email"))
                .unwrap_or_default(),
            read_string(item, "target"),
            amount.to_string(),
            cost_price.to_string(),
            profit.to_string(),
            read_string(item, "status"),
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

fn csv_date(document: &Document, key: &str) -> String {
    document
        .get_datetime(key)
        .ok()
        .and_then(|value| value.try_to_rfc3339_string().ok())
        .unwrap_or_default()
}
