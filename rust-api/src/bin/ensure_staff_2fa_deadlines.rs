use std::env;
use std::process::ExitCode;

use sqlx::postgres::PgPoolOptions;

const DISPOSABLE_DATABASE: &str = "webtopup_task14_dev";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("staff 2FA readiness failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> anyhow::Result<ExitCode> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help") {
        eprintln!("Usage: ensure_staff_2fa_deadlines [--apply]\nDefault: dry-run count.\n--apply: assign seven-day deadlines only for webtopup_task14_dev.");
        return Ok(ExitCode::SUCCESS);
    }
    if args.iter().any(|arg| arg != "--apply") { anyhow::bail!("unknown argument"); }
    let apply = args.iter().any(|arg| arg == "--apply");
    let url = env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let database = url.split('?').next().unwrap_or(&url).rsplit('/').next().filter(|name| !name.is_empty()).ok_or_else(|| anyhow::anyhow!("database name missing"))?;
    if matches!(database, "pobb" | "ppob" | "webtopup") { anyhow::bail!("refusing protected database {database}"); }
    let pool = PgPoolOptions::new().connect(&url).await?;
    let matched: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE role IN ('owner', 'admin', 'cs') AND active = TRUE AND two_factor_enabled = FALSE AND two_factor_enrollment_required_at IS NULL").fetch_one(&pool).await?;
    if !apply {
        println!("database={database} matched={matched} modified=0 dry_run=true");
        return Ok(ExitCode::SUCCESS);
    }
    if database != DISPOSABLE_DATABASE { anyhow::bail!("--apply is allowed only for {DISPOSABLE_DATABASE}"); }
    if env::var("STAFF_2FA_BACKUP_CONFIRMED").ok().as_deref() != Some("yes") { anyhow::bail!("backup confirmation STAFF_2FA_BACKUP_CONFIRMED=yes is required"); }
    let modified = sqlx::query("UPDATE users SET two_factor_enrollment_required_at = now() + interval '7 days', updated_at = now() WHERE role IN ('owner', 'admin', 'cs') AND active = TRUE AND two_factor_enabled = FALSE AND two_factor_enrollment_required_at IS NULL").execute(&pool).await?.rows_affected();
    println!("database={database} matched={matched} modified={modified} dry_run=false");
    Ok(ExitCode::SUCCESS)
}
