use std::env;

use anyhow::{bail, Context};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use mongodb::options::{ClientOptions, IndexOptions};
use mongodb::{Client, IndexModel};
use webtopup_rust_api::services::product_id::{
    accepted_product_id_from_bson, counter_seed_update, decode_counter_seq_from_document,
    PRODUCT_ID_COUNTER,
};

const UNIQUE_INDEX_NAME: &str = "uniq_products_productId";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let mongo_uri = env::var("MONGO_URI").context("MONGO_URI must be set")?;
    if mongo_uri.trim().is_empty() {
        bail!("MONGO_URI must not be empty");
    }
    let mongo_db = env::var("MONGO_DB").unwrap_or_else(|_| "POBB".to_string());

    let mut client_options = ClientOptions::parse(&mongo_uri)
        .await
        .context("failed to parse MONGO_URI")?;
    client_options.app_name = Some("ensure-product-id-integrity".to_string());
    let client = Client::with_options(client_options).context("failed to create MongoDB client")?;
    let db = client.database(&mongo_db);

    let invalid = find_invalid_product_ids(&db).await?;
    if !invalid.is_empty() {
        eprintln!(
            "Abort: found {} product document(s) with invalid productId before migration.",
            invalid.len()
        );
        for entry in summarize_invalid(&invalid) {
            eprintln!(
                "  reason={} count={} sample_ids={:?}",
                entry.reason, entry.count, entry.sample_ids
            );
        }
        eprintln!(
            "Only positive Int32/Int64 productId values are accepted. Resolve data before re-running."
        );
        std::process::exit(1);
    }

    let duplicates = find_duplicate_product_ids(&db).await?;
    if !duplicates.is_empty() {
        eprintln!(
            "Abort: found {} duplicate productId value(s) in products collection.",
            duplicates.len()
        );
        for entry in &duplicates {
            eprintln!(
                "  productId={} count={} sample_ids={:?}",
                entry.product_id, entry.count, entry.sample_ids
            );
        }
        eprintln!("Resolve duplicates manually before running this migration again.");
        std::process::exit(1);
    }

    let max_before = max_accepted_product_id(&db).await?;
    eprintln!("Max accepted products.productId before seed: {max_before}");

    let counters = db.collection::<Document>("counters");
    counters
        .update_one(
            doc! { "_id": PRODUCT_ID_COUNTER },
            counter_seed_update(max_before),
        )
        .upsert(true)
        .await
        .context("failed to seed product id counter")?;

    let products = db.collection::<Document>("products");
    let index_model = IndexModel::builder()
        .keys(doc! { "productId": 1 })
        .options(
            IndexOptions::builder()
                .unique(true)
                .name(UNIQUE_INDEX_NAME.to_string())
                .build(),
        )
        .build();
    products
        .create_index(index_model)
        .await
        .context("failed to create unique productId index")?;

    let max_after = max_accepted_product_id(&db).await?;
    let counter_seq = counter_seq(&db).await?;
    let index_ok = verify_unique_product_id_index(&db).await?;

    eprintln!("Max accepted products.productId after migration: {max_after}");
    eprintln!("Counter {PRODUCT_ID_COUNTER} seq: {counter_seq}");
    eprintln!("Unique index {UNIQUE_INDEX_NAME} verified: {index_ok}");

    if counter_seq < max_after {
        eprintln!("Invariant failed: counter seq ({counter_seq}) < max productId ({max_after})");
        std::process::exit(1);
    }
    if !index_ok {
        eprintln!(
            "Invariant failed: index {UNIQUE_INDEX_NAME} missing or does not match {{productId: 1}} unique"
        );
        std::process::exit(1);
    }

    eprintln!("Product ID integrity migration completed successfully.");
    Ok(())
}

struct InvalidProductIdEntry {
    id: ObjectId,
    reason: &'static str,
}

struct InvalidSummary {
    reason: &'static str,
    count: usize,
    sample_ids: Vec<String>,
}

fn summarize_invalid(entries: &[InvalidProductIdEntry]) -> Vec<InvalidSummary> {
    let mut order = Vec::new();
    let mut buckets: std::collections::BTreeMap<&'static str, Vec<String>> =
        std::collections::BTreeMap::new();
    for entry in entries {
        if !buckets.contains_key(entry.reason) {
            order.push(entry.reason);
        }
        buckets
            .entry(entry.reason)
            .or_default()
            .push(entry.id.to_hex());
    }
    order
        .into_iter()
        .map(|reason| {
            let ids = buckets.get(reason).cloned().unwrap_or_default();
            let count = ids.len();
            let sample_ids = ids.into_iter().take(5).collect();
            InvalidSummary {
                reason,
                count,
                sample_ids,
            }
        })
        .collect()
}

fn invalid_product_id_reason(document: &Document) -> Option<&'static str> {
    match document.get("productId") {
        None => Some("missing"),
        Some(Bson::Null) => Some("null"),
        Some(value) => {
            if accepted_product_id_from_bson(value).is_some() {
                None
            } else {
                Some("invalid_type_or_non_positive")
            }
        }
    }
}

async fn find_invalid_product_ids(
    db: &mongodb::Database,
) -> anyhow::Result<Vec<InvalidProductIdEntry>> {
    let products = db.collection::<Document>("products");
    let mut cursor = products
        .find(doc! {})
        .projection(doc! { "productId": 1 })
        .await?;
    let mut out = Vec::new();
    while let Some(document) = cursor.try_next().await? {
        let Some(id) = document.get_object_id("_id").ok() else {
            continue;
        };
        if let Some(reason) = invalid_product_id_reason(&document) {
            out.push(InvalidProductIdEntry { id, reason });
        }
    }
    Ok(out)
}

struct DuplicateProductId {
    product_id: i64,
    count: i64,
    sample_ids: Vec<String>,
}

async fn find_duplicate_product_ids(
    db: &mongodb::Database,
) -> anyhow::Result<Vec<DuplicateProductId>> {
    let products = db.collection::<Document>("products");
    let mut cursor = products
        .find(doc! { "productId": { "$exists": true, "$ne": null } })
        .projection(doc! { "productId": 1 })
        .await?;
    let mut counts: std::collections::BTreeMap<i64, (i64, Vec<String>)> =
        std::collections::BTreeMap::new();
    while let Some(document) = cursor.try_next().await? {
        let Some(product_id) = document
            .get("productId")
            .and_then(accepted_product_id_from_bson)
        else {
            continue;
        };
        let id_hex = document
            .get_object_id("_id")
            .map(|id| id.to_hex())
            .unwrap_or_default();
        let entry = counts.entry(product_id).or_insert((0, Vec::new()));
        entry.0 += 1;
        if entry.1.len() < 5 {
            entry.1.push(id_hex);
        }
    }
    Ok(counts
        .into_iter()
        .filter(|(_, (count, _))| *count > 1)
        .map(|(product_id, (count, sample_ids))| DuplicateProductId {
            product_id,
            count,
            sample_ids,
        })
        .collect())
}

async fn max_accepted_product_id(db: &mongodb::Database) -> anyhow::Result<i64> {
    let products = db.collection::<Document>("products");
    let mut cursor = products
        .find(doc! { "productId": { "$exists": true, "$ne": null } })
        .projection(doc! { "productId": 1 })
        .await?;
    let mut max = 0_i64;
    while let Some(document) = cursor.try_next().await? {
        if let Some(value) = document
            .get("productId")
            .and_then(accepted_product_id_from_bson)
        {
            max = max.max(value);
        }
    }
    Ok(max)
}

async fn counter_seq(db: &mongodb::Database) -> anyhow::Result<i64> {
    let counters = db.collection::<Document>("counters");
    let Some(document) = counters
        .find_one(doc! { "_id": PRODUCT_ID_COUNTER })
        .await?
    else {
        bail!("counter document {PRODUCT_ID_COUNTER} is missing");
    };
    decode_counter_seq_from_document(&document)
        .map_err(|reason| anyhow::anyhow!("invalid counter seq ({reason})"))
}

fn index_key_is_product_id_asc(keys: &Document) -> bool {
    match keys.get("productId") {
        Some(Bson::Int32(v)) => *v == 1,
        Some(Bson::Int64(v)) => *v == 1,
        Some(Bson::Double(v)) => *v == 1.0,
        _ => false,
    }
}

async fn verify_unique_product_id_index(db: &mongodb::Database) -> anyhow::Result<bool> {
    let products = db.collection::<Document>("products");
    let mut cursor = products.list_indexes().await?;
    while let Some(index) = cursor.try_next().await? {
        let name_ok = index
            .options
            .as_ref()
            .and_then(|options| options.name.as_deref())
            == Some(UNIQUE_INDEX_NAME);
        let unique_ok = index.options.as_ref().and_then(|options| options.unique) == Some(true);
        if name_ok && unique_ok && index_key_is_product_id_asc(&index.keys) {
            return Ok(true);
        }
    }
    Ok(false)
}
