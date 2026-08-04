mod routes;
mod security;
#[cfg(test)]
mod security_hardening_checks;
mod services;
mod state;
mod telemetry;
mod utils;

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

    let state = Arc::new(state::AppState::from_env().await?);
    let cleanup_config = routes::auth::legacy_migration_cleanup::CleanupWorkerConfig::from_env()
        .map_err(anyhow::Error::msg)?;
    if let Some(client) = &state.mongo_client {
        let limits = routes::auth::session_migration::SessionMigrationLimits::default();
        let db = client.database(&state.mongo_db);
        routes::auth::legacy_migration_store::ensure_legacy_migration_indexes(&db)
            .await
            .context("legacy migration indexes failed before listener readiness")?;
        let cleanup_store =
            routes::auth::legacy_migration_store::MongoLegacyMigrationStore { db: &db };
        routes::auth::legacy_migration_cleanup::cleanup_expired_legacy_migrations(
            &cleanup_store,
            mongodb::bson::DateTime::now(),
            cleanup_config.batch_size,
        )
        .await
        .map_err(|_| {
            anyhow::anyhow!("legacy migration cleanup failed before listener readiness")
        })?;
        routes::auth::session_migration::migrate_session_version_at_issue(&db, limits)
            .await
            .context("auth session migration failed before listener readiness")?;
        routes::auth::session_migration::verify_predecessor_encryption_residue(
            &db,
            &state.recovery_encryption_keys,
            limits,
        )
        .await
        .context("auth recovery encryption startup verification failed")?;
        // Session slot uniqueness, session cleanup TTL, and device challenge indexes
        // are readiness requirements, not lazy first-login side effects.
        routes::auth::session_store::ensure_slot_indexes_ready(&db)
            .await
            .context("auth session indexes failed before listener readiness")?;
        // Critical financial mutations require unique(actorId,routeKey,idempotencyKey)
        // + completed-only TTL before any request can race insert_one without exclusivity.
        services::idempotency::MongoIdempotencyStore::ensure_indexes(&db)
            .await
            .map_err(|error| {
                anyhow::anyhow!("idempotency indexes failed before listener readiness: {error:?}")
            })?;
    }
    // Build the login timing material before the listener accepts traffic, so the first rejected
    // login does not pay an extra bcrypt hash and stand out from every later attempt.
    routes::auth::warm_login_timing_material();
    let app = routes::app((*state).clone());
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind API v2 on {addr}"))?;

    // Worker starts only after startup/index/migration checks and listener readiness.
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let worker_state = Arc::clone(&state);
    let worker = tokio::spawn(routes::auth::legacy_migration_cleanup::run_cleanup_worker(
        cleanup_config,
        shutdown_rx,
        move |limit| {
            let state = Arc::clone(&worker_state);
            async move {
                let Some(client) = &state.mongo_client else {
                    return Ok(());
                };
                let db = client.database(&state.mongo_db);
                let store =
                    routes::auth::legacy_migration_store::MongoLegacyMigrationStore { db: &db };
                routes::auth::legacy_migration_cleanup::cleanup_expired_legacy_migrations(
                    &store,
                    mongodb::bson::DateTime::now(),
                    limit,
                )
                .await
                .map(|_| ())
            }
        },
    ));

    info!(%addr, "API v2 listening");
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("API v2 server failed");
    let _ = shutdown_tx.send(true);
    let _ = worker.await;
    result?;

    telemetry.shutdown();
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
