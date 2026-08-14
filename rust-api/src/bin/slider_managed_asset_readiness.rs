//! Dry-run-first slider managed-asset readiness scanner.
//!
//! `--apply` is an explicitly disposable-only operation.  The parsed database name, rather than
//! a URI substring or environment mode, is the sole database write gate.

use std::{env, process::ExitCode};

use anyhow::{bail, Context};
use mongodb::{options::ClientOptions, Client};
use webtopup_rust_api::services::slider_readiness::{
    apply_slider_foundation, default_upload_root, inspect_slider_foundation,
};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("slider readiness failed: {error:#}");
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
    let mut options = ClientOptions::parse(&mongo_uri)
        .await
        .context("failed to parse MONGO_URI")?;
    options.app_name = Some("slider-managed-asset-readiness".to_string());
    let client = Client::with_options(options).context("failed to create MongoDB client")?;
    let db = client.database(&mongo_db);
    let upload_root = default_upload_root();

    if apply {
        let report = apply_slider_foundation(&db, &upload_root)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        print_report(&report, json);
        if report.blocking {
            return Ok(ExitCode::from(1));
        }
        return Ok(ExitCode::SUCCESS);
    }

    let report = inspect_slider_foundation(&db, &upload_root)
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    print_report(&report, json);
    if report.blocking {
        Ok(ExitCode::from(1))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

fn print_report(report: &webtopup_rust_api::services::slider_readiness::SliderReadinessReport, json: bool) {
    if json {
        match serde_json::to_string(report) {
            Ok(value) => println!("{value}"),
            Err(error) => eprintln!("failed to serialize readiness report: {error}"),
        }
        return;
    }
    println!("database={}", report.database);
    println!("indexes_ready={}", report.indexes.ready);
    println!("apply_allowed={}", report.apply_allowed);
    println!("blocking={}", report.blocking);
    for folder in &report.folder_readiness {
        println!(
            "folder={} writer_gate={} deletion_ready={}",
            folder.folder, folder.writer_gate, folder.deletion_ready
        );
    }
    if report.findings.is_empty() {
        println!("findings=none");
    } else {
        for finding in &report.findings {
            println!(
                "finding kind={} count={} blocking={} samples={}",
                finding.kind,
                finding.count,
                finding.blocking,
                finding.sample_ids.join(",")
            );
        }
    }
}

fn print_usage() {
    eprintln!(
        "Usage: slider_managed_asset_readiness [--apply] [--json]\n\
         Default: read-only readiness report.\n\
         --apply: create/reconcile the foundation only when MONGO_DB=webtopup_task14_dev."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use webtopup_rust_api::services::slider_readiness::apply_allowed;

    #[test]
    fn apply_guard_accepts_only_exact_disposable_database() {
        assert!(apply_allowed("webtopup_task14_dev"));
        for database in ["webtopup", "webtopup_task14", "webtopup_task14_dev_backup", ""] {
            assert!(!apply_allowed(database), "{database}");
        }
    }
}
