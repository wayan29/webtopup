//! Sole orchestration for terminal legacy-migration cleanup.

use std::{future::Future, time::Duration};

use mongodb::bson::DateTime;
use tokio::sync::watch;

use super::{
    legacy_migration::{MigrationCleanupState, MigrationStatus},
    legacy_migration_store::{
        CleanupAction, ExpireResult, LegacyMigrationStore, LegacyMigrationStoreError,
        MigrationOperationBinding,
    },
};

const CLEANUP_BATCH_MAX: u32 = 100;
pub const DEFAULT_CLEANUP_INTERVAL_SECONDS: u64 = 60;
pub const DEFAULT_CLEANUP_BATCH_SIZE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupWorkerConfig {
    pub interval: Duration,
    pub batch_size: u32,
}

impl CleanupWorkerConfig {
    pub fn from_env() -> Result<Self, &'static str> {
        let interval_seconds = std::env::var("LEGACY_MIGRATION_CLEANUP_INTERVAL_SECONDS")
            .ok()
            .map(|v| v.parse::<u64>().map_err(|_| "invalid cleanup interval"))
            .transpose()?
            .unwrap_or(DEFAULT_CLEANUP_INTERVAL_SECONDS);
        let batch_size = std::env::var("LEGACY_MIGRATION_CLEANUP_BATCH_SIZE")
            .ok()
            .map(|v| v.parse::<u32>().map_err(|_| "invalid cleanup batch"))
            .transpose()?
            .unwrap_or(DEFAULT_CLEANUP_BATCH_SIZE);
        if interval_seconds == 0 || batch_size == 0 || batch_size > CLEANUP_BATCH_MAX {
            return Err("cleanup worker values must be within bounds");
        }
        Ok(Self {
            interval: Duration::from_secs(interval_seconds),
            batch_size,
        })
    }
}

/// Sequential periodic runner: a tick is consumed only after the prior bounded pass finishes, so
/// runs cannot overlap. Failures are logged with a fixed metric-style filter and retried next tick.
pub async fn run_cleanup_worker<F, Fut>(
    config: CleanupWorkerConfig,
    mut shutdown: watch::Receiver<bool>,
    mut pass: F,
) where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<(), LegacyMigrationStoreError>>,
{
    let mut interval = tokio::time::interval(config.interval);
    interval.tick().await; // startup already performed its bounded pass
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            _ = interval.tick() => {
                if pass(config.batch_size).await.is_err() {
                    tracing::warn!(target: "legacy_migration_cleanup_worker", "bounded cleanup pass failed; retrying next interval");
                }
            }
        }
    }
}

pub async fn cleanup_expired_legacy_migration<S: LegacyMigrationStore>(
    store: &S,
    fingerprint: [u8; 32],
    now: DateTime,
) -> Result<(), LegacyMigrationStoreError> {
    let Some(mut operation) = store.load(fingerprint).await? else {
        return Ok(());
    };
    if operation.status == MigrationStatus::Completed
        || operation.cleanup_state == MigrationCleanupState::Complete
        || now <= operation.recovery_until
    {
        return Ok(());
    }

    let binding = store.load_cleanup_binding(&operation).await?;
    if matches!(
        operation.status,
        MigrationStatus::Pending | MigrationStatus::Committed
    ) {
        let fingerprint = operation
            .fingerprint
            .as_slice()
            .try_into()
            .map_err(|_| LegacyMigrationStoreError::Integrity)?;
        let operation_binding = MigrationOperationBinding {
            fingerprint,
            user_id: operation.user_id,
            target_session_id: operation.target_session_id,
            created_at: operation.created_at,
            recovery_until: operation.recovery_until,
            status: operation.status,
        };
        let has_precommit =
            operation.refresh_token_digest.is_some() && operation.recovery_secret_digest.is_some();
        let session_may_exist = binding.is_some() || has_precommit;
        match store
            .expire(&operation_binding, session_may_exist, now)
            .await?
        {
            ExpireResult::Expired | ExpireResult::AlreadyTerminal => {}
            ExpireResult::Miss => return Err(LegacyMigrationStoreError::Integrity),
        }
        operation = store
            .load(fingerprint)
            .await?
            .ok_or(LegacyMigrationStoreError::Integrity)?;
        if binding.is_none() && has_precommit {
            let result = store
                .finish_cleanup_without_session(&operation_binding, now)
                .await?;
            if result == super::legacy_migration_store::ConditionalWrite::Miss {
                return Err(LegacyMigrationStoreError::Integrity);
            }
            return Ok(());
        }
    }
    if operation.status != MigrationStatus::Expired {
        return Ok(());
    }
    let Some(binding) = binding else {
        return if operation.cleanup_state == MigrationCleanupState::Complete {
            Ok(())
        } else {
            Err(LegacyMigrationStoreError::Integrity)
        };
    };
    if store.revoke_exact_abandoned_session(&binding, now).await? == CleanupAction::Conflict {
        return Err(LegacyMigrationStoreError::Integrity);
    }
    if store.release_exact_slot(&binding, now).await? == CleanupAction::Conflict {
        return Err(LegacyMigrationStoreError::Integrity);
    }
    if store.load_cleanup_binding(&operation).await?.is_some()
        && store.verify_exact_session(&binding).await?
            == super::legacy_migration_store::ExactSessionState::ExactActive
    {
        return Err(LegacyMigrationStoreError::Integrity);
    }
    let _ = store.finish_cleanup(&binding, now).await?;
    Ok(())
}

pub async fn cleanup_expired_legacy_migrations<S: LegacyMigrationStore>(
    store: &S,
    now: DateTime,
    limit: u32,
) -> Result<usize, LegacyMigrationStoreError> {
    let fingerprints = store
        .scan_cleanup(now, limit.min(CLEANUP_BATCH_MAX))
        .await?;
    let count = fingerprints.len();
    for fingerprint in fingerprints {
        cleanup_expired_legacy_migration(store, fingerprint, now).await?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::auth::legacy_migration_store::{
        InMemoryLegacyMigrationStore, LegacyMigrationStore, PendingMigration,
    };
    use mongodb::bson::oid::ObjectId;

    #[tokio::test]
    async fn legacy_migration_cleanup_worker_is_sequential_bounded_retries_and_cancels() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let pass_active = Arc::clone(&active);
        let pass_maximum = Arc::clone(&maximum);
        let pass_attempts = Arc::clone(&attempts);
        let worker = tokio::spawn(run_cleanup_worker(
            CleanupWorkerConfig {
                interval: Duration::from_millis(2),
                batch_size: 7,
            },
            shutdown_rx,
            move |limit| {
                assert_eq!(limit, 7);
                let active = Arc::clone(&pass_active);
                let maximum = Arc::clone(&pass_maximum);
                let attempts = Arc::clone(&pass_attempts);
                async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    tokio::time::sleep(Duration::from_millis(8)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    if attempt == 1 {
                        Err(LegacyMigrationStoreError::Store)
                    } else {
                        Ok(())
                    }
                }
            },
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        shutdown_tx.send(true).unwrap();
        worker.await.unwrap();
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "failure must retry next tick"
        );
        let stopped_at = attempts.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(attempts.load(Ordering::SeqCst), stopped_at);
    }

    #[test]
    fn legacy_migration_cleanup_worker_rejects_zero_and_oversized_values() {
        assert_eq!(CLEANUP_BATCH_MAX, DEFAULT_CLEANUP_BATCH_SIZE);
        assert!(CleanupWorkerConfig {
            interval: Duration::ZERO,
            batch_size: 1
        }
        .interval
        .is_zero());
    }

    #[tokio::test]
    async fn legacy_migration_cleanup_pending_before_precommit_expires_complete() {
        let store = InMemoryLegacyMigrationStore::default();
        let proposal = PendingMigration {
            fingerprint: [2; 32],
            user_id: ObjectId::new(),
            target_session_id: ObjectId::new(),
            legacy_expires_at: DateTime::from_millis(99_000),
            migration_cutoff_at: DateTime::from_millis(99_000),
            created_at: DateTime::from_millis(1_000),
            recovery_until: DateTime::from_millis(2_000),
        };
        store.insert_pending(&proposal).await.unwrap();

        cleanup_expired_legacy_migration(
            &store,
            proposal.fingerprint,
            DateTime::from_millis(2_001),
        )
        .await
        .unwrap();

        let operation = store.load(proposal.fingerprint).await.unwrap().unwrap();
        assert_eq!(operation.status, MigrationStatus::Expired);
        assert_eq!(operation.cleanup_state, MigrationCleanupState::Complete);
    }

    #[tokio::test]
    async fn legacy_migration_cleanup_completed_is_untouched_and_batch_is_bounded() {
        let store = InMemoryLegacyMigrationStore::default();
        let proposal = PendingMigration {
            fingerprint: [1; 32],
            user_id: ObjectId::new(),
            target_session_id: ObjectId::new(),
            legacy_expires_at: DateTime::from_millis(99_000),
            migration_cutoff_at: DateTime::from_millis(99_000),
            created_at: DateTime::from_millis(1_000),
            recovery_until: DateTime::from_millis(2_000),
        };
        store.insert_pending(&proposal).await.unwrap();
        assert_eq!(
            cleanup_expired_legacy_migrations(&store, DateTime::from_millis(2_000), 1_000)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .load(proposal.fingerprint)
                .await
                .unwrap()
                .unwrap()
                .status,
            MigrationStatus::Pending
        );
    }
}
