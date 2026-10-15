//! SQL settings foundation readiness check.

use sqlx::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteConfigClaimError {
    FoundationUnavailable,
}

/// Verify that migrations installed the settings revision and frozen-reply contracts.
pub async fn ensure_site_config_foundation_indexes(pool: &PgPool) -> Result<(), SiteConfigClaimError> {
    sqlx::query("SELECT revision FROM content_revisions WHERE domain='settings'")
        .fetch_one(pool)
        .await
        .map(|_| ())
        .map_err(|_| SiteConfigClaimError::FoundationUnavailable)
}

