//! Dry-run-first identifier readiness report.
//! `--apply` creates exact identifier indexes only for `webtopup_task14_dev`.

use std::env;
use std::process::ExitCode;

use anyhow::{bail, Context};
use mongodb::options::ClientOptions;
use mongodb::Client;
use webtopup_rust_api::services::identifier_integrity::{
    apply_identifier_indexes, apply_is_allowed, build_identifier_readiness_report,
};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("identifier readiness failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> anyhow::Result<ExitCode> {
    dotenvy::dotenv().ok();
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut apply = false;
    for arg in &args {
        match arg.as_str() {
            "--apply" => apply = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(ExitCode::SUCCESS);
            }
            other => bail!("unknown flag `{other}` (supported: --apply)"),
        }
    }

    let mongo_uri = env::var("MONGO_URI").context("MONGO_URI must be set")?;
    if mongo_uri.trim().is_empty() {
        bail!("MONGO_URI must not be empty");
    }
    let mongo_db = env::var("MONGO_DB").unwrap_or_else(|_| "POBB".to_string());

    let mut client_options = ClientOptions::parse(&mongo_uri)
        .await
        .context("failed to parse MONGO_URI")?;
    client_options.app_name = Some("site-config-identifier-readiness".to_string());
    let client = Client::with_options(client_options).context("failed to create MongoDB client")?;
    let db = client.database(&mongo_db);

    let report = build_identifier_readiness_report(&db).await?;
    print_report(&report);

    if apply {
        if !apply_is_allowed(&report.database) {
            eprintln!(
                "refusing --apply for database `{}` (only webtopup_task14_dev is allowed)",
                report.database
            );
            return Ok(ExitCode::from(1));
        }
        // Missing indexes are expected for apply. Blocking data findings or drifted
        // definitions must stop apply; apply_identifier_indexes re-validates both.
        if report.findings.iter().any(|finding| finding.blocking)
            || !report.indexes.drifted.is_empty()
        {
            eprintln!("blocking data findings or drifted indexes present; not creating indexes");
            return Ok(ExitCode::from(1));
        }
        apply_identifier_indexes(&db)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        eprintln!("exact identifier indexes applied and verified");
        return Ok(ExitCode::SUCCESS);
    }

    if report.blocking {
        Ok(ExitCode::from(1))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

fn print_usage() {
    eprintln!(
        "Usage: site_config_identifier_readiness [--apply]\n\
         Default: dry-run readiness report.\n\
         --apply: create exact indexes only when MONGO_DB=webtopup_task14_dev and data checks pass."
    );
}

fn print_report(report: &webtopup_rust_api::services::identifier_integrity::IdentifierReadinessReport) {
    println!("database={}", report.database);
    println!("indexes_ready={}", report.indexes.ready);
    if !report.indexes.missing.is_empty() {
        println!("indexes_missing={}", report.indexes.missing.join(","));
    }
    if !report.indexes.drifted.is_empty() {
        println!("indexes_drifted={}", report.indexes.drifted.join(","));
    }
    println!("apply_allowed={}", report.apply_allowed);
    println!("blocking={}", report.blocking);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_guard_matches_service_policy() {
        assert!(apply_is_allowed("webtopup_task14_dev"));
        for name in ["webtopup", "POBB", "webtopup_task14_dev_backup", "", "admin"] {
            assert!(!apply_is_allowed(name), "{name}");
        }
    }
}
