//! Dry-run-first seller order index readiness scanner.
//!
//! Verifies exact unique `refId` indexes for `digiflazzsellerorders` and
//! `irssellerorders` and reports duplicate `refId` groups. `--apply` creates
//! only missing exact indexes and is an explicitly disposable-only operation:
//! the parsed database name, rather than a URI substring or environment mode,
//! is the sole database write gate. The tool never prints raw order values.

use std::{env, process::ExitCode};

use anyhow::{bail, Context};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Document},
    options::{ClientOptions, IndexOptions},
    Client, Database, IndexModel,
};
use webtopup_rust_api::services::seller_integrity::{
    inspect_seller_index_state, seller_apply_allowed, seller_order_index_requirements,
    SellerIndexState,
};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("seller order readiness failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> anyhow::Result<ExitCode> {
    dotenvy::dotenv().ok();
    let mut apply = false;
    let mut json = false;
    for argument in env::args().skip(1) {
        match argument.as_str() {
            "--apply" => apply = true,
            "--json" => json = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(ExitCode::SUCCESS);
            }
            other => bail!("unknown flag `{other}` (supported: --apply --json)"),
        }
    }

    let mongo_uri = env::var("MONGO_URI").context("MONGO_URI must be set")?;
    if mongo_uri.trim().is_empty() {
        bail!("MONGO_URI must not be empty");
    }
    let mongo_db = env::var("MONGO_DB").unwrap_or_else(|_| "POBB".to_string());
    if apply && !seller_apply_allowed(&mongo_db) {
        bail!("--apply is allowed only for the exact disposable database webtopup_task14_dev");
    }
    let mut options = ClientOptions::parse(&mongo_uri)
        .await
        .context("failed to parse MONGO_URI")?;
    options.app_name = Some("seller-order-readiness".to_string());
    let client = Client::with_options(options).context("failed to create MongoDB client")?;
    let db = client.database(&mongo_db);

    let mut snapshot = inspect(&db).await?;
    let drifted = snapshot.iter().any(|entry| entry.state == SellerIndexState::Drifted);
    let duplicates = snapshot.iter().any(|entry| entry.duplicate_ref_ids > 0);

    if apply {
        if drifted {
            print_report(&mongo_db, &snapshot, false, json);
            eprintln!("drifted refId indexes must be dropped manually before --apply");
            return Ok(ExitCode::from(1));
        }
        if duplicates {
            print_report(&mongo_db, &snapshot, false, json);
            eprintln!("duplicate refId groups must be resolved before --apply");
            return Ok(ExitCode::from(1));
        }
        for requirement in seller_order_index_requirements() {
            let state = inspect_seller_index_state(&db, &requirement)
                .await
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if state != SellerIndexState::Missing {
                continue;
            }
            let model = IndexModel::builder()
                .keys(requirement.keys.clone())
                .options(IndexOptions::builder().unique(true).build())
                .build();
            db.collection::<Document>(requirement.collection)
                .create_index(model)
                .await
                .context("failed to create exact seller refId index")?;
        }
        snapshot = inspect(&db).await?;
    }

    let blocking = snapshot
        .iter()
        .any(|entry| entry.duplicate_ref_ids > 0 || entry.state != SellerIndexState::Ready);
    print_report(&mongo_db, &snapshot, apply, json);
    if blocking {
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::SUCCESS)
}

struct CollectionSnapshot {
    collection: &'static str,
    duplicate_ref_ids: i64,
    state: SellerIndexState,
}

async fn inspect(db: &Database) -> anyhow::Result<Vec<CollectionSnapshot>> {
    let mut snapshots = Vec::new();
    for requirement in seller_order_index_requirements() {
        let state = inspect_seller_index_state(db, &requirement)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let duplicate_ref_ids = duplicate_ref_id_groups(db, requirement.collection)
            .await
            .context("duplicate refId inspection failed")?;
        snapshots.push(CollectionSnapshot {
            collection: requirement.collection,
            duplicate_ref_ids,
            state,
        });
    }
    Ok(snapshots)
}

async fn duplicate_ref_id_groups(db: &Database, collection: &str) -> mongodb::error::Result<i64> {
    let pipeline = vec![
        doc! { "$group": { "_id": "$refId", "count": { "$sum": 1 } } },
        doc! { "$match": { "count": { "$gt": 1 } } },
        doc! { "$count": "duplicateGroups" },
    ];
    let mut cursor = db.collection::<Document>(collection).aggregate(pipeline).await?;
    let mut total = 0_i64;
    while let Some(document) = cursor.try_next().await? {
        total += document
            .get("duplicateGroups")
            .and_then(mongodb::bson::Bson::as_i64)
            .unwrap_or(0);
    }
    Ok(total)
}

fn print_report(database: &str, snapshots: &[CollectionSnapshot], applied: bool, json: bool) {
    if json {
        let collections = snapshots
            .iter()
            .map(|entry| {
                format!(
                    "{{\"collection\":\"{}\",\"duplicateRefIds\":{},\"state\":\"{:?}\"}}",
                    entry.collection,
                    entry.duplicate_ref_ids,
                    entry.state,
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        println!(
            "{{\"database\":\"{database}\",\"collections\":[{collections}],\"applied\":{applied}}}"
        );
        return;
    }
    for entry in snapshots {
        println!(
            "seller readiness [{database}] {}: state={:?} duplicateRefIds={} applied={applied}",
            entry.collection, entry.state, entry.duplicate_ref_ids
        );
    }
}

fn print_usage() {
    eprintln!(
        "Usage: seller_order_readiness [--apply] [--json]\n  \
         --apply   create missing exact unique refId indexes (disposable database only)\n  \
         --json    print a single JSON report line"
    );
}

