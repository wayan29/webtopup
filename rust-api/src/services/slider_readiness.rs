//! Startup probes for the PostgreSQL slider mutation contract.

use sqlx::PgPool;
use std::path::Path;

/// Readiness is false closed until startup verifies the SQL schema, transactional writes, and
/// managed-asset registry consistency.
#[derive(Clone, Debug, Default)]
pub struct SliderMutationReadiness {
    pub transaction_capable: bool,
    pub exact_indexes_ready: bool,
    pub registry_ready: bool,
    pub readiness_clean: bool,
    pub mutation_ready: bool,
}

pub async fn probe(pool: &PgPool, upload_root: &Path) -> Result<SliderMutationReadiness, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut *tx).await?;
    tx.rollback().await?;

    let exact_indexes_ready: bool = sqlx::query_scalar(
        "SELECT count(DISTINCT indexname)=5 FROM pg_indexes WHERE schemaname=ANY(current_schemas(false)) AND indexname=ANY($1)",
    )
    .bind(vec![
        "content_sliders_pkey",
        "content_sliders_current_order",
        "content_mutation_replies_pkey",
        "content_mutation_replies_state_lease",
        "content_mutation_replies_commit_unknown",
    ])
    .fetch_one(pool)
    .await?;

    let invalid_rows: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM managed_assets WHERE state='deleting') + (SELECT count(*) FROM managed_asset_journal WHERE status='pending') + (SELECT count(*) FROM asset_references r JOIN managed_assets a USING(path) WHERE a.state='deleted')",
    )
    .fetch_one(pool)
    .await?;
    let assets: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT path,folder,state FROM managed_assets ORDER BY path",
    )
    .fetch_all(pool)
    .await?;
    let registry_ready = invalid_rows == 0
        && assets.iter().all(|(path, folder, state)| {
            let Some(name) = path.strip_prefix(&format!("/uploads/{folder}/")) else {
                return false;
            };
            !name.is_empty()
                && !name.contains('/')
                && matches!(folder.as_str(), "icons" | "covers" | "popups" | "instructions")
                && (state == "deleted" || upload_root.join(folder).join(name).is_file())
        });

    let readiness_clean = exact_indexes_ready && registry_ready;
    Ok(SliderMutationReadiness {
        transaction_capable: true,
        exact_indexes_ready,
        registry_ready,
        readiness_clean,
        mutation_ready: readiness_clean,
    })
}
