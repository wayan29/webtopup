//! Guarded local-development fault seam.
//!
//! Disabled unless the Rust process was started with the isolated verification marker, exact
//! disposable database, loopback Mongo URI, state directory, and destructive capability. The
//! browser cannot supply any of these values. Lease consumption is atomic (`rename`) and one-shot.

use std::path::{Path, PathBuf};

use serde::Deserialize;

const GUEST_POST_COMMIT_SCENARIO: &str = "guest_checkout_response_loss_after_commit";

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

async fn consume_guest_fault_files(state_dir: &Path, capability: &str) -> bool {
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
        || lease.scenario != GUEST_POST_COMMIT_SCENARIO
        || lease.capability_digest != capability_digest
        || lease.expires_at < now_ms
        || lease.activation_id.is_empty()
    {
        return false;
    }
    if tokio::fs::rename(&lease_path, &claimed_path).await.is_err() {
        return false;
    }
    let evidence = serde_json::json!({
        "activationId": lease.activation_id,
        "scenario": GUEST_POST_COMMIT_SCENARIO,
        "mongoTransactionCommitted": true,
        "guestMarkerDurable": true,
        "idempotencyCompleteSkipped": true,
        "consumed": true,
    });
    let temporary = state_dir.join(format!("fault-evidence.{}.tmp", std::process::id()));
    let evidence_path = state_dir.join("fault-evidence.json");
    let wrote = tokio::fs::write(&temporary, evidence.to_string()).await.is_ok()
        && tokio::fs::rename(&temporary, &evidence_path).await.is_ok();
    let _ = tokio::fs::remove_file(&claimed_path).await;
    wrote
}
