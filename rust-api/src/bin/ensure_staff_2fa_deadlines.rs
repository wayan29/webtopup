use anyhow::{Context, Result};
use mongodb::{
    bson::{doc, DateTime, Document},
    Client,
};

const HELP: &str = "Assign missing or null seven-day UTC 2FA enrollment deadlines to active owner/admin/CS users.\n\nUsage: ensure_staff_2fa_deadlines [--dry-run]\n\n--dry-run  Count matching users without writing.\n\nOutput always reports matched, modified, and dry-run counts. Safe and idempotent: only missing/null deadlines are selected. This operator command is never run at application startup.";

fn migration_filter() -> Document {
    doc! {
        "active": true,
        "role": { "$in": ["owner", "admin", "cs"] },
        "twoFactorEnabled": { "$ne": true },
        "$or": [
            { "twoFactorEnrollmentRequiredAt": { "$exists": false } },
            { "twoFactorEnrollmentRequiredAt": null },
        ],
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    if args.iter().any(|arg| arg != "--dry-run") {
        anyhow::bail!("unknown argument; run with --help");
    }
    let dry_run = args.iter().any(|arg| arg == "--dry-run");
    let uri = std::env::var("MONGO_URI").context("MONGO_URI is required")?;
    let database = std::env::var("MONGO_DB").unwrap_or_else(|_| "webtopup".to_string());
    let client = Client::with_uri_str(uri).await?;
    let users = client.database(&database).collection::<Document>("users");
    let filter = migration_filter();
    let matched = users.count_documents(filter.clone()).await?;
    if dry_run {
        println!("matched={matched} modified=0 dry_run={matched}");
        return Ok(());
    }
    let assigned_at = DateTime::now();
    let deadline = DateTime::from_millis(assigned_at.timestamp_millis() + 7 * 24 * 60 * 60 * 1_000);
    let result = users.update_many(filter, doc! { "$set": { "twoFactorEnrollmentRequiredAt": deadline, "updatedAt": assigned_at } }).await?;
    // No account identifiers or secrets are emitted.
    println!(
        "matched={} modified={} dry_run=0",
        result.matched_count, result.modified_count
    );
    Ok(())
}

#[cfg(test)]
mod auth_2fa_enrollment_migration_tests {
    use super::*;

    #[test]
    fn migration_selects_exact_active_staff_with_missing_or_null_deadline() {
        let filter = migration_filter();
        assert_eq!(filter.get_bool("active"), Ok(true));
        assert!(filter.get_document("role").is_ok());
        let alternatives = filter.get_array("$or").unwrap();
        assert_eq!(alternatives.len(), 2);
        assert!(format!("{filter:?}").contains("Null"));
    }

    #[test]
    fn migration_filter_remains_idempotent_after_assignment() {
        let filter = migration_filter();
        assert!(!format!("{filter:?}").contains("DateTime"));
        assert!(filter.get("twoFactorEnrollmentRequiredAt").is_none());
    }
}
