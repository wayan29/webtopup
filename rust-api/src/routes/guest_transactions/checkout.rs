use chrono::{Datelike, Local, Timelike};
use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    ClientSession,
};
use rand::{distributions::Alphanumeric, Rng};

use crate::utils::bson::{escape_regex, read_i64, read_string};

use super::{bson_number_to_i64, bson_to_bool, format_date_part, FlashSaleReservation};

pub(super) async fn active_maintenance_message(db: &mongodb::Database) -> Option<String> {
    let settings = db.collection::<Document>("settings");
    let maintenance = settings
        .find_one(doc! { "key": "maintenanceMode" })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| bson_to_bool(&value))
        .unwrap_or(false);
    if !maintenance {
        return None;
    }
    Some(
        setting_string(
            &settings,
            "maintenanceMessage",
            "Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.",
        )
        .await,
    )
}

pub(super) async fn guest_checkout_enabled(db: &mongodb::Database) -> bool {
    db.collection::<Document>("settings")
        .find_one(doc! { "key": "guestCheckoutEnabled" })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| bson_to_bool(&value))
        .unwrap_or(true)
}

pub(super) async fn resolve_payment_category(
    db: &mongodb::Database,
    payment_method: &Document,
) -> Option<Document> {
    let category_id = payment_method.get_object_id("category").ok()?;
    db.collection::<Document>("paymentcategories")
        .find_one(doc! { "_id": category_id })
        .await
        .ok()
        .flatten()
}

pub(super) fn is_bank_transfer_category(category: &Document) -> bool {
    let name = read_string(category, "name").to_lowercase();
    let slug = read_string(category, "slug").to_lowercase();
    name.contains("bank")
        || name.contains("transfer")
        || slug.contains("bank")
        || slug.contains("transfer")
}

pub(super) fn is_operational_now(start: &str, end: &str) -> bool {
    let Some(start_minutes) = time_to_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = time_to_minutes(end) else {
        return false;
    };
    if start_minutes == end_minutes {
        return true;
    }
    let now = Local::now();
    let current_minutes = i64::from(now.hour() * 60 + now.minute());
    if start_minutes < end_minutes {
        current_minutes >= start_minutes && current_minutes <= end_minutes
    } else {
        current_minutes >= start_minutes || current_minutes <= end_minutes
    }
}

pub(super) fn product_price_for_level(product: &Document, level: &str) -> i64 {
    let price = product.get_document("price").ok();
    let key = if matches!(level, "gold" | "platinum") {
        level
    } else {
        "basic"
    };
    price
        .map(|document| read_i64(document, key))
        .filter(|value| *value > 0)
        .unwrap_or(0)
}

pub(super) async fn product_purchase_issues(
    db: &mongodb::Database,
    product: &Document,
) -> Vec<String> {
    let mut issues = Vec::new();
    if referenced_status_false(db, "categories", product.get_object_id("categoryId").ok()).await
        || named_status_false(db, "categories", &read_string(product, "category")).await
    {
        issues.push("Kategori nonaktif".to_string());
    }
    if referenced_status_false(db, "operators", product.get_object_id("operatorId").ok()).await
        || named_status_false(db, "operators", &read_string(product, "brand")).await
    {
        issues.push("Operator nonaktif".to_string());
    }
    if referenced_status_false(
        db,
        "producttypes",
        product.get_object_id("productTypeId").ok(),
    )
    .await
    {
        issues.push("Jenis produk nonaktif".to_string());
    }
    issues
}

pub(super) async fn preview_flash_sale_price_in_session(
    db: &mongodb::Database,
    session: &mut ClientSession,
    product_id: Option<ObjectId>,
    base_price: i64,
) -> Result<Option<i64>, mongodb::error::Error> {
    let Some(product_id) = product_id else {
        return Ok(None);
    };
    let now = DateTime::now();
    let Some(flash_sale) = db
        .collection::<Document>("flashsales")
        .find_one(doc! {
            "isActive": true,
            "startDate": { "$lte": now },
            "endDate": { "$gte": now },
            "products.productId": product_id,
        })
        .session(&mut *session)
        .await?
    else {
        return Ok(None);
    };
    let Some(flash_product) = flash_sale
        .get_array("products")
        .ok()
        .and_then(|products| {
            products.iter().find_map(|value| match value {
                Bson::Document(document)
                    if document.get_object_id("productId").ok() == Some(product_id) =>
                {
                    Some(document)
                }
                _ => None,
            })
        })
    else {
        return Ok(None);
    };
    if read_i64(flash_product, "stock") - read_i64(flash_product, "soldCount") <= 0 {
        return Ok(None);
    }
    let discount_value = read_i64(flash_product, "discountValue");
    let price = if read_string(flash_product, "discountType") == "percentage" {
        (base_price - ((base_price * discount_value) / 100)).max(0)
    } else {
        (base_price - discount_value).max(0)
    };
    Ok(Some(price))
}

pub(super) async fn reserve_flash_sale_stock_in_session(
    db: &mongodb::Database,
    session: &mut ClientSession,
    product_id: Option<ObjectId>,
    base_price: i64,
) -> Result<Option<FlashSaleReservation>, mongodb::error::Error> {
    let Some(product_id) = product_id else {
        return Ok(None);
    };
    let now = DateTime::now();
    let Some(flash_sale) = db
        .collection::<Document>("flashsales")
        .find_one(doc! {
            "isActive": true,
            "startDate": { "$lte": now },
            "endDate": { "$gte": now },
            "products.productId": product_id,
        })
        .session(&mut *session)
        .await?
    else {
        return Ok(None);
    };
    let Some(flash_product) = flash_sale
        .get_array("products")
        .ok()
        .and_then(|products| {
            products.iter().find_map(|value| match value {
                Bson::Document(document)
                    if document.get_object_id("productId").ok() == Some(product_id) =>
                {
                    Some(document)
                }
                _ => None,
            })
        })
    else {
        return Ok(None);
    };
    let stock = read_i64(flash_product, "stock");
    let sold_count = read_i64(flash_product, "soldCount");
    if stock - sold_count <= 0 {
        return Ok(None);
    }
    let discount_type = read_string(flash_product, "discountType");
    let discount_value = read_i64(flash_product, "discountValue");
    let price = if discount_type == "percentage" {
        (base_price - ((base_price * discount_value) / 100)).max(0)
    } else {
        (base_price - discount_value).max(0)
    };
    let Some(flash_sale_id) = flash_sale.get_object_id("_id").ok() else {
        return Ok(None);
    };
    let result = db
        .collection::<Document>("flashsales")
        .update_one(
            doc! {
                "_id": flash_sale_id,
                "products.productId": product_id,
                "$expr": {
                    "$gt": [
                        {
                            "$size": {
                                "$filter": {
                                    "input": "$products",
                                    "as": "product",
                                    "cond": {
                                        "$and": [
                                            { "$eq": ["$$product.productId", product_id] },
                                            { "$gt": [{ "$subtract": ["$$product.stock", "$$product.soldCount"] }, 0] }
                                        ]
                                    }
                                }
                            }
                        },
                        0
                    ]
                },
            },
            doc! { "$inc": { "products.$.soldCount": 1 } },
        )
        .session(&mut *session)
        .await?;
    if result.modified_count == 0 {
        return Ok(None);
    }
    Ok(Some(FlashSaleReservation {
        flash_sale_id,
        product_id,
        price,
    }))
}

pub(super) async fn generate_invoice_number(db: &mongodb::Database) -> Result<String, ()> {
    let settings = db.collection::<Document>("settings");
    let prefix = setting_string(&settings, "invoicePrefix", "INV").await;
    let date_format = setting_string(&settings, "invoiceDateFormat", "YYYYMMDD").await;
    let separator = setting_string(&settings, "invoiceSeparator", "").await;
    let random_type = setting_string(&settings, "invoiceRandomType", "alphanumeric").await;
    let raw_length = setting_i64(&settings, "invoiceRandomLength", 8).await;
    let random_length =
        crate::services::identifier_integrity::safe_invoice_length(&random_type, raw_length);
    let now = Local::now();
    let date_part = format_date_part(&date_format, now.day(), now.month(), now.year());
    let random = if random_type == "numeric" {
        let mut rng = rand::thread_rng();
        (0..random_length)
            .map(|_| rng.gen_range(0..=9).to_string())
            .collect::<String>()
    } else {
        rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(random_length)
            .map(char::from)
            .map(|character| character.to_ascii_uppercase())
            .collect::<String>()
    };
    Ok(vec![prefix, date_part, random]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(&separator))
}

async fn referenced_status_false(
    db: &mongodb::Database,
    collection: &str,
    id: Option<ObjectId>,
) -> bool {
    let Some(id) = id else {
        return false;
    };
    db.collection::<Document>(collection)
        .find_one(doc! { "_id": id })
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
}

async fn named_status_false(db: &mongodb::Database, collection: &str, name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    db.collection::<Document>(collection)
        .find_one(
            doc! { "name": { "$regex": format!("^{}$", escape_regex(name)), "$options": "i" } },
        )
        .projection(doc! { "status": 1 })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get_bool("status").ok())
        == Some(false)
}

async fn setting_string(
    collection: &mongodb::Collection<Document>,
    key: &str,
    fallback: &str,
) -> String {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .and_then(|value| match value {
            Bson::String(value) => Some(value),
            _ => Some(value.to_string()),
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

async fn setting_i64(collection: &mongodb::Collection<Document>, key: &str, fallback: i64) -> i64 {
    collection
        .find_one(doc! { "key": key })
        .await
        .ok()
        .flatten()
        .and_then(|document| document.get("value").cloned())
        .map(|value| bson_number_to_i64(&value))
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{doc, oid::ObjectId, Document};

    use super::product_price_for_level;
    use crate::routes::auth::access_session::OptionalMemberAccess;

    fn checkout_price_and_user(
        product: &Document,
        member: Option<&OptionalMemberAccess>,
    ) -> (i64, Option<ObjectId>) {
        let level = member
            .map(|member| member.level.as_str())
            .unwrap_or("basic");
        (
            product_price_for_level(product, level),
            member.map(|member| member.user_id),
        )
    }

    #[test]
    fn guest_checkout_uses_basic_price_without_user_attribution() {
        let product =
            doc! { "price": { "basic": 10_000_i64, "gold": 9_000_i64, "platinum": 8_000_i64 } };
        assert_eq!(checkout_price_and_user(&product, None), (10_000, None));
    }

    #[test]
    fn authoritative_member_level_controls_price_and_attribution() {
        let product =
            doc! { "price": { "basic": 10_000_i64, "gold": 9_000_i64, "platinum": 8_000_i64 } };
        for (level, price) in [("basic", 10_000), ("gold", 9_000), ("platinum", 8_000)] {
            let user_id = ObjectId::new();
            let member = OptionalMemberAccess {
                user_id,
                level: level.to_string(),
            };
            assert_eq!(
                checkout_price_and_user(&product, Some(&member)),
                (price, Some(user_id))
            );
        }
    }
}

fn time_to_minutes(value: &str) -> Option<i64> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<i64>().ok()?;
    let minute = minute.parse::<i64>().ok()?;
    if (0..=23).contains(&hour) && (0..=59).contains(&minute) {
        Some(hour * 60 + minute)
    } else {
        None
    }
}
