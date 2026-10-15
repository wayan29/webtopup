use std::env;
use std::process::ExitCode;

use sqlx::postgres::PgPoolOptions;

const DISPOSABLE_DATABASE: &str = "webtopup_task14_dev";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("product id readiness failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> anyhow::Result<ExitCode> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help") {
        eprintln!("Usage: ensure_product_id_integrity [--apply]\nDefault: dry-run exact database report.\n--apply: allowed only for database webtopup_task14_dev.");
        return Ok(ExitCode::SUCCESS);
    }
    if args.iter().any(|arg| arg != "--apply") { anyhow::bail!("unknown argument"); }
    let apply = args.iter().any(|arg| arg == "--apply");
    let url = env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let database = database_name(&url)?;
    if matches!(database.as_str(), "pobb" | "ppob" | "webtopup") { anyhow::bail!("refusing protected database {database}"); }
    let pool = PgPoolOptions::new().connect(&url).await?;
    let duplicate_groups: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT product_id FROM products GROUP BY product_id HAVING count(*) > 1) duplicates").fetch_one(&pool).await?;
    let invalid: i64 = sqlx::query_scalar("SELECT count(*) FROM products WHERE product_id IS NULL OR product_id <= 0 OR product_id > 9007199254740991").fetch_one(&pool).await?;
    let missing_identity: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'products'::regclass AND attname = 'product_id' AND attidentity <> '')").fetch_one(&pool).await?;
    println!("database={database} duplicates={duplicate_groups} invalid={invalid} missing_identity={missing_identity} apply={apply}");
    if duplicate_groups > 0 || invalid > 0 || missing_identity { return Ok(ExitCode::from(1)); }
    if apply {
        if database != DISPOSABLE_DATABASE { anyhow::bail!("--apply is allowed only for {DISPOSABLE_DATABASE}"); }
        if env::var("PRODUCT_ID_BACKUP_CONFIRMED").ok().as_deref() != Some("yes") { anyhow::bail!("backup confirmation PRODUCT_ID_BACKUP_CONFIRMED=yes is required"); }
        sqlx::query("SELECT setval(pg_get_serial_sequence('products', 'product_id'), GREATEST((SELECT COALESCE(MAX(product_id), 1) FROM products), 1), true)").execute(&pool).await?;
        println!("identity_synchronized=true");
    }
    Ok(ExitCode::SUCCESS)
}

fn database_name(url: &str) -> anyhow::Result<String> {
    let without_query = url.split('?').next().unwrap_or(url);
    Ok(without_query.rsplit('/').next().filter(|name| !name.is_empty()).ok_or_else(|| anyhow::anyhow!("database name missing"))?.to_string())
}
