//! Guarded local-development fault seam.
//!
//! Disabled unless the Rust process was started with the isolated verification marker, exact
//! disposable database, loopback Mongo URI, state directory, and destructive capability. The
//! browser cannot supply any of these values. Lease consumption is atomic (`rename`) and one-shot.

use std::path::{Path, PathBuf};

use serde::Deserialize;

const GUEST_POST_COMMIT_SCENARIO: &str = "guest_checkout_response_loss_after_commit";
const SITE_CONFIG_PROBE_SCENARIO: &str = "site_config_transaction_probe_unavailable";
const SITE_CONFIG_START_SCENARIO: &str = "site_config_transaction_start_unavailable";
const SITE_CONFIG_UNDO_MISMATCH_SCENARIO: &str = "site_config_claim_undo_mismatch";
const SITE_CONFIG_COMMIT_UNKNOWN_SCENARIO: &str = "site_config_commit_unknown_unresolved";
pub const MANAGED_ASSET_UNLINK_SCENARIO: &str = "managed_asset_unlink_failure";
pub const SLIDER_RESPONSE_LOSS_SCENARIO: &str = "slider_response_loss_after_commit";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaultLease {
    version: u8,
    activation_id: String,
    scenario: String,
    capability_digest: String,
    expires_at: i64,
}

pub async fn consume_guest_post_commit_fault() -> bool {
    if std::env::var("LOCAL_DEV_VERIFICATION").ok().as_deref() != Some("true")
        || std::env::var("MONGO_DB").ok().as_deref() != Some("webtopup_task14_dev")
    {
        return false;
    }
    let Ok(uri) = std::env::var("MONGO_URI") else {
        return false;
    };
    if !(uri.starts_with("mongodb://127.0.0.1:27018/webtopup_task14_dev?")
        && uri.contains("replicaSet=rs0")
        && uri.contains("directConnection=true"))
    {
        return false;
    }
    let Ok(state_dir) = std::env::var("DEV_VERIFICATION_STATE_DIR") else {
        return false;
    };
    let state_dir = PathBuf::from(state_dir);
    if state_dir.file_name().and_then(|name| name.to_str()) != Some(".dev-verification") {
        return false;
    }
    let Ok(capability) = std::env::var("LOCAL_DESTRUCTIVE_CAPABILITY") else {
        return false;
    };
    if capability.is_empty() {
        return false;
    }
    consume_guest_fault_files(&state_dir, &capability).await
}

pub async fn consume_site_config_probe_fault() -> bool {
    consume_site_config_fault(SITE_CONFIG_PROBE_SCENARIO).await
}

pub async fn consume_site_config_start_fault() -> bool {
    consume_site_config_fault(SITE_CONFIG_START_SCENARIO).await
}

pub async fn consume_site_config_undo_mismatch_fault() -> bool {
    consume_site_config_fault(SITE_CONFIG_UNDO_MISMATCH_SCENARIO).await
}

pub async fn consume_site_config_commit_unknown_fault() -> bool {
    consume_site_config_fault(SITE_CONFIG_COMMIT_UNKNOWN_SCENARIO).await
}

/// Guarded one-shot seam used only by local disposable upload verification. It is deliberately
/// consumed after the deletion transaction commits and before unlink, so a fault leaves the asset
/// in its durable `deleting` reconciliation state and cannot accidentally authorize removal.
pub async fn consume_slider_response_loss_fault() -> bool {
    let Some((state_dir, capability)) = guarded_fault_context() else {
        return false;
    };
    consume_named_fault_files(
        &state_dir,
        &capability,
        SLIDER_RESPONSE_LOSS_SCENARIO,
        serde_json::json!({
            "activationId": "",
            "scenario": SLIDER_RESPONSE_LOSS_SCENARIO,
            "rustOnly": true,
            "consumed": true,
        }),
    )
    .await
}

pub async fn consume_managed_asset_unlink_fault() -> bool {
    let Some((state_dir, capability)) = guarded_fault_context() else {
        return false;
    };
    consume_named_fault_files(
        &state_dir,
        &capability,
        MANAGED_ASSET_UNLINK_SCENARIO,
        serde_json::json!({
            "activationId": "",
            "scenario": MANAGED_ASSET_UNLINK_SCENARIO,
            "rustOnly": true,
            "consumed": true,
        }),
    )
    .await
}

async fn consume_site_config_fault(scenario: &str) -> bool {
    let Some((state_dir, capability)) = guarded_fault_context() else {
        return false;
    };
    consume_named_fault_files(&state_dir, &capability, scenario, serde_json::json!({
        "activationId": "",
        "scenario": scenario,
        "rustOnly": true,
        "consumed": true,
    })).await
}

fn guarded_fault_context() -> Option<(PathBuf, String)> {
    if std::env::var("LOCAL_DEV_VERIFICATION").ok().as_deref() != Some("true")
        || std::env::var("MONGO_DB").ok().as_deref() != Some("webtopup_task14_dev")
    {
        return None;
    }
    let uri = std::env::var("MONGO_URI").ok()?;
    if !(uri.starts_with("mongodb://127.0.0.1:27018/webtopup_task14_dev?")
        && uri.contains("replicaSet=rs0")
        && uri.contains("directConnection=true"))
    {
        return None;
    }
    let state_dir = PathBuf::from(std::env::var("DEV_VERIFICATION_STATE_DIR").ok()?);
    if state_dir.file_name().and_then(|name| name.to_str()) != Some(".dev-verification") {
        return None;
    }
    let capability = std::env::var("LOCAL_DESTRUCTIVE_CAPABILITY").ok()?;
    if capability.is_empty() {
        return None;
    }
    Some((state_dir, capability))
}

async fn consume_guest_fault_files(state_dir: &Path, capability: &str) -> bool {
    consume_named_fault_files(
        state_dir,
        capability,
        GUEST_POST_COMMIT_SCENARIO,
        serde_json::json!({
            "activationId": "",
            "scenario": GUEST_POST_COMMIT_SCENARIO,
            "mongoTransactionCommitted": true,
            "guestMarkerDurable": true,
            "idempotencyCompleteSkipped": true,
            "consumed": true,
        }),
    )
    .await
}

async fn consume_named_fault_files(
    state_dir: &Path,
    capability: &str,
    scenario: &str,
    mut evidence: serde_json::Value,
) -> bool {
    let lease_path = state_dir.join("fault-lease.json");
    let claimed_path = state_dir.join(format!("fault-lease.rust-{}.json", std::process::id()));
    let raw = match tokio::fs::read_to_string(&lease_path).await {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let Ok(lease) = serde_json::from_str::<FaultLease>(&raw) else {
        return false;
    };
    let capability_digest = crate::services::idempotency::sha256_hex(capability.as_bytes());
    let now_ms = chrono::Utc::now().timestamp_millis();
    if lease.version != 1
        || lease.scenario != scenario
        || lease.capability_digest != capability_digest
        || lease.expires_at < now_ms
        || lease.activation_id.is_empty()
    {
        return false;
    }
    if tokio::fs::rename(&lease_path, &claimed_path).await.is_err() {
        return false;
    }
    if let Some(object) = evidence.as_object_mut() {
        object.insert(
            "activationId".to_string(),
            serde_json::Value::String(lease.activation_id),
        );
    }
    let temporary = state_dir.join(format!("fault-evidence.{}.tmp", std::process::id()));
    let evidence_path = state_dir.join("fault-evidence.json");
    let wrote = tokio::fs::write(&temporary, evidence.to_string()).await.is_ok()
        && tokio::fs::rename(&temporary, &evidence_path).await.is_ok();
    let _ = tokio::fs::remove_file(&claimed_path).await;
    wrote
}
