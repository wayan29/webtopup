use std::collections::{BTreeSet, HashMap};

use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
use serde_json::Value;

use crate::utils::bson::read_string;

use super::{
    calculate_flash_price, date_string, date_to_string, document_to_json, number_from_bson,
    object_id_from_bson, price_from_doc, FlashSaleAdminItem, FlashSaleOverlap,
    FlashSaleProductItem, FlashSaleProductRef, FlashSaleRecord, FlashSaleSummary, ProductSnapshot,
};

const FLASH_SALE_DELETE_BLOCKED_REASON: &str =
    "Flash sale yang sedang berlangsung harus dinonaktifkan atau tunggu sampai selesai sebelum dihapus.";

pub(super) async fn product_snapshots(
    client: &mongodb::Client,
    db_name: &str,
    product_ids: Vec<ObjectId>,
) -> HashMap<String, ProductSnapshot> {
    if product_ids.is_empty() {
        return HashMap::new();
    }

    match client
        .database(db_name)
        .collection::<Document>("products")
        .find(doc! { "_id": { "$in": product_ids } })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<_>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(product_snapshot_from_doc)
            .map(|product| (product.id.clone(), product))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

fn product_snapshot_from_doc(mut document: Document) -> Option<ProductSnapshot> {
    let id = document.remove("_id")?.as_object_id()?.to_hex();
    let price = document
        .get_document("price")
        .map(price_from_doc)
        .unwrap_or_default();

    Some(ProductSnapshot {
        id,
        name: read_string(&document, "name"),
        code: read_string(&document, "code"),
        price,
        icon: document.get_str("icon").ok().map(ToString::to_string),
        status: document.get_bool("status").unwrap_or(true),
        cost_price: number_from_bson(document.get("costPrice")),
    })
}

pub(super) fn flash_sale_record_from_doc(
    document: Document,
    product_map: &HashMap<String, ProductSnapshot>,
) -> FlashSaleRecord {
    let id = document
        .get_object_id("_id")
        .map(|value| value.to_hex())
        .unwrap_or_default();
    let products = document
        .get_array("products")
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_document())
                .map(|item| flash_sale_product_from_doc(item, product_map))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    FlashSaleRecord {
        id,
        name: read_string(&document, "name"),
        description: read_string(&document, "description"),
        start_date: super::date_value(&document, "startDate"),
        end_date: super::date_value(&document, "endDate"),
        products,
        is_active: document.get_bool("isActive").unwrap_or(true),
        banner: read_string(&document, "banner"),
        created_at: date_string(&document, "createdAt"),
        updated_at: date_string(&document, "updatedAt"),
    }
}

fn flash_sale_product_from_doc(
    document: &Document,
    product_map: &HashMap<String, ProductSnapshot>,
) -> FlashSaleProductItem {
    let product_ref_id = object_id_from_bson(document.get("productId"))
        .map(|id| id.to_hex())
        .unwrap_or_default();
    let product_id = product_map
        .get(&product_ref_id)
        .map(flash_sale_product_ref_from_snapshot);

    FlashSaleProductItem {
        product_ref_id,
        product_id,
        discount_type: read_string(document, "discountType"),
        discount_value: number_from_bson(document.get("discountValue")).unwrap_or_default(),
        stock: number_from_bson(document.get("stock")).unwrap_or_default(),
        sold_count: number_from_bson(document.get("soldCount")).unwrap_or_default(),
    }
}

pub(super) fn populated_flash_sale_document(
    mut document: Document,
    product_map: &HashMap<String, ProductSnapshot>,
) -> Value {
    let products = document
        .get_array("products")
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let mut product = item.as_document()?.clone();
            let product_ref_id = object_id_from_bson(product.get("productId"))?.to_hex();
            if let Some(snapshot) = product_map.get(&product_ref_id) {
                product.insert("productId", product_ref_document(snapshot));
            }
            Some(Bson::Document(product))
        })
        .collect::<Vec<_>>();
    document.insert("products", Bson::Array(products));
    document_to_json(document)
}

fn product_ref_document(snapshot: &ProductSnapshot) -> Document {
    let id = ObjectId::parse_str(&snapshot.id)
        .map(Bson::ObjectId)
        .unwrap_or_else(|_| Bson::String(snapshot.id.clone()));
    let mut document = doc! {
        "_id": id,
        "code": &snapshot.code,
        "name": &snapshot.name,
    };
    if let Some(cost_price) = snapshot.cost_price {
        document.insert("costPrice", cost_price);
    }
    document.insert(
        "price",
        doc! {
            "basic": snapshot.price.basic,
            "gold": snapshot.price.gold,
            "platinum": snapshot.price.platinum,
        },
    );
    document.insert("status", snapshot.status);
    if let Some(icon) = &snapshot.icon {
        document.insert("icon", icon.clone());
    }
    document
}

fn flash_sale_product_ref_from_snapshot(snapshot: &ProductSnapshot) -> FlashSaleProductRef {
    FlashSaleProductRef {
        id: snapshot.id.clone(),
        name: snapshot.name.clone(),
        code: snapshot.code.clone(),
        price: snapshot.price.clone(),
        icon: snapshot.icon.clone(),
        status: snapshot.status,
        cost_price: snapshot.cost_price,
    }
}

pub(super) fn enrich_flash_sales_for_admin(
    records: Vec<FlashSaleRecord>,
) -> Vec<FlashSaleAdminItem> {
    let now = DateTime::now().timestamp_millis();
    let overlap_map = build_flash_sale_overlap_map(&records);

    records
        .into_iter()
        .map(|record| {
            let status_key = flash_sale_status_key(&record, now);
            let overlapping_products = overlap_map
                .get(&record.id)
                .map(|products| {
                    products
                        .iter()
                        .map(|(product_id, detail)| FlashSaleOverlap {
                            product_id: product_id.clone(),
                            detail: detail.iter().cloned().collect(),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let summary = flash_sale_summary(&record.products, overlapping_products.len() as i64);
            let can_delete = status_key != "live";
            let has_issues = summary.missing_product_count > 0
                || summary.inactive_product_count > 0
                || summary.pricing_issue_count > 0
                || !overlapping_products.is_empty();

            FlashSaleAdminItem {
                id: record.id,
                name: record.name,
                description: record.description,
                start_date: date_to_string(&record.start_date),
                end_date: date_to_string(&record.end_date),
                products: record.products,
                is_active: record.is_active,
                banner: record.banner,
                created_at: record.created_at,
                updated_at: record.updated_at,
                status_key: status_key.to_string(),
                status_label: flash_sale_status_label(status_key).to_string(),
                product_count: summary.product_count,
                summary,
                overlapping_products,
                can_delete,
                delete_blocked_reason: if can_delete {
                    String::new()
                } else {
                    FLASH_SALE_DELETE_BLOCKED_REASON.to_string()
                },
                has_issues,
            }
        })
        .collect()
}

fn build_flash_sale_overlap_map(
    records: &[FlashSaleRecord],
) -> HashMap<String, HashMap<String, BTreeSet<String>>> {
    let active_sales = records
        .iter()
        .filter(|record| record.is_active)
        .collect::<Vec<_>>();
    let mut overlap_map: HashMap<String, HashMap<String, BTreeSet<String>>> = HashMap::new();

    for index in 0..active_sales.len() {
        for compare_index in (index + 1)..active_sales.len() {
            let current = active_sales[index];
            let compare = active_sales[compare_index];
            if !time_ranges_overlap(current, compare) {
                continue;
            }

            let current_products = current
                .products
                .iter()
                .filter(|item| !item.product_ref_id.is_empty())
                .map(|item| {
                    (
                        item.product_ref_id.clone(),
                        format_product_label(item.product_id.as_ref(), &item.product_ref_id),
                    )
                })
                .collect::<HashMap<_, _>>();

            for item in compare
                .products
                .iter()
                .filter(|item| !item.product_ref_id.is_empty())
            {
                let Some(product_label) = current_products.get(&item.product_ref_id) else {
                    continue;
                };

                overlap_map
                    .entry(current.id.clone())
                    .or_default()
                    .entry(item.product_ref_id.clone())
                    .or_default()
                    .insert(format!("{} di \"{}\"", product_label, compare.name));
                overlap_map
                    .entry(compare.id.clone())
                    .or_default()
                    .entry(item.product_ref_id.clone())
                    .or_default()
                    .insert(format!("{} di \"{}\"", product_label, current.name));
            }
        }
    }

    overlap_map
}

fn flash_sale_summary(products: &[FlashSaleProductItem], overlap_count: i64) -> FlashSaleSummary {
    let mut summary = FlashSaleSummary {
        product_count: 0,
        total_stock: 0,
        sold_count: 0,
        remaining_stock: 0,
        sold_out_count: 0,
        low_stock_count: 0,
        missing_product_count: 0,
        inactive_product_count: 0,
        pricing_issue_count: 0,
        overlap_count,
    };

    for item in products {
        let remaining_stock = (item.stock - item.sold_count).max(0);
        summary.product_count += 1;
        summary.total_stock += item.stock;
        summary.sold_count += item.sold_count;
        summary.remaining_stock += remaining_stock;

        if remaining_stock <= 0 {
            summary.sold_out_count += 1;
        }
        if remaining_stock > 0 && remaining_stock <= 5 {
            summary.low_stock_count += 1;
        }

        let Some(product) = &item.product_id else {
            summary.missing_product_count += 1;
            continue;
        };
        if !product.status {
            summary.inactive_product_count += 1;
        }
        let base_price = product.price.basic;
        let flash_price =
            calculate_flash_price(base_price, &item.discount_type, item.discount_value);
        if base_price <= 0 || flash_price >= base_price {
            summary.pricing_issue_count += 1;
        }
    }

    summary
}

pub(super) fn flash_sale_status_key(record: &FlashSaleRecord, now: i64) -> &'static str {
    if !record.is_active {
        return "inactive";
    }
    if now < record.start_date.timestamp_millis() {
        return "upcoming";
    }
    if now > record.end_date.timestamp_millis() {
        return "ended";
    }
    "live"
}

fn flash_sale_status_label(status_key: &str) -> &'static str {
    match status_key {
        "inactive" => "Nonaktif",
        "upcoming" => "Akan Datang",
        "live" => "Berlangsung",
        "ended" => "Berakhir",
        _ => "Berakhir",
    }
}

fn time_ranges_overlap(left: &FlashSaleRecord, right: &FlashSaleRecord) -> bool {
    left.start_date.timestamp_millis() < right.end_date.timestamp_millis()
        && left.end_date.timestamp_millis() > right.start_date.timestamp_millis()
}

fn format_product_label(product: Option<&FlashSaleProductRef>, fallback_id: &str) -> String {
    let name = product.map(|value| value.name.trim()).unwrap_or_default();
    let code = product.map(|value| value.code.trim()).unwrap_or_default();
    if !name.is_empty() && !code.is_empty() {
        return format!("{} ({})", name, code);
    }
    if !name.is_empty() {
        return name.to_string();
    }
    if !code.is_empty() {
        return code.to_string();
    }
    format!(
        "Produk {}",
        fallback_id
            .chars()
            .rev()
            .take(6)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )
}
