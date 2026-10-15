mod routes;
mod security;
mod services;
mod state;
mod telemetry;
mod utils;
#[path = "wallet_store.rs"]
mod wallet_store;
#[path = "postgres_auth.rs"]
mod postgres_auth;
mod sql_auth;

use std::{env, net::SocketAddr, sync::Arc};

use anyhow::Context;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let telemetry = telemetry::init_tracing()?;

    let host = env::var("API_V2_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("API_V2_PORT").unwrap_or_else(|_| "9010".to_string());
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .context("API_V2_HOST/API_V2_PORT must form a valid socket address")?;

    let mut state = state::AppState::from_env().await?;
    verify_sql_schema(&state.pg_pool).await?;

    routes::settings::ensure_site_config_foundation_indexes(&state.pg_pool)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "site config foundation indexes failed before listener readiness: {error:?}"
            )
        })?;
    // Pending publish/delete journal operations must finish (or fail closed) before any
    // upload/delete request can race recovery against a live publisher.
    crate::services::managed_asset_registry::recover_pending(
        &state.pg_pool,
        &routes::uploads::upload_root(),
    )
    .await
    .map_err(|error| anyhow::anyhow!("managed asset journal recovery failed before listener readiness: {error:?}"))?;
    let readiness = crate::services::slider_readiness::probe(
        &state.pg_pool,
        &routes::uploads::upload_root(),
    )
    .await
    .context("PostgreSQL slider readiness probe failed before listener readiness")?;
    Arc::get_mut(&mut state)
        .expect("application state has not been shared before readiness")
        .slider_mutation_readiness = readiness;
    // Build the login timing material before the listener accepts traffic, so the first rejected
    // login does not pay an extra bcrypt hash and stand out from every later attempt.
    crate::sql_auth::warm_login_timing_material();
    let app = routes::app(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind API v2 on {addr}"))?;

    info!(%addr, "API v2 listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("API v2 server failed")?;

    telemetry.shutdown();
    Ok(())
}

async fn verify_sql_schema(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    const EXPECTED_MIGRATIONS: i64 = 49;
    const EXPECTED_HEAD: &str = "0058_giveaway_campaigns.sql";
    use sqlx::Row;
    let row = sqlx::query("SELECT count(*)::BIGINT AS applied, max(version) AS head FROM schema_migrations")
        .fetch_one(pool)
        .await
        .context("PostgreSQL migration ledger unavailable before listener readiness")?;
    let applied: i64 = row.try_get("applied").context("PostgreSQL migration count missing")?;
    let head: Option<String> = row.try_get("head").context("PostgreSQL migration head missing")?;
    if applied != EXPECTED_MIGRATIONS || head.as_deref() != Some(EXPECTED_HEAD) {
        anyhow::bail!("PostgreSQL schema is not at the application migration head");
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
