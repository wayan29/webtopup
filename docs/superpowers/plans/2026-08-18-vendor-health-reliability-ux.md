# Vendor Health Reliability and UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/admin/vendor-health` an honest, concise monitoring screen where provider/database failures cannot appear healthy, realtime health is authoritative, global refresh and freshness are predictable, and permission/export boundaries remain unchanged.

**Architecture:** Standardize provider balance probes on an explicit `Result` contract, then construct honest realtime/snapshot responses with stable issue codes and explicit partial/persistence state. Normalize those responses through a pure client module; refactor `VendorHealth.tsx` into one authoritative vendor-card flow plus compact diagnostics, driven by the global admin refresh event and verified in disposable integration/browser tests.

**Tech Stack:** Rust/Axum/Reqwest/MongoDB, Node/Fastify TypeScript gateway, React 19/TypeScript/Tailwind, Node test runner with `tsx`, Playwright, existing disposable `webtopup_task14_dev` stack.

**Spec:** `docs/superpowers/specs/2026-08-18-vendor-health-reliability-ux-design.md`

## Global Constraints

- Work inline on `/home/danayasa/proyek/webtopup` `main` with one sequential writer; do not create a worktree unless the user changes that instruction.
- Use strict RED/GREEN TDD: every behavior task starts with a focused failing test, then minimal implementation, focused pass, `git diff --check`, and a checkpoint commit.
- Do not install or add dependencies.
- Do not call real Digiflazz or Tokovoucher endpoints in tests. Rust probe tests use a local TCP server; browser tests use Playwright route interception.
- Preserve exact read boundary `authenticate + manageVendors` for both health endpoints.
- Preserve exact export boundary `authenticate + manageVendors + requireStepUp('exports.sensitive')` at Node and `require_trusted_step_up_group(..., "exports.sensitive")` at Rust.
- Never return, log, export, or retain provider credentials, request signatures, raw upstream bodies, secret-bearing URLs, Mongo errors, session tokens, step-up tokens, or fixture credentials.
- Realtime `/vendors/health` is the authoritative vendor operational state; `/vendors/health-snapshot` is diagnostics only.
- Missing core Mongo/vendor data is a structured `503`; auxiliary query/probe/persistence failures produce explicit `partial: true` plus stable non-secret issue codes.
- The production provider timeout is exactly 8 seconds. Tests may pass shorter internal timeouts.
- Health states are `healthy | warning | critical | disabled`; the client adds only fail-closed `unknown` fallback.
- Freshness thresholds are exact: `fresh` when age <= 120 seconds, `stale` when age > 120 seconds, `unknown` for missing/invalid timestamps.
- No automatic polling in this release; the global `admin:refresh-current-page` action is the only refresh affordance.
- Preserve the persisted `vendors` payload shape consumed by `vendor_health_snapshot_alerts()` in `rust-api/src/routes/notifications/builders.rs`.
- All browser/integration verification uses exact database `webtopup_task14_dev`; never use production for tests.
- Production provider calls, migrations, deployment, service restart, and GitHub push require later separate explicit approval.
- `cargo fmt --check` remains unavailable until `rustfmt` is installed; run `cargo check`, focused Rust tests, client/server builds, `git diff --check`, and record the formatter limitation honestly.

## Stable Issue Codes

Use these exact values in Rust responses, client parsers, tests, and CSV diagnostics:

- `VENDOR_COLLECTION_UNAVAILABLE`
- `TRANSACTION_STATS_UNAVAILABLE`
- `WEBHOOK_STATS_UNAVAILABLE`
- `LAST_WEBHOOK_UNAVAILABLE`
- `SELLER_SUMMARY_UNAVAILABLE`
- `DIGIFLAZZ_BALANCE_UNAVAILABLE`
- `TOKOVOUCHER_BALANCE_UNAVAILABLE`
- `SNAPSHOT_PERSISTENCE_FAILED`
- `MALFORMED_VENDOR_HEALTH_RESPONSE` (client-only fallback)

Each issue is serialized as `{ "code": string, "source": string }`; `source` is one of `mongodb.vendors`, `mongodb.transactions`, `mongodb.webhooks`, `mongodb.webhooks.last`, `mongodb.seller`, `provider.digiflazz`, `provider.tokovoucher`, `mongodb.settings`, or `client.parser`.

## File Structure

- Modify `rust-api/src/routes/vendors/providers.rs`: bounded Digiflazz/Tokovoucher probe contract and local-server unit tests.
- Modify `rust-api/src/routes/vendors/actions.rs`, `digiflazz.rs`, `settings.rs`, `tokovoucher.rs`: adapt all probe callers to explicit errors.
- Modify `rust-api/src/routes/vendors/types.rs`: health state/issue/diagnostics response types.
- Modify `rust-api/src/routes/vendors/health.rs`: core-vs-auxiliary failures, partial state, persistence reporting, corrected seller callback summary, CSV diagnostics, and Rust tests.
- Modify `server/src/routes/apiV2ProxyRoutes.test.ts`: pin Vendor Health permission and export step-up source contracts.
- Create `client/src/lib/vendorHealth.ts`: pure response parsers, localization metadata, freshness and value presentation.
- Create `client/src/lib/vendorHealth.test.ts`: parser/presentation contracts.
- Modify `package.json`: include the new pure test in `test:dev-verify:unit`.
- Modify `client/src/pages/admin/VendorHealth.tsx`: single authoritative rendering, compact diagnostics, global refresh, request guards, localized/accessibility semantics.
- Modify `tools/dev-verification/unit/adminPageChrome.test.ts`: source contracts for refresh, copy, hierarchy, accessibility, and retained export orchestration.
- Modify `tools/dev-verification/seed.ts`: add manager/denied Vendor Health user fixtures only; vendor documents are integration-test-local to avoid cross-matrix side effects.
- Create `tools/dev-verification/integration/vendorHealth.test.ts`: permission, contract, persistence, and export step-up verification.
- Create `tools/dev-verification/e2e/vendor-health.spec.ts`: desktop/mobile UI verification with route-intercepted degraded/stale states.
- Modify `tools/dev-verification/verificationMatrix.ts`: make integration and desktop/mobile Vendor Health checks required.
- Do not modify legacy `server/src/controllers/vendorController.ts` or `server/src/routes/vendorRoutes.ts` in this release.

---

### Task 1: Make Provider Balance Probes Explicit and Bounded

**Files:**
- Modify: `rust-api/src/routes/vendors/providers.rs:20-50,621-650`
- Modify: `rust-api/src/routes/vendors/actions.rs:45-85`
- Modify: `rust-api/src/routes/vendors/digiflazz.rs:359-390`
- Modify: `rust-api/src/routes/vendors/settings.rs:95-120,205-235`
- Modify: `rust-api/src/routes/vendors/tokovoucher.rs:200-225`
- Test: inline `#[cfg(test)]` module in `rust-api/src/routes/vendors/providers.rs`

**Interfaces:**
- Produces: `const PROVIDER_HEALTH_TIMEOUT: Duration = Duration::from_secs(8)`.
- Produces: `fetch_digiflazz_balance_with_base_url(credentials: &VendorCredentials, base_url: &str) -> Result<Value, String>`.
- Produces: `fetch_tokovoucher_balance_with_base_url(credentials: &VendorCredentials, base_url: &str) -> Result<Value, String>`.
- Produces internal testable helpers `fetch_digiflazz_balance_with_timeout(..., timeout: Duration)` and `fetch_tokovoucher_balance_with_timeout(..., timeout: Duration)`.
- Consumes: existing `VendorCredentials` and provider JSON schemas.

- [ ] **Step 1: Add failing local-server tests for success, HTTP/schema failure, and timeout**

Append a `#[cfg(test)] mod tests` in `providers.rs`. Use `std::net::TcpListener` plus `std::thread` so tests require no new Tokio features or dependency:

```rust
fn serve_once(response: &'static str, delay: Duration) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        std::thread::sleep(delay);
        let _ = stream.write_all(response.as_bytes());
    });
    format!("http://{address}")
}

#[tokio::test]
async fn digiflazz_balance_probe_rejects_missing_balance_and_times_out() {
    let credentials = VendorCredentials { username: "fixture".into(), secret: "fixture".into() };
    let malformed = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
        Duration::ZERO,
    );
    assert!(fetch_digiflazz_balance_with_timeout(&credentials, &malformed, Duration::from_secs(1)).await.is_err());

    let slow = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":1000000}}",
        Duration::from_millis(100),
    );
    let error = fetch_digiflazz_balance_with_timeout(&credentials, &slow, Duration::from_millis(10)).await.unwrap_err();
    assert!(error.contains("timeout"));
}

#[tokio::test]
async fn both_provider_probes_accept_numeric_balances_only() {
    let credentials = VendorCredentials { username: "fixture".into(), secret: "fixture".into() };
    let digiflazz = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":1000000}}",
        Duration::ZERO,
    );
    assert_eq!(
        fetch_digiflazz_balance_with_timeout(&credentials, &digiflazz, Duration::from_secs(1)).await.unwrap(),
        serde_json::json!(1000000),
    );

    let tokovoucher = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"data\":{\"saldo\":2000000}}",
        Duration::ZERO,
    );
    assert_eq!(
        fetch_tokovoucher_balance_with_timeout(&credentials, &tokovoucher, Duration::from_secs(1)).await.unwrap(),
        serde_json::json!(2000000),
    );

    let invalid = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{\"data\":{\"deposit\":\"unknown\"}}",
        Duration::ZERO,
    );
    assert!(fetch_digiflazz_balance_with_timeout(&credentials, &invalid, Duration::from_secs(1)).await.is_err());

    let rejected = serve_once(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno",
        Duration::ZERO,
    );
    assert!(fetch_tokovoucher_balance_with_timeout(&credentials, &rejected, Duration::from_secs(1)).await.is_err());
}
```

The test helper returns only generic strings such as `provider request timeout`, `provider HTTP status`, or `provider balance response invalid`; never include URLs or raw bodies.

- [ ] **Step 2: Run focused Rust tests to verify RED**

```bash
cd rust-api
cargo test routes::vendors::providers::tests -- --nocapture
```

Expected: FAIL because timeout helpers do not exist and Digiflazz still returns `Value`.

- [ ] **Step 3: Implement one strict probe contract**

In `providers.rs`:

```rust
use std::time::Duration;

pub(in crate::routes::vendors) const PROVIDER_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

fn numeric_balance(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else { return Err("provider balance response invalid".into()); };
    let valid = value.as_i64().map(|number| number >= 0).unwrap_or(false)
        || value.as_u64().is_some()
        || value.as_f64().map(|number| number.is_finite() && number >= 0.0).unwrap_or(false);
    valid.then(|| value.clone()).ok_or_else(|| "provider balance response invalid".into())
}
```

Both internal helpers must:

1. build `reqwest::Client::builder().timeout(timeout).build()`;
2. send the existing signed request;
3. require `response.status().is_success()`;
4. parse JSON;
5. call `numeric_balance()` on `/data/deposit` or `/data/saldo`;
6. map timeout to `provider request timeout`, other transport errors to `provider request failed`, non-2xx to `provider HTTP status`, and JSON/schema errors to `provider balance response invalid`.

Public functions call their timeout variants with `PROVIDER_HEALTH_TIMEOUT`.

- [ ] **Step 4: Adapt every caller without reintroducing fake zero**

Use these exact behaviors:

- `actions.rs::test_vendor_connection`: `Err(message)` returns `{ success:false, message:"Connection failed: {message}", balance:null }`.
- `settings.rs::digiflazz_settings`: match Tokovoucher behavior—reject verification failure with existing generic `Failed to save settings. Check your credentials.` and do not persist credentials.
- `digiflazz.rs::digiflazz_balance`: map probe failure to `502` through a new local `vendor_balance_upstream_error("Digiflazz balance unavailable")` helper; response contains no upstream message.
- Existing Tokovoucher endpoints keep their current generic client messages while consuming the unified timeout/error contract.
- `health.rs` adaptation is deferred to Task 3 and must remain compile-broken until that task only if both tasks are implemented in one working batch; otherwise adapt it temporarily with an explicit `match` returning `(false, Value::Null, message)`.

- [ ] **Step 5: Run focused tests and compile checks to verify GREEN**

```bash
cd rust-api
cargo test routes::vendors::providers::tests -- --nocapture
cargo check
cd ..
git diff --check
```

Expected: provider tests PASS, Rust compiles, no whitespace errors. Record that `cargo fmt --check` is unavailable because `rustfmt` is not installed.

- [ ] **Step 6: Commit the provider contract checkpoint**

```bash
git add rust-api/src/routes/vendors/providers.rs \
  rust-api/src/routes/vendors/actions.rs \
  rust-api/src/routes/vendors/digiflazz.rs \
  rust-api/src/routes/vendors/settings.rs \
  rust-api/src/routes/vendors/tokovoucher.rs \
  rust-api/src/routes/vendors/health.rs
git commit -m "fix: make vendor balance probes fail closed"
```

---

### Task 2: Define Honest Vendor Health Response Contracts

**Files:**
- Modify: `rust-api/src/routes/vendors/types.rs:130-230`
- Modify: `rust-api/src/routes/vendors/health.rs:39-103,666-720`
- Test: inline tests in `rust-api/src/routes/vendors/health.rs`

**Interfaces:**
- Produces: `VendorHealthIssue { code: &'static str, source: &'static str }`.
- Produces: `VendorHealthSnapshotResponse { ok, partial, issues, generated_at, source, vendors, totals, ... }`.
- Produces: `snapshot_response_status(core_available: bool, issues: &[VendorHealthIssue]) -> (StatusCode, bool, bool)` returning `(HTTP status, ok, partial)`.
- Produces: `seller_callback_pending_expression() -> Document` used by the aggregation and its exact test.
- Produces: health state `disabled` for intentionally inactive vendors.
- Consumes: issue codes and exact sources from Global Constraints.

- [ ] **Step 1: Add failing classification and response-shape tests**

Append/update the `health.rs` test module:

```rust
#[test]
fn inactive_vendor_is_disabled_and_failures_are_not_healthy_zeroes() {
    let empty = TransactionStats::default();
    assert_eq!(resolve_snapshot_health(true, false, &empty).0, "disabled");
    assert_eq!(resolve_realtime_health(true, false, true, false, 0, 0, 0), "disabled");
    assert_eq!(resolve_realtime_health(true, true, false, false, 0, 0, 0), "critical");
    assert_eq!(resolve_realtime_health(true, true, true, false, 0, 1, 0), "warning");
}

#[test]
fn snapshot_issue_contract_uses_stable_non_secret_codes() {
    let issue = VendorHealthIssue::new("VENDOR_COLLECTION_UNAVAILABLE", "mongodb.vendors");
    let json = serde_json::to_value(issue).unwrap();
    assert_eq!(json, serde_json::json!({
        "code": "VENDOR_COLLECTION_UNAVAILABLE",
        "source": "mongodb.vendors"
    }));
}
```

Add exact status assertions:

```rust
#[test]
fn core_failure_is_503_and_auxiliary_failure_is_partial_200() {
    assert_eq!(
        snapshot_response_status(false, &[]),
        (StatusCode::SERVICE_UNAVAILABLE, false, false),
    );
    let issues = vec![VendorHealthIssue::new(
        "TRANSACTION_STATS_UNAVAILABLE",
        "mongodb.transactions",
    )];
    assert_eq!(
        snapshot_response_status(true, &issues),
        (StatusCode::OK, true, true),
    );
}
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
cd rust-api
cargo test routes::vendors::health::tests -- --nocapture
```

Expected: FAIL because issue types/partial state/disabled classification are absent.

- [ ] **Step 3: Implement issue types and fail-closed snapshot assembly**

In `types.rs`:

```rust
#[derive(Clone, Serialize)]
pub(super) struct VendorHealthIssue {
    pub(super) code: &'static str,
    pub(super) source: &'static str,
}

impl VendorHealthIssue {
    pub(super) const fn new(code: &'static str, source: &'static str) -> Self {
        Self { code, source }
    }
}
```

Add `partial` and `issues` to `VendorHealthSnapshotResponse`. In `vendor_health_snapshot`:

- missing `mongo_client` → `503`, `ok:false`, issue `VENDOR_COLLECTION_UNAVAILABLE`;
- `vendors.find()` or cursor collection error → `503`, never `ok:true` empty;
- `transaction_stats_today` failure → `200`, `ok:true`, `partial:true`, issue `TRANSACTION_STATS_UNAVAILABLE`, and transaction fields remain present but diagnostics visibly declare them unavailable;
- no query error → `partial:false`, no issues.

Return `(StatusCode, Json(response)).into_response()` for both success and failure so status is testable.

- [ ] **Step 4: Implement disabled semantics and seller callback correctness**

- `resolve_snapshot_health(configured, active, ...)`: check `!active` first and return `("disabled", "Vendor dinonaktifkan")`.
- `resolve_realtime_health(...)`: return `disabled` before configured/balance rules.
- Replace seller `callbackPending` aggregation with a pending expression that requires callback still undelivered:

```rust
"callbackPending": { "$sum": { "$cond": [{ "$and": [
    { "$eq": ["$callbackRequired", true] },
    { "$eq": [{ "$ifNull": ["$callbackDeliveredAt", Bson::Null] }, Bson::Null] }
] }, 1, 0] } }
```

Use the same helper in the Mongo aggregation and lock its exact expression:

```rust
#[test]
fn seller_callback_pending_requires_undelivered_callback() {
    assert_eq!(
        seller_callback_pending_expression(),
        doc! { "$and": [
            { "$eq": ["$callbackRequired", true] },
            { "$eq": [
                { "$ifNull": ["$callbackDeliveredAt", Bson::Null] },
                Bson::Null
            ] }
        ] },
    );
}
```

- [ ] **Step 5: Run focused tests and compile checks to verify GREEN**

```bash
cd rust-api
cargo test routes::vendors::health::tests -- --nocapture
cargo check
cd ..
git diff --check
```

Expected: tests PASS, Rust compiles, no whitespace errors.

- [ ] **Step 6: Commit the snapshot contract checkpoint**

```bash
git add rust-api/src/routes/vendors/types.rs rust-api/src/routes/vendors/health.rs
git commit -m "fix: make vendor health snapshot diagnostics honest"
```

---

### Task 3: Surface Realtime Auxiliary and Persistence Failures

**Files:**
- Modify: `rust-api/src/routes/vendors/types.rs`
- Modify: `rust-api/src/routes/vendors/health.rs:105-145,286-475,548-655`
- Test: inline tests in `rust-api/src/routes/vendors/health.rs`

**Interfaces:**
- Produces: typed `VendorRealtimeHealthResponse` with `ok`, `partial`, `issues`, `snapshotPersisted`, `generatedAt`, `vendors`, and `seller`.
- Produces: `load_vendor_health_documents(db: &mongodb::Database) -> mongodb::error::Result<(Option<Document>, Option<Document>)>`; it queries the vendor collection directly and distinguishes query failure from missing vendor documents.
- Produces: `persist_vendor_health_snapshot(...) -> mongodb::error::Result<()>`.
- Consumes: Task 1 probe errors and Task 2 `VendorHealthIssue`.

- [ ] **Step 1: Add failing tests for partial issue aggregation and persistence mapping**

Add pure helpers and tests first:

```rust
#[test]
fn realtime_auxiliary_and_probe_failures_are_explicit() {
    let issues = realtime_issue_set(
        false, // transaction stats unavailable
        false, // webhook stats unavailable
        true,  // last webhook available
        false, // seller unavailable
        false, // Digiflazz balance unavailable
        true,  // Tokovoucher balance available
    );
    let codes = issues.iter().map(|issue| issue.code).collect::<Vec<_>>();
    assert_eq!(codes, vec![
        "TRANSACTION_STATS_UNAVAILABLE",
        "WEBHOOK_STATS_UNAVAILABLE",
        "SELLER_SUMMARY_UNAVAILABLE",
        "DIGIFLAZZ_BALANCE_UNAVAILABLE",
    ]);
}

#[test]
fn persistence_failure_keeps_metrics_but_marks_partial() {
    let (partial, persisted, issues) = apply_persistence_outcome(false, Vec::new());
    assert!(partial);
    assert!(!persisted);
    assert_eq!(issues[0].code, "SNAPSHOT_PERSISTENCE_FAILED");
}
```

Add concrete CSV diagnostics assertions:

```rust
#[test]
fn csv_exposes_only_stable_diagnostics() {
    let payload = serde_json::json!({
        "generatedAt": "2026-08-18T12:00:00.000Z",
        "partial": true,
        "snapshotPersisted": false,
        "issues": [{ "code": "SNAPSHOT_PERSISTENCE_FAILED", "source": "mongodb.settings" }],
        "vendors": []
    });
    let csv = build_vendor_health_csv(&payload);
    let header = csv.trim_start_matches('\u{FEFF}').lines().next().unwrap();
    assert!(header.contains("Partial"));
    assert!(header.contains("Snapshot Persisted"));
    assert!(header.contains("Issue Codes"));
    assert!(csv.contains("SNAPSHOT_PERSISTENCE_FAILED"));
    assert!(!csv.contains("password"));
    assert!(!csv.contains("apiKey"));
}
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
cd rust-api
cargo test routes::vendors::health::tests -- --nocapture
```

Expected: FAIL because typed response/issue helpers/persistence result are absent.

- [ ] **Step 3: Build realtime data without `unwrap_or_default` ambiguity**

Refactor `build_vendor_health_payload` into a typed response builder. Do **not** use `config::find_vendor_by_name()` here because it converts Mongo errors to `None`. Add `load_vendor_health_documents()` that performs one `vendors.find({})`, collects the cursor with `?`, then selects case-insensitive Digiflazz/Tokovoucher documents from the returned vector:

- `load_vendor_health_documents()` error is core `503` with `VENDOR_COLLECTION_UNAVAILABLE`;
- absent Digiflazz/Tokovoucher documents are valid `None` values and become unconfigured vendor items, not query failures;
- each auxiliary query is matched separately; failure provides default display structure plus its stable issue code;
- Task 1 provider `Err` becomes `balanceOk:false`, `balance: null`, sanitized `balanceMessage:"Pemeriksaan saldo tidak tersedia"`, and provider-specific issue code;
- successful numeric balance retains existing low-balance calculation;
- top-level `partial = !issues.is_empty()`;
- unknown source errors are logged server-side only as generic source/code pairs.

Do not include Rust/Mongo/Reqwest error strings in response or CSV.

- [ ] **Step 4: Return and surface persistence result**

Change:

```rust
async fn persist_vendor_health_snapshot(...) -> mongodb::error::Result<()> {
    db.collection::<Document>("settings")
        .update_one(...)
        .upsert(true)
        .await
        .map(|_| ())
}
```

After building the realtime payload:

1. persist it;
2. on success set `snapshotPersisted:true`;
3. on failure append `SNAPSHOT_PERSISTENCE_FAILED`, set `partial:true`, keep metrics, set `snapshotPersisted:false`, and emit `tracing::warn!(code = "SNAPSHOT_PERSISTENCE_FAILED", source = "mongodb.settings", "vendor health snapshot persistence failed")` without raw error.

Export builds the same honest payload, requires persistence outcome, and adds CSV columns `Partial`, `Snapshot Persisted`, `Issue Codes` (semicolon-separated stable codes).

- [ ] **Step 5: Preserve notification compatibility**

Add a test serializing the typed response to BSON and proving each persisted vendor still has:

- `key`, `label`, `balanceOk`, `lowBalance`, `balanceMessage`, `balance`, `lowBalanceThreshold`;
- no credentials, provider signature, request headers, or raw body.

Do not change `vendor_health_snapshot_alerts()` behavior in this task.

- [ ] **Step 6: Run focused Rust tests and compile checks to verify GREEN**

```bash
cd rust-api
cargo test routes::vendors::health::tests -- --nocapture
cargo check
cd ..
git diff --check
```

Expected: tests PASS, Rust compiles, no whitespace errors.

- [ ] **Step 7: Commit realtime and persistence correctness**

```bash
git add rust-api/src/routes/vendors/types.rs rust-api/src/routes/vendors/health.rs
git commit -m "fix: expose partial vendor health and snapshot persistence"
```

---

### Task 4: Add a Fail-Closed Client Vendor Health Contract

**Files:**
- Create: `client/src/lib/vendorHealth.ts`
- Create: `client/src/lib/vendorHealth.test.ts`
- Modify: `package.json:61`
- Test later: `client/src/pages/admin/VendorHealth.tsx`

**Interfaces:**
- Produces: `VendorHealthState = 'healthy' | 'warning' | 'critical' | 'disabled' | 'unknown'`.
- Produces: camelCase `VendorHealthResponse`, `VendorHealthDiagnostics`, `VendorHealthIssue`, and `VendorHealthItem` types.
- Produces: `parseVendorHealthResponse(input: unknown): VendorHealthResponse`.
- Produces: `parseVendorHealthDiagnostics(input: unknown): VendorHealthDiagnostics`.
- Produces: `vendorHealthErrorMessage(error: unknown, fallback: string): string` that reads only nested public `response.data.error.message` or `response.data.message` strings and otherwise returns the fallback.
- Produces: `vendorHealthMeta(state)`, `vendorFreshness(generatedAt, nowMs?)`, `vendorSuccessRateLabel(total, rate)`, and `vendorBalanceLabel(balanceOk, balance)`.

- [ ] **Step 1: Write failing pure contract tests**

Create `client/src/lib/vendorHealth.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseVendorHealthDiagnostics,
    parseVendorHealthResponse,
    vendorBalanceLabel,
    vendorFreshness,
    vendorHealthErrorMessage,
    vendorHealthMeta,
    vendorSuccessRateLabel,
} from './vendorHealth.ts';

test('malformed health never upgrades itself to healthy', () => {
    const parsed = parseVendorHealthResponse({ ok: true, vendors: 'invalid' });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.partial, true);
    assert.deepEqual(parsed.issues, [{ code: 'MALFORMED_VENDOR_HEALTH_RESPONSE', source: 'client.parser' }]);
});

test('snapshot snake case is normalized while Rust transaction fields stay camelCase', () => {
    const parsed = parseVendorHealthDiagnostics({
        ok: true, partial: false, issues: [], generated_at: '1787057000', source: 'mongodb-snapshot',
        vendors: [{
            key: 'digiflazz', label: 'Digiflazz', configured: true, active: true,
            low_balance_threshold: 1000, health: 'healthy', health_reason: 'normal',
            transactions_today: { total: 2, success: 2, failed: 0, pending: 0, successRate: 100, amountTotal: 5000 },
        }],
        totals: { vendors: 1, healthy: 1, warning: 0, critical: 0, transactions_today: 2 },
    });
    assert.equal(parsed.vendors[0]?.transactionsToday.successRate, 100);
    assert.equal(parsed.vendors[0]?.transactionsToday.amountTotal, 5000);
});

test('freshness and unavailable value labels are explicit', () => {
    assert.equal(vendorFreshness('2026-08-18T12:00:00.000Z', Date.parse('2026-08-18T12:02:00.000Z')).state, 'fresh');
    assert.equal(vendorFreshness('2026-08-18T12:00:00.000Z', Date.parse('2026-08-18T12:02:00.001Z')).state, 'stale');
    assert.equal(vendorFreshness('bad-date').state, 'unknown');
    assert.equal(vendorBalanceLabel(false, null), 'Tidak tersedia');
    assert.equal(vendorSuccessRateLabel(0, 0), 'Belum ada transaksi');
    assert.equal(vendorHealthMeta('disabled').label, 'Dinonaktifkan');
    assert.equal(vendorHealthMeta('unknown').label, 'Tidak diketahui');
});

test('error copy reads only the public response message', () => {
    assert.equal(
        vendorHealthErrorMessage({ response: { data: { error: { message: 'Layanan terganggu' } } } }, 'Fallback'),
        'Layanan terganggu',
    );
    assert.equal(vendorHealthErrorMessage(new Error('mongodb://secret'), 'Fallback'), 'Fallback');
});
```

Also test deduplication/allowlisting of issue codes and that unknown health strings normalize to `unknown`.

- [ ] **Step 2: Run pure tests to verify RED**

```bash
node --import tsx --test client/src/lib/vendorHealth.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the pure parser and presentation module**

Use record/type guards only; no React, DOM, Axios, Zustand, or browser globals. Requirements:

- clone only known fields;
- normalize snapshot snake_case containers to camelCase;
- read transaction fields from Rust as `successRate` and `amountTotal`;
- normalize Rust snapshot `generated_at` epoch-second strings into ISO `generatedAt` before freshness calculation; realtime ISO `generatedAt` passes through after validity checking;
- invalid top-level response returns a degraded model with `MALFORMED_VENDOR_HEALTH_RESPONSE`;
- issue list accepts only the Stable Issue Codes and exact sources;
- `vendorHealthErrorMessage` returns only allowlisted public envelope messages, never `Error.message`, URL, config, headers, or raw body;
- preserve server `ok:false` and `partial:true`; never synthesize success;
- `vendorFreshness` returns `{ state, ageSeconds, relativeLabel, absoluteLabel }` using Indonesian `Intl.DateTimeFormat` and the exact 120-second boundary.

- [ ] **Step 4: Wire the test into the aggregate unit runner**

Append `client/src/lib/vendorHealth.test.ts` to the `test:dev-verify:unit` command in root `package.json`. Do not use a wildcard that would accidentally include browser-only tests.

- [ ] **Step 5: Run focused tests and client build to verify GREEN**

```bash
node --import tsx --test client/src/lib/vendorHealth.test.ts
npm run test:dev-verify:unit
npm --prefix client run build
git diff --check
```

Expected: all tests PASS, client build exits 0, no whitespace errors.

- [ ] **Step 6: Commit the client contract checkpoint**

```bash
git add client/src/lib/vendorHealth.ts client/src/lib/vendorHealth.test.ts package.json
git commit -m "test: define fail-closed vendor health client contracts"
```

---

### Task 5: Refactor Vendor Health into One Authoritative Monitoring Flow

**Files:**
- Modify: `client/src/pages/admin/VendorHealth.tsx:1-458`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts:160-175`
- Test: `client/src/lib/vendorHealth.test.ts`

**Interfaces:**
- Consumes: all Task 4 parsers/helpers.
- Preserves: `useStepUpOrchestration`, `stepUp.run('exports.sensitive', ...)`, `/vendors/health/export`, provider settings links, and `stepUp.dialog`.
- Produces: global refresh listener that loads realtime + diagnostics with latest-request-wins guards.

- [ ] **Step 1: Change source-contract tests first to verify the old page fails**

Replace the Vendor Health refresh assertion in `adminPageChrome.test.ts` and add contracts:

```ts
assert.match(vendorHealth, /admin:refresh-current-page/);
assert.match(vendorHealth, /Promise\.all/);
assert.match(vendorHealth, /latestHealthRequestId/);
assert.match(vendorHealth, /latestDiagnosticsRequestId/);
assert.match(vendorHealth, /parseVendorHealthResponse/);
assert.match(vendorHealth, /parseVendorHealthDiagnostics/);
assert.match(vendorHealth, /role="status"/);
assert.match(vendorHealth, /role="alert"/);
assert.match(vendorHealth, /aria-busy/);
assert.match(vendorHealth, /Ekspor CSV/);
assert.match(vendorHealth, /Tidak tersedia/);
assert.match(vendorHealth, /Belum ada transaksi/);
assert.doesNotMatch(vendorHealth, /onClick=\{fetchHealth\}/);
assert.doesNotMatch(vendorHealth, /Refresh Snapshot|Snapshot Read-only Vendor|Connected|Degraded|Healthy|Warning|Critical|Success Rate|Generated:/);
```

Retain assertions for `handleExport`, `exports.sensitive`, and `stepUp.dialog`.

- [ ] **Step 2: Run the source-contract test to verify RED**

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: the Vendor Health contract test FAILS against old local refresh controls and English/duplicate snapshot UI.

- [ ] **Step 3: Replace duplicate fetch state with guarded orchestration**

In `VendorHealth.tsx`:

```ts
const latestHealthRequestId = useRef(0);
const latestDiagnosticsRequestId = useRef(0);

const fetchHealth = async () => {
    const requestId = ++latestHealthRequestId.current;
    setHealthLoading(true);
    try {
        const response = await apiV2.get('/vendors/health');
        if (requestId !== latestHealthRequestId.current) return false;
        setHealth(parseVendorHealthResponse(response.data));
        setHealthError('');
        return true;
    } catch (error: unknown) {
        if (requestId !== latestHealthRequestId.current) return false;
        setHealthError(vendorHealthErrorMessage(error, 'Gagal memuat kesehatan vendor'));
        return false;
    } finally {
        if (requestId === latestHealthRequestId.current) setHealthLoading(false);
    }
};
```

Create the parallel diagnostics equivalent. Add:

```ts
const refreshAll = () => Promise.all([fetchHealth(), fetchDiagnostics()]);
useEffect(() => {
    void refreshAll();
    const handler = () => { void refreshAll(); };
    window.addEventListener('admin:refresh-current-page', handler);
    return () => window.removeEventListener('admin:refresh-current-page', handler);
}, []);
```

Split `healthError`, `diagnosticsError`, and `exportError`. Export must not clear health errors.

- [ ] **Step 4: Render the approved hierarchy and honest states**

Replace duplicate snapshot vendor cards with:

1. four summary cards: `Perlu perhatian`, `Pending`, `Gagal`, `Saldo rendah`;
2. one diagnostics panel with API/Mongo state, `snapshotPersisted`, source, issue-code list, absolute/relative freshness;
3. one card per realtime vendor;
4. seller callback panel;
5. low-balance action panel.

Exact presentation rules:

- `vendorBalanceLabel(false, null)` → **Tidak tersedia**;
- transaction total 0 → **Belum ada transaksi**;
- disabled vendor → **Dinonaktifkan** neutral tone;
- partial/stale diagnostics → visible `role="alert"` warning while retaining last successful data;
- `ui-danger-chip` on failed/rejected summary only when value > 0; otherwise neutral/success tone;
- grid uses `sm:grid-cols-2 xl:grid-cols-4`, never five cards in four columns;
- settings action text is **Pengaturan**;
- generation copy is **Diperbarui ...**.

- [ ] **Step 5: Remove local refresh controls and complete accessibility semantics**

- Keep only **Ekspor CSV** locally.
- Root: `aria-busy={healthLoading || diagnosticsLoading || exporting ? 'true' : 'false'}`.
- Every button has `type="button"` and an explicit `aria-label`.
- Decorative icons have `aria-hidden="true"`.
- Loading/result feedback uses `role="status"`.
- Errors and partial/stale warnings use `role="alert"` without duplicating the same announcement.
- Keep `{stepUp.dialog}` as a sibling after page content.

- [ ] **Step 6: Run focused tests and client build to verify GREEN**

```bash
node --import tsx --test \
  client/src/lib/vendorHealth.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
git diff --check
```

Expected: tests PASS, client build exits 0, no local refresh/duplicate authoritative snapshot cards/English status copy remains.

- [ ] **Step 7: Commit the monitoring UI checkpoint**

```bash
git add client/src/pages/admin/VendorHealth.tsx tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: make vendor health monitoring honest and concise"
```

---

### Task 6: Pin Gateway Permission and Export Step-Up Boundaries

**Files:**
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`
- Verify: `server/src/routes/apiV2ProxyRoutes.ts:1656-1658`
- Verify: `rust-api/src/routes/vendors/health.rs:125-133`

**Interfaces:**
- Consumes: existing `authenticate`, `hasPermission('manageVendors')`, `requireStepUp('exports.sensitive')`, and Rust trusted step-up verification.
- Produces: source-contract regression tests; no production route behavior change is intended.

- [ ] **Step 1: Add failing/locking source-contract tests**

Append:

```ts
test('vendor health reads and export retain exact permission and step-up boundaries', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'routes', 'apiV2ProxyRoutes.ts'), 'utf8');
    assert.match(source, /app\.get\('\/vendors\/health', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/);
    assert.match(source, /app\.get\('\/vendors\/health-snapshot', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/);
    assert.match(source, /app\.get\('\/vendors\/health\/export', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('exports\.sensitive'\)\] \}/);

    const rust = readFileSync(join(__dirname, '..', '..', '..', 'rust-api', 'src', 'routes', 'vendors', 'health.rs'), 'utf8');
    assert.match(rust, /require_trusted_step_up_group\(&headers, "exports\.sensitive"\)/);
});
```

Also assert `server/src/app.ts` does not register legacy `vendorRoutes`, preventing a non-step-up legacy export from becoming active.

- [ ] **Step 2: Run the source test**

```bash
node --import tsx --test server/src/routes/apiV2ProxyRoutes.test.ts
```

Expected: PASS if boundaries remain correct; this is a locking test, not a behavior change.

- [ ] **Step 3: Build server and verify no route changes**

```bash
npm --prefix server run build
git diff --check
git diff -- server/src/routes/apiV2ProxyRoutes.ts rust-api/src/routes/vendors/health.rs
```

Expected: server build exits 0; the diff shows no permission/action-group weakening.

- [ ] **Step 4: Commit the security regression checkpoint**

```bash
git add server/src/routes/apiV2ProxyRoutes.test.ts
git commit -m "test: pin vendor health permission and export step-up"
```

---

### Task 7: Add Disposable Integration and Desktop/Mobile Browser Coverage

**Files:**
- Modify: `tools/dev-verification/seed.ts:120-180,230-270`
- Create: `tools/dev-verification/integration/vendorHealth.test.ts`
- Create: `tools/dev-verification/e2e/vendor-health.spec.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`

**Interfaces:**
- Produces fixtures: `vendor-health-manager` (CS, active, 2FA, `manageVendors:true`) and `vendor-health-denied` (CS, active, no `manageVendors`).
- Produces required matrix checks: `vendor-health-integration`, `vendor-health-desktop`, `vendor-health-mobile`.
- Consumes: exact API/UI contracts from Tasks 2-6.

- [ ] **Step 1: Add marked Vendor Health fixture definitions**

In `fixtureDefinitions()` add:

```ts
make('vendor-health-manager', 'vendor-health-permission-manager', 'cs', {
    permissions: { manageVendors: true },
    twoFactorEnabled: true,
}),
make('vendor-health-denied', 'vendor-health-permission-denied', 'cs', {
    permissions: {},
    twoFactorEnabled: false,
}),
```

Extend the synthetic TOTP-secret condition for `vendor-health-permission-manager`, following the existing `audit-permission-manager` pattern. Do not add vendor documents to global `seedFixtureDefinitions`; browser tests use route interception and unrelated matrix checks must not inherit Vendor Health state.

- [ ] **Step 2: Write the disposable integration test**

Create `vendorHealth.test.ts` following `integration/auditLogs.test.ts` login/step-up helpers. After asserting the exact marker/database, insert two **test-local** marked vendor documents:

```ts
await db.collection('vendors').insertMany([
  {
    name: 'Digiflazz', slug: 'digiflazz', status: true,
    apiBaseUrl: 'http://127.0.0.1:1',
    config: { username: `task14-${fixtureRunId}`, apiKey: 'synthetic-unreachable' },
    lowBalanceThreshold: 100_000, task14Fixture: true, fixtureRunId,
    createdAt: new Date(), updatedAt: new Date(), __v: 0,
  },
  {
    name: 'Tokovoucher', slug: 'tokovoucher', status: false,
    apiBaseUrl: 'http://127.0.0.1:1',
    config: { memberCode: `task14-${fixtureRunId}`, secret: 'synthetic-unreachable' },
    lowBalanceThreshold: 100_000, task14Fixture: true, fixtureRunId,
    createdAt: new Date(), updatedAt: new Date(), __v: 0,
  },
]);
```

The loopback port is intentionally unreachable so probes fail locally and can never contact external providers. Remove only `{ task14Fixture:true, fixtureRunId }` vendor/settings records in `finally`.

Prove:

1. denied fixture gets `403` for both health reads and export;
2. manager gets structured realtime response with `ok/partial/issues/snapshotPersisted/vendors/seller`;
3. empty credentials produce `balanceOk:false`, `balance:null`, `critical` for active Digiflazz and `disabled` for inactive Tokovoucher;
4. snapshot diagnostics are not `ok:true` when vendor collection is unavailable (unit-level core failure remains primary; integration validates normal shape);
5. export without grant gets `403 AUTH_STEP_UP_REQUIRED` with group `exports.sensitive`;
6. fresh step-up grant permits CSV export, content-type is CSV, BOM/header are correct, and stable issue columns contain no credentials or raw provider bodies;
7. persisted `settings.key=vendorHealthSnapshot` retains notification-compatible fields and no secrets.

The test must assert the marker and database name before any fixture mutation and clean only `task14Fixture` documents.

- [ ] **Step 3: Write desktop/mobile Playwright behavior tests**

Create `vendor-health.spec.ts`. Install routes **before** navigation. Use this exact fixture builder and race pattern:

```ts
const diagnostics = (generatedAt = String(Math.floor(Date.now() / 1000))) => ({
  ok: true, partial: false, issues: [], generated_at: generatedAt,
  source: 'mongodb-snapshot', vendors: [],
  totals: { vendors: 0, healthy: 0, warning: 0, critical: 0, transactions_today: 0 },
});
const health = (name: string, generatedAt = new Date().toISOString()) => ({
  ok: true, partial: false, issues: [], snapshotPersisted: true, generatedAt,
  vendors: [{
    key: 'digiflazz', label: name, configured: true, active: true,
    balance: 1_000_000, balanceOk: true, lowBalanceThreshold: 100_000,
    lowBalance: false, balanceMessage: 'OK', health: 'healthy',
    transactionsToday: { total: 0, success: 0, failed: 0, pending: 0, successRate: 0, amountTotal: 0 },
    webhookToday: { total: 0, rejected: 0, failed: 0, delivered: 0, lastAt: null, lastStatus: '', lastMessage: '' },
  }],
  seller: { total: 0, pending: 0, failed: 0, callbackPending: 0, callbackDelivered: 0, health: 'healthy' },
});

test('vendor health is authoritative, refreshable, and honest', async ({ page }, testInfo) => {
  await staffLogin(page, 'vendor-health-manager');
  let healthRequests = 0;
  let diagnosticsRequests = 0;
  let mode: 'fresh' | 'race' | 'partial' = 'fresh';

  await page.route('**/api/v2/vendors/health', async (route) => {
    healthRequests += 1;
    if (mode === 'race' && healthRequests % 2 === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health('Old Vendor')) });
    }
    if (mode === 'partial') {
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      const body: any = health('Digiflazz', stale);
      body.partial = true;
      body.snapshotPersisted = false;
      body.issues = [{ code: 'DIGIFLAZZ_BALANCE_UNAVAILABLE', source: 'provider.digiflazz' }];
      body.vendors[0] = { ...body.vendors[0]!, balance: null, balanceOk: false, balanceMessage: 'Pemeriksaan saldo tidak tersedia', health: 'critical' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health(mode === 'race' ? 'Newest Vendor' : 'Digiflazz')) });
  });
  await page.route('**/api/v2/vendors/health-snapshot', async (route) => {
    diagnosticsRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(diagnostics()) });
  });

  await page.goto('/admin/vendor-health');
  await expect(page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh Snapshot' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ekspor CSV' })).toBeVisible();
  await expect(page.getByText('Belum ada transaksi')).toBeVisible();
  await expect(page.getByText('Diagnostik API dan MongoDB')).toBeVisible();

  const beforeHealth = healthRequests;
  const beforeDiagnostics = diagnosticsRequests;
  await page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' }).click();
  await expect.poll(() => healthRequests).toBe(beforeHealth + 1);
  await expect.poll(() => diagnosticsRequests).toBe(beforeDiagnostics + 1);

  mode = 'race';
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
    window.dispatchEvent(new CustomEvent('admin:refresh-current-page'));
  });
  await expect(page.getByText('Newest Vendor')).toBeVisible();
  await expect(page.getByText('Old Vendor')).toHaveCount(0);

  mode = 'partial';
  await page.getByRole('button', { name: 'Segarkan Kesehatan Vendor' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'DIGIFLAZZ_BALANCE_UNAVAILABLE' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: /kedaluwarsa|stale/i })).toBeVisible();
  await expect(page.getByText('Tidak tersedia')).toBeVisible();
  if (testInfo.project.name === 'chromium-mobile') {
    await expect(page.locator('article').filter({ hasText: 'Digiflazz' })).toBeVisible();
  }
});
```

Do not intercept or click the export endpoint in this browser test; integration proves export and step-up. Browser only checks **Ekspor CSV** remains present, while the existing `stepUp.dialog` source contract remains pinned by `adminPageChrome.test.ts`.

- [ ] **Step 4: Add required verification-matrix checks**

After audit checks in `verificationMatrix.ts` add:

```ts
check('vendor-health-integration', 'session-cs', 'npx', [
  'playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts',
  'vendorHealth.test.ts', '--project=chromium-desktop', '--workers=1'
], true),
check('vendor-health-desktop', 'session-cs', 'npx', [
  'playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts',
  'vendor-health.spec.ts', '--project=chromium-desktop', '--workers=1'
], true),
check('vendor-health-mobile', 'session-cs', 'npx', [
  'playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts',
  'vendor-health.spec.ts', '--project=chromium-mobile', '--workers=1'
], true),
```

- [ ] **Step 5: Start a fresh disposable stack**

```bash
npm run dev-verify -- setup
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
```

Expected: exact DB `webtopup_task14_dev`, marked fixture state, host processes healthy. If re-bootstrap occurs while host is already running, run `host-down` first and restart after seeding to avoid stale in-memory state.

- [ ] **Step 6: Run focused integration and desktop/mobile checks**

```bash
npx playwright test \
  --config tools/dev-verification/playwright.integration.config.ts \
  vendorHealth.test.ts --project=chromium-desktop --workers=1

npx playwright test \
  --config tools/dev-verification/playwright.config.ts \
  vendor-health.spec.ts --project=chromium-desktop --workers=1

npx playwright test \
  --config tools/dev-verification/playwright.config.ts \
  vendor-health.spec.ts --project=chromium-mobile --workers=1
```

Expected: all three checks PASS. If repeated login attempts exhaust device slots, re-bootstrap/seed and restart hosts before the canonical desktop→mobile run; do not weaken device policy.

- [ ] **Step 7: Tear down and prove no disposable services remain**

```bash
npm run dev-verify -- host-down
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Expected: `{"serviceCount":0}`.

- [ ] **Step 8: Commit the end-to-end coverage checkpoint**

```bash
git add tools/dev-verification/seed.ts \
  tools/dev-verification/integration/vendorHealth.test.ts \
  tools/dev-verification/e2e/vendor-health.spec.ts \
  tools/dev-verification/verificationMatrix.ts
git commit -m "test: verify vendor health reliability end to end"
```

---

### Task 8: Focused, Aggregate, and Independent Verification

**Files:**
- Verify: all Task 1-7 files
- Update after success: `docs/superpowers/plans/2026-08-18-vendor-health-reliability-ux.md` checkboxes

**Interfaces:**
- Consumes: complete implementation and required matrix entries.
- Produces: fresh evidence for code review and a production-release handoff; no production action.

- [ ] **Step 1: Run all focused unit/source checks**

```bash
cd rust-api
cargo test routes::vendors::providers::tests -- --nocapture
cargo test routes::vendors::health::tests -- --nocapture
cargo check
cd ..
node --import tsx --test \
  client/src/lib/vendorHealth.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts \
  server/src/routes/apiV2ProxyRoutes.test.ts
npm run test:dev-verify:unit
```

Expected: all tests PASS and Rust compiles. Report `rustfmt` unavailable; do not claim formatter success.

- [ ] **Step 2: Run client/server builds and diff checks**

```bash
npm --prefix client run build
npm --prefix server run build
git diff --check
```

Expected: both builds exit 0 and no whitespace errors.

- [ ] **Step 3: Bring up infrastructure and run the full disposable matrix**

The aggregate runner expects Mongo infrastructure to be running:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- test
```

Expected: final result `LOCAL DEV VERIFIED`, now including the three required Vendor Health checks.

- [ ] **Step 4: Prove teardown and report secrecy**

```bash
npm run dev-verify -- down
npm run dev-verify -- status
node --import tsx tools/dev-verification/cli.ts audit-reports
```

Expected: zero host processes, zero disposable compose services, rollout disabled, retained report secrecy PASS. Production `webtopup-mongo` remains untouched.

- [ ] **Step 5: Inspect final repository state**

```bash
git status --short --branch
git diff --check
git log --oneline -12
```

Expected: implementation is committed, no fixture secrets/generated verification state staged, only intentional plan progress may remain.

- [ ] **Step 6: Request independent read-only review**

Reviewer checklist:

- Digiflazz/Tokovoucher failures, non-2xx, malformed bodies, and timeouts cannot become numeric zero/healthy.
- All five probe callers use the new Result contract correctly.
- Core Mongo failure is `503`; auxiliary/persistence/provider failures are partial with exact stable issue codes.
- No raw error/provider body/credential/signature/secret URL escapes response, CSV, logs, or reports.
- Persisted snapshot remains notification-compatible.
- Realtime is the only authoritative vendor-card set; diagnostics is compact and visibly partial/stale.
- Global refresh loads both datasets with request guards; local refresh buttons are absent.
- Freshness boundary is exactly 120 seconds; zero transaction, unavailable balance, disabled and unknown states are correct.
- `manageVendors` and `exports.sensitive` boundaries remain unchanged at Node and Rust.
- Integration/browser checks use only `webtopup_task14_dev` and no external providers.
- No legacy Node vendor route was registered; no production action occurred.

Any valid finding receives a focused RED/GREEN regression test, a separate checkpoint commit, and rerun of affected checks.

- [ ] **Step 7: Mark plan complete and present release handoff**

Report:

- changed files and checkpoint commits;
- focused Rust/client/gateway/build evidence and rustfmt limitation;
- aggregate run ID/result/count and teardown proof;
- reviewer findings/resolution;
- residual risks: no auto-refresh, legacy Node vendor files retained, provider calls still occur only on explicit refresh/export;
- production unchanged;
- explicit later approval choices for GitHub push and production backup/build/restart/smoke.

Do not push or deploy in this task.
