# Digiflazz Seller Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one private Digiflazz Seller Center admin experience, make IRS an internal Digiflazz integration that fulfills each mapped order at most once, and eliminate seller credential/raw-payload retention without changing either public prepaid API contract.

**Architecture:** Keep Digiflazz and IRS public protocols and order collections isolated, but compose their private administration through one canonical Seller Center shell and one fail-closed summary endpoint. Establish secrecy and index readiness first, then modularize and harden IRS, add durable execution claims around the existing supplier path, and finally replace duplicate navigation/UI with a typed, globally refreshed Seller Center verified against the exact disposable database.

**Tech Stack:** Rust/Axum/MongoDB/Reqwest, Node/Fastify TypeScript gateway, React 19/TypeScript/Tailwind, Node test runner with `tsx`, Playwright, MongoDB Node driver, existing disposable `webtopup_task14_dev` stack.

**Spec:** `docs/superpowers/specs/2026-08-20-digiflazz-seller-center-design.md`

## Global Constraints

- Work in `/home/danayasa/proyek/webtopup`; use one sequential writer per working tree.
- Use strict RED/GREEN TDD. Every behavior task begins with a focused failing test, then the minimum implementation, focused GREEN evidence, `git diff --check`, and a checkpoint commit.
- Do not install or add dependencies.
- Digiflazz Seller Center is private to Digiflazz selling operations; do not build a generic seller/provider plugin framework.
- Canonical admin path is exactly `/admin/addons/digiflazz-seller-center`.
- Preserve exact public paths and response field contracts for `POST /api/v2/digiflazz-seller/prepaid` and `POST /api/v2/irs-seller/prepaid`; do not add a public Seller Center alias.
- Preserve public access to both prepaid endpoints. Preserve `authenticate + manageVendors` for private Seller Center reads and exact `authenticate + manageVendors + requireStepUp('integrations.credentials')` for both settings mutations.
- Do not widen existing `viewTransactions` order-read boundaries. Seller Center must render an explicit unavailable/permission state when a user can manage vendors but cannot read a protected order list.
- Never persist, return, log, export, or retain Digiflazz `sign`/API key; IRS `password`/`pass`, `pin`, `secret`, `sign`, credential aliases; raw request bodies; auth/session/step-up tokens; cookies; Mongo/Reqwest errors; or connection strings.
- New seller order writes contain no `rawRequest`; new seller log writes contain no `raw`. Admin APIs use typed allowlist DTOs and never serialize Mongo documents directly.
- IRS uses the shared `digiflazzsellerproductmaps` inventory. IRS mapping mutation endpoints remain rejection-only; no second mapping model is introduced.
- IRS fulfillment must durably claim one execution per `refId` before any validation or supplier call. A duplicate/concurrent request must never invoke fulfillment a second time.
- Exact unique `{ refId: 1 }` indexes are required on `digiflazzsellerorders` and `irssellerorders`. API startup verifies readiness but never creates or drops these indexes.
- Historical hygiene defaults to dry-run. Automatic `--apply` is allowed only for exact database `webtopup_task14_dev`; any protected database requires exact confirmation, protected-database opt-in, and a non-empty backup reference.
- Tests use exact database `webtopup_task14_dev` and `PROVIDER_MODE=mock`. They must not call real Digiflazz, IRS, validation, or supplier endpoints.
- The AdminLayout `admin:refresh-current-page` event is the only pure refresh affordance. Mapping sync, callback retry, and save remain valid mutations. Do not add polling.
- Keep `stepUp.dialog` mounted and preserve focus/keyboard behavior.
- Do not register or revive `server/src/routes/digiflazzSellerRoutes.ts` or `server/src/controllers/digiflazzSellerController.ts`. Live seller traffic stays on the Node gateway → Rust path. Do not modify those leftover Node files except to keep them unregistered.
- No production scrub, unique-index apply, backup, provider call, deployment, service restart, or GitHub push without later explicit approval.
- `cargo fmt --check` remains unavailable until `rustfmt` is installed. Run focused/full Rust tests, `cargo check`, client/server builds, unit/integration/browser checks, `git diff --check`, and record that limitation honestly.

## Stable Seller Center Issue Codes

Use these exact machine codes in Rust, client parsers, tests, and diagnostics:

- `SELLER_CONFIG_UNAVAILABLE`
- `IRS_CONFIG_UNAVAILABLE`
- `SELLER_MAPPING_SUMMARY_UNAVAILABLE`
- `SELLER_ORDER_SUMMARY_UNAVAILABLE`
- `IRS_ORDER_SUMMARY_UNAVAILABLE`
- `SELLER_ORDER_INDEXES_NOT_READY`
- `IRS_ORDER_STORAGE_UNAVAILABLE`
- `MALFORMED_SELLER_CENTER_RESPONSE` (client-only)

Issue objects serialize as `{ "code": string, "source": string }`. Allowed sources are `mongodb.settings.digiflazzSeller`, `mongodb.settings.irsSeller`, `mongodb.digiflazzSellerMappings`, `mongodb.digiflazzSellerOrders`, `mongodb.irsSellerOrders`, `mongodb.indexes`, and `client.parser`.

## File Structure

- Create `rust-api/src/services/seller_secrecy.rs`: safe seller event builder and sensitive-key policy tests.
- Modify `rust-api/src/services/mod.rs`: export `seller_secrecy` and later `seller_integrity`.
- Modify `rust-api/src/routes/digiflazz_seller/prepaid.rs`, `callbacks.rs`, `settings.rs`, `types.rs`, and `rust-api/src/routes/digiflazz_seller.rs`: stop raw persistence/serialization, replace API-key masks with a configured boolean, and consume safe DTOs.
- Modify `server/src/models/DigiflazzSellerOrder.ts`: remove `rawRequest` from the active model contract while leaving historical fields for the scrubber.
- Create `scripts/security/seller-secret-policy.js` and `.test.js`: pure historical-field/index policy.
- Create `scripts/security/scrub-seller-secrets.js` and `.test.js`: dry-run/apply CLI with protected-database guards.
- Create `docs/ops/digiflazz-seller-center-hygiene.md`: exact dry-run, backup, apply, verify, rollback/stop instructions.
- Create `rust-api/src/services/seller_integrity.rs`: exact index requirements and readiness verification used by startup/tests.
- Modify `rust-api/src/main.rs`, `rust-api/Cargo.toml`, `package.json`, `tools/dev-verification/processes.ts`, and process tests: register/run the guarded readiness tool before disposable hosts and verify-only at API startup.
- Replace `rust-api/src/routes/irs_seller.rs` with focused module files under `rust-api/src/routes/irs_seller/`: `mod.rs`, `types.rs`, `settings.rs`, `admin.rs`, and `prepaid.rs`.
- Create `rust-api/src/routes/digiflazz_seller/center.rs` and extend `types.rs`: typed private summary contract.
- Modify `rust-api/src/routes/mod.rs`: register summary and unchanged public channel routes.
- Modify `server/src/routes/apiV2ProxyRoutes.ts` and `.test.ts`: pin public/private/step-up boundaries.
- Create `client/src/lib/digiflazzSellerCenter.ts` and `.test.ts`: canonical sections, redirect destinations, parsers, and labels.
- Modify `client/src/lib/adminNav.ts` and `.test.ts`: one canonical submenu identity while preserving top-level preference normalization.
- Create `client/src/pages/admin/DigiflazzSellerCenter.tsx`: canonical shell, section URL orchestration, summary, global refresh.
- Create `client/src/pages/admin/DigiflazzSellerChannel.tsx`: existing Digiflazz settings/mapping/order-callback UI split by section.
- Create `client/src/pages/admin/IrsSellerIntegration.tsx`: typed IRS settings/order/log UI.
- Remove `client/src/pages/admin/DigiflazzSellerSettings.tsx` and `IrsSellerSettings.tsx` after their behavior is moved.
- Modify `client/src/pages/admin/AddOns.tsx`, `AdminRoutes.tsx`, `client/src/App.tsx`, and `client/src/layouts/AdminLayout.tsx`: one card/menu/header and redirect-only legacy routes.
- Modify `tools/dev-verification/seed.ts`, unit tests, and verification fixtures for Seller Center manager/denied roles.
- Create `tools/dev-verification/integration/sellerCenter.test.ts` and `tools/dev-verification/e2e/seller-center.spec.ts`.
- Modify `tools/dev-verification/verificationMatrix.ts` and tests: require integration and desktop/mobile checks.

---

### Task 1: Remove Raw Seller Payloads from New Writes and Admin DTOs

**Files:**
- Create: `rust-api/src/services/seller_secrecy.rs`
- Modify: `rust-api/src/services/mod.rs`
- Modify: `rust-api/src/routes/digiflazz_seller/prepaid.rs`
- Modify: `rust-api/src/routes/digiflazz_seller/callbacks.rs`
- Modify: `rust-api/src/routes/digiflazz_seller/settings.rs`
- Modify: `rust-api/src/routes/digiflazz_seller/types.rs`
- Modify: `rust-api/src/routes/digiflazz_seller.rs`
- Modify: `server/src/models/DigiflazzSellerOrder.ts`
- Test: inline Rust tests in `seller_secrecy.rs` and `digiflazz_seller.rs`

**Interfaces:**
- Produces: `safe_seller_event_document(provider: &str, event: &str, ref_id: &str, status: &str, message: &str, verified: bool, request_ip: &str) -> Document`.
- Produces: `contains_sensitive_seller_key(value: &serde_json::Value) -> bool` for tests/hygiene verification only.
- Produces: `SellerAdminOrderItem` without `rawRequest` and `SellerLogItem` without `raw`.
- Produces: Digiflazz settings responses with `apiKeyConfigured: boolean` and no `apiKeyMasked`/credential fragment.
- Consumes: existing Digiflazz public payload/response behavior; no public field changes.

- [ ] **Step 1: Add RED tests proving raw fields/signatures are currently retained or serialized**

In `seller_secrecy.rs`, define tests first:

```rust
#[test]
fn safe_event_contains_only_allowlisted_operational_fields() {
    let event = safe_seller_event_document(
        "digiflazz_seller", "request", "ref-1", "failed",
        "Wrong authentication", false, "127.0.0.1",
    );
    assert_eq!(
        event.keys().cloned().collect::<std::collections::BTreeSet<_>>(),
        ["provider", "event", "refId", "status", "message", "verified", "requestIp", "createdAt", "updatedAt"]
            .into_iter().map(str::to_string).collect(),
    );
    assert!(!event.contains_key("raw"));
    assert!(!event.contains_key("rawRequest"));
}

#[test]
fn nested_seller_secret_aliases_are_detected_case_insensitively() {
    let value = serde_json::json!({"data":{"PASS":"fixture", "pin":"fixture"}});
    assert!(contains_sensitive_seller_key(&value));
    assert!(!contains_sensitive_seller_key(&serde_json::json!({"refId":"safe", "target":"0812"})));
}
```

Add source/serialization tests in `digiflazz_seller.rs` proving `SellerAdminOrderItem` JSON has no `rawRequest`, production text before `#[cfg(test)]` has no order insertion of `"rawRequest"`, and both settings response types serialize `apiKeyConfigured` without `apiKeyMasked` or any API-key fragment.

- [ ] **Step 2: Run focused Rust tests to verify RED**

```bash
cd rust-api
cargo test services::seller_secrecy::tests routes::digiflazz_seller::tests -- --nocapture
```

If Cargo rejects two filters, run each filter separately. Expected: FAIL because the service/functions do not exist and the admin DTO still exposes `rawRequest`.

- [ ] **Step 3: Implement the safe event builder and recursive key detector**

Use a closed sensitive-key set:

```rust
const SENSITIVE_SELLER_KEYS: &[&str] = &[
    "apikey", "api_key", "sign", "signature", "secret", "password", "pass",
    "pin", "authorization", "cookie", "x-step-up-token", "granttoken",
];
```

`contains_sensitive_seller_key` recursively visits JSON objects/arrays and normalizes keys with `trim().to_ascii_lowercase()`. `safe_seller_event_document` inserts only the exact fields asserted in Step 1 and bounds `message`/`requestIp` using existing safe lengths.

- [ ] **Step 4: Stop Digiflazz raw persistence and serialization**

Apply the minimum production changes:

- remove `rawRequest` from new `digiflazzsellerorders` documents;
- change `log_seller_request` and callback logging to call `safe_seller_event_document` and remove their `raw` argument;
- remove `raw_request` from `SellerAdminOrderItem` and its mapper;
- remove `rawRequest` from the active Mongoose interface/schema;
- replace `apiKeyMasked` with `apiKeyConfigured: bool` in Digiflazz settings/read-save DTOs and UI contracts; do not return any API-key fragment;
- keep public Digiflazz response builders byte/field compatible;
- do not delete historical fields in this task.

- [ ] **Step 5: Verify GREEN and public response compatibility**

```bash
cd rust-api
cargo test services::seller_secrecy::tests -- --nocapture
cargo test routes::digiflazz_seller::tests -- --nocapture
cargo check
cd ..
node --import tsx --test server/src/routes/apiV2ProxyRoutes.test.ts
git diff --check
```

Expected: focused tests and compile pass; source and DTO output contain no new raw seller persistence.

- [ ] **Step 6: Commit the secrecy checkpoint**

```bash
git add rust-api/src/services/seller_secrecy.rs rust-api/src/services/mod.rs \
  rust-api/src/routes/digiflazz_seller.rs rust-api/src/routes/digiflazz_seller/prepaid.rs \
  rust-api/src/routes/digiflazz_seller/callbacks.rs rust-api/src/routes/digiflazz_seller/settings.rs \
  rust-api/src/routes/digiflazz_seller/types.rs server/src/models/DigiflazzSellerOrder.ts
git commit -m "fix: stop retaining raw seller credentials"
```

---

### Task 2: Add Dry-run Seller Hygiene and Exact Index Readiness

**Files:**
- Create: `scripts/security/seller-secret-policy.js`
- Create: `scripts/security/seller-secret-policy.test.js`
- Create: `scripts/security/scrub-seller-secrets.js`
- Create: `scripts/security/scrub-seller-secrets.test.js`
- Create: `rust-api/src/services/seller_integrity.rs`
- Create: `rust-api/src/bin/seller_order_readiness.rs`
- Create: `docs/ops/digiflazz-seller-center-hygiene.md`
- Modify: `rust-api/src/services/mod.rs`
- Modify: `rust-api/Cargo.toml`
- Modify: `rust-api/src/main.rs`
- Modify: `package.json`
- Modify: `tools/dev-verification/processes.ts`
- Modify: `tools/dev-verification/unit/processes.test.ts`
- Modify: `tools/dev-verification/unit/rustStartupIndexes.test.ts`

**Interfaces:**
- Produces JS: `parseSellerScrubArgs(argv)`, `inspectSellerHygiene(db)`, `applySellerHygiene(db, report)`.
- Produces CLI flags: `--mongo-uri`, `--database`, `--apply`, `--allow-protected-database`, `--confirm-database`, `--backup-reference`.
- Produces Rust: `seller_order_index_requirements() -> [SellerOrderIndexRequirement; 2]` and `ensure_seller_order_indexes_ready(db: &Database) -> Result<(), SellerIntegrityError>`.
- Produces executable: `rust-api/target/debug/seller_order_readiness`, dry-run by default and `--apply` only for exact disposable DB.
- Consumes: Task 1 secrecy policy; exact collections `digiflazzsellerorders`, `irssellerorders`, and provider-filtered `webhookeventlogs`.

- [ ] **Step 1: Add RED CLI guard and policy tests**

Test the exact guard:

```js
test('seller scrub apply is disposable-only unless protected confirmation is complete', () => {
  assert.equal(parseSellerScrubArgs(['--mongo-uri','mongodb://fixture','--database','webtopup_task14_dev','--apply']).apply, true);
  assert.throws(() => parseSellerScrubArgs([
    '--mongo-uri','mongodb://fixture','--database','webtopup','--apply',
  ]), { code: 'SELLER_SCRUB_PROTECTED' });
  assert.equal(parseSellerScrubArgs([
    '--mongo-uri','mongodb://fixture','--database','webtopup','--apply',
    '--allow-protected-database','--confirm-database','webtopup',
    '--backup-reference','backup-2026-08-20',
  ]).database, 'webtopup');
});
```

Test that the policy targets only:

```js
[
  ['digiflazzsellerorders', { rawRequest: { $exists: true } }, { $unset: { rawRequest: '' } }],
  ['irssellerorders', { rawRequest: { $exists: true } }, { $unset: { rawRequest: '' } }],
  ['webhookeventlogs', { provider: { $in: ['digiflazz_seller','irs_seller'] }, raw: { $exists: true } }, { $unset: { raw: '' } }],
]
```

- [ ] **Step 2: Run JS tests to verify RED**

```bash
node --test scripts/security/seller-secret-policy.test.js scripts/security/scrub-seller-secrets.test.js
```

Expected: FAIL because the files/exports do not exist.

- [ ] **Step 3: Implement dry-run/apply with secrecy-safe reporting**

`inspectSellerHygiene` must return counts only:

```js
{
  database,
  collections: {
    digiflazzsellerorders: { scanned, affected, duplicateRefIds, uniqueIndexReady },
    irssellerorders: { scanned, affected, duplicateRefIds, uniqueIndexReady },
    webhookeventlogs: { scanned, affected },
  },
  applied: false,
  modifiedDocuments: 0,
  blocking: boolean,
}
```

Implementation requirements:

- never project or print raw values;
- find duplicate `refId` groups with `$group`/`$match` but return count only;
- semantically accept an existing exact `{refId:1, unique:true}` index regardless of name;
- mark a same-key non-unique/TTL/partial index as drifted and blocking;
- on apply, use `updateMany(filter, {$unset: ...})` for raw fields only; the Node scrubber never creates, drops, or changes indexes;
- run `inspectSellerHygiene` again and exit nonzero if any affected raw fields remain;
- report duplicate/index readiness as blocking guidance for the separate Rust readiness binary.

Add package script:

```json
"seller-center:hygiene": "node scripts/security/scrub-seller-secrets.js"
```

- [ ] **Step 4: Add RED Rust index readiness tests**

```rust
#[test]
fn seller_ref_indexes_are_exact_unique_and_non_ttl() {
    let requirements = seller_order_index_requirements();
    assert_eq!(requirements.map(|item| item.collection), ["digiflazzsellerorders", "irssellerorders"]);
    for requirement in requirements {
        assert_eq!(requirement.keys, doc! { "refId": 1 });
        assert!(requirement.unique);
    }
}

#[test]
fn apply_is_allowed_only_for_exact_disposable_database() {
    assert!(seller_apply_allowed("webtopup_task14_dev"));
    for name in ["webtopup", "POBB", "webtopup_task14_dev_backup", "admin", ""] {
        assert!(!seller_apply_allowed(name));
    }
}
```

- [ ] **Step 5: Run Rust tests to verify RED, then implement verifier/binary**

```bash
cd rust-api
cargo test services::seller_integrity::tests -- --nocapture
```

Expected RED. Then implement semantic index inspection using Mongo `list_indexes()`. `ensure_seller_order_indexes_ready` is verification-only. The CLI `--apply` may create only missing exact indexes and only for `webtopup_task14_dev`; it refuses duplicates and drift.

At API startup add only:

```rust
services::seller_integrity::ensure_seller_order_indexes_ready(&db)
    .await
    .context("seller order indexes failed before listener readiness")?;
```

Do not call any index creation function from `main.rs`.

- [ ] **Step 6: Wire disposable readiness before host startup**

Add `makeSellerOrderReadinessApplyPlan()` beside existing readiness plans in `tools/dev-verification/processes.ts`. It must execute only the debug binary at `rust-api/target/debug/seller_order_readiness` with `--apply`, require `MONGO_DB === 'webtopup_task14_dev'`, and redact Mongo URI from errors/logs. Call it after disposable Mongo bootstrap and before the Rust host process.

Add unit assertions proving protected DBs and unexpected executable paths are rejected.

- [ ] **Step 7: Write the operational runbook**

Document exact commands without real credentials:

```bash
npm run seller-center:hygiene -- --mongo-uri "$MONGO_URI" --database "$MONGO_DB"
# production apply only after backup + approval:
npm run seller-center:hygiene -- --mongo-uri "$MONGO_URI" --database "$MONGO_DB" \
  --apply --allow-protected-database --confirm-database "$MONGO_DB" \
  --backup-reference "$BACKUP_REFERENCE"
```

The runbook must say: stop on duplicates/drift, do not deploy code that requires readiness before indexes pass, never paste report values containing credentials, and re-run dry-run after apply.

- [ ] **Step 8: Verify GREEN and commit**

```bash
node --test scripts/security/seller-secret-policy.test.js scripts/security/scrub-seller-secrets.test.js
cd rust-api
cargo test services::seller_integrity::tests -- --nocapture
cargo test --bin seller_order_readiness -- --nocapture
cargo check
cd ..
node --import tsx --test tools/dev-verification/unit/processes.test.ts tools/dev-verification/unit/rustStartupIndexes.test.ts
git diff --check
git add scripts/security/seller-secret-policy.js scripts/security/seller-secret-policy.test.js \
  scripts/security/scrub-seller-secrets.js scripts/security/scrub-seller-secrets.test.js \
  rust-api/src/services/seller_integrity.rs rust-api/src/services/mod.rs \
  rust-api/src/bin/seller_order_readiness.rs rust-api/Cargo.toml rust-api/src/main.rs \
  package.json tools/dev-verification/processes.ts tools/dev-verification/unit/processes.test.ts \
  tools/dev-verification/unit/rustStartupIndexes.test.ts docs/ops/digiflazz-seller-center-hygiene.md
git commit -m "feat: add guarded seller data hygiene"
```

---

### Task 3: Modularize and Harden IRS Settings and Admin Reads

**Files:**
- Remove: `rust-api/src/routes/irs_seller.rs`
- Create: `rust-api/src/routes/irs_seller/mod.rs`
- Create: `rust-api/src/routes/irs_seller/types.rs`
- Create: `rust-api/src/routes/irs_seller/settings.rs`
- Create: `rust-api/src/routes/irs_seller/admin.rs`
- Create: `rust-api/src/routes/irs_seller/prepaid.rs` (move current public flow here before Task 4 changes)
- Test: inline tests in `types.rs`, `settings.rs`, and `admin.rs`

**Interfaces:**
- Produces: typed `IrsSettingsResponse`, `SaveIrsSettingsPayload`, `IrsAdminOrdersResponse`, `IrsAdminOrderItem`, and `IrsLogItem`.
- Produces: `stored_config(db) -> mongodb::error::Result<Option<Document>>`.
- Produces: `validated_irs_formatter(value: Option<&Value>) -> Result<Option<Document>, &'static str>` accepting only bounded `sn.start`/`sn.end` strings (each <= 80 bytes).
- Produces: `constant_time_required_match(payload, config, aliases, config_key) -> bool`.
- Consumes: Task 1 safe event builder; current public route exports from `irs_seller` remain unchanged.

- [ ] **Step 1: Add RED settings secrecy and validation tests**

```rust
#[test]
fn settings_response_exposes_configured_flags_not_secret_fragments() {
    let response = settings_response_fixture("merchant", "password-fixture", "1234", "secret-fixture");
    let json = serde_json::to_value(response).unwrap();
    let text = json.to_string();
    assert_eq!(json["merchantId"], "merchant");
    assert_eq!(json["passwordConfigured"], true);
    assert_eq!(json["pinConfigured"], true);
    assert_eq!(json["secretConfigured"], true);
    for key in ["passwordMasked", "pinMasked", "secretMasked"] { assert!(json.get(key).is_none()); }
    for secret in ["password-fixture", "1234", "secret-fixture"] { assert!(!text.contains(secret)); }
}

#[test]
fn formatter_accepts_only_bounded_sn_markers() {
    assert!(validated_irs_formatter(Some(&serde_json::json!({"sn":{"start":"SN:","end":"Saldo"}}))).is_ok());
    assert!(validated_irs_formatter(Some(&serde_json::json!({"password":"alias"}))).is_err());
    assert!(validated_irs_formatter(Some(&serde_json::json!({"sn":{"start":"x".repeat(81)}}))).is_err());
}
```

Add a DTO test that feeds a Mongo document containing `rawRequest`, `password`, and `unknownField` through the mapper and asserts none serialize.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
cd rust-api
cargo test routes::irs_seller:: -- --nocapture
```

Expected: FAIL because the module/types do not yet exist.

- [ ] **Step 3: Split the module without changing public routes**

`mod.rs` re-exports exactly:

```rust
pub use admin::{admin_orders, logs, mappings, save_mapping, delete_mapping};
pub use prepaid::prepaid;
pub use settings::{settings, save_settings};
```

Move existing helpers into the file that owns them. Keep `/v2/irs-seller/*` registration unchanged. Compile before reliability changes to ensure the split itself is behavior-neutral.

- [ ] **Step 4: Implement typed settings with write-only secrets**

Rules:

- `stored_config` returns `Result<Option<Document>>`; Mongo error returns generic `500/503`, absent config returns defaults;
- response includes `merchantId`, `passwordConfigured`, `pinConfigured`, and `secretConfigured`, but never masks, fragments, or raw values;
- omitted/blank secret fields preserve current secrets;
- new nonblank secrets replace current values only behind trusted `integrations.credentials` step-up;
- formatter is the strict bounded shape from Step 1;
- credential comparison uses `subtle::ConstantTimeEq` after exact byte-length check;
- `unavailable()` must not mention `MONGO_URI`.

- [ ] **Step 5: Implement fail-closed typed admin reads**

- mapping/order/log cursor/query failure returns a generic storage error, not `[]`;
- mapping response remains read-only and uses the shared mapping collection;
- `IrsAdminOrderItem` includes only `id`, `refId`, `internalRefId`, `irsCode`, `target`, `status`, `statusCode`, `message`, `sn`, `vendorTrxId`, `requestIp`, `createdAt`, `updatedAt`;
- `IrsLogItem` includes only `id`, `timestamp`, `event`, `refId`, `status`, `message`, `verified`, `requestIp`;
- no mapper calls a generic `document_json` function.

- [ ] **Step 6: Verify GREEN and commit**

```bash
cd rust-api
cargo test routes::irs_seller:: -- --nocapture
cargo check
cd ..
git diff --check
git add rust-api/src/routes/irs_seller.rs rust-api/src/routes/irs_seller/
git commit -m "fix: harden irs seller admin contracts"
```

---

### Task 4: Execute IRS Fulfillment Once per Durable `refId`

**Files:**
- Modify: `rust-api/src/routes/irs_seller/prepaid.rs`
- Modify: `rust-api/src/routes/irs_seller/types.rs`
- Test: inline tests in `prepaid.rs`
- Test: later live concurrency proof in `tools/dev-verification/integration/sellerCenter.test.ts`

**Interfaces:**
- Produces: persisted execution states `ready | executing | completed` and `executionStartedAt`/`executionCompletedAt` timestamps.
- Produces: `claim_irs_execution(db, order_id) -> mongodb::error::Result<bool>` using one conditional `find_one_and_update` from `ready` to `executing`.
- Produces: `irs_response_from_order(order: &Document) -> Response` preserving exact `data.ref_id`, `produk`, `tujuan`, `statuscode`, `sn`, `msg` fields.
- Consumes: Task 2 exact unique index startup gate, Task 3 typed config, existing `top_up_vendor`, `run_paid_validation`, and `RecheckProduct`.

- [ ] **Step 1: Add RED pure/source tests for exact response fields and durable ordering**

```rust
#[test]
fn irs_response_contract_fields_remain_exact() {
    let value = irs_response_value("ref-1", "sku-1", "0812", "1", "SN1", "BERHASIL");
    let keys = value["data"].as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys, ["ref_id","produk","tujuan","statuscode","sn","msg"].into_iter().map(str::to_string).collect());
}

#[test]
fn supplier_call_is_after_durable_execution_claim() {
    let source = include_str!("prepaid.rs");
    let production = source.split("\n#[cfg(test)]").next().unwrap();
    let claim = production.find("claim_irs_execution(").unwrap();
    let supplier = production.find("top_up_vendor(").unwrap();
    assert!(claim < supplier);
    assert_eq!(production.matches("top_up_vendor(").count(), 1);
}
```

Add a test for status mapping: `success -> 1`, `failed -> 2`, `pending/executing -> 3`.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
cd rust-api
cargo test routes::irs_seller::prepaid::tests -- --nocapture
```

Expected: FAIL because the claim/state helpers do not exist and current IRS flow does not call fulfillment.

- [ ] **Step 3: Implement storage failures and idempotent creation**

The request flow must match each Mongo operation separately:

1. config query error → generic IRS failure envelope;
2. existing-order query error → generic failure;
3. existing order in `executing` or `completed` → return persisted outcome immediately;
4. existing order in `ready` → continue to the atomic execution claim so a request can recover an inserted-but-not-yet-claimed order;
5. mapping/product query error → generic failure, while genuine absence → `Produk tidak ditemukan`;
6. absent order → insert one pending order with one stable internal supplier reference and `executionState:"ready"`;
7. duplicate-key insert → load the winner; if it is `ready`, compete for the same atomic claim, otherwise return it; other insert errors → generic failure.

Remove `parse_irs_status` as an authority over the new order outcome. Incoming request status text must never manufacture success.

- [ ] **Step 4: Implement the one-way execution claim**

Use the exact filter/update:

```rust
let claimed = orders.find_one_and_update(
    doc! { "_id": order_id, "executionState": "ready" },
    doc! { "$set": { "executionState": "executing", "executionStartedAt": DateTime::now(), "updatedAt": DateTime::now() } },
).return_document(ReturnDocument::After).await?;
Ok(claimed.is_some())
```

Only the request that receives `true` may call validation/provider. If `false`, reload and return the persisted pending/completed outcome. Never reset `executing` to `ready` automatically.

- [ ] **Step 5: Execute validation or supplier and persist the real result**

- for validation products, call `run_paid_validation` and map existing statuses;
- otherwise build `RecheckProduct` from the mapped product vendor and call `top_up_vendor(&state, &internal_ref_id, &target, "", &product)` exactly once;
- update order status, `statusCode`, `message`, `sn`, `vendorTrxId`, `executionState:"completed"`, and `executionCompletedAt`;
- if the supplier returns transport/provider failure, persist failed/pending according to the existing supplier result contract;
- if final Mongo update fails after execution, return a pending/generic IRS envelope and leave the durable `executing` marker; do not retry automatically;
- write only safe event metadata through Task 1's builder.

- [ ] **Step 6: Verify GREEN including full Rust suite**

```bash
cd rust-api
cargo test routes::irs_seller::prepaid::tests -- --nocapture
cargo test routes::digiflazz_seller:: -- --nocapture
cargo test
cargo check
cd ..
git diff --check
```

Expected: IRS tests, existing Digiflazz tests, and full Rust suite PASS with no real provider calls.

- [ ] **Step 7: Commit the fulfillment checkpoint**

```bash
git add rust-api/src/routes/irs_seller/prepaid.rs rust-api/src/routes/irs_seller/types.rs
git commit -m "feat: fulfill irs seller orders once"
```

---

### Task 5: Add Fail-closed Seller Center Summary and Pin Gateway Boundaries

**Files:**
- Create: `rust-api/src/routes/digiflazz_seller/center.rs`
- Modify: `rust-api/src/routes/digiflazz_seller.rs`
- Modify: `rust-api/src/routes/digiflazz_seller/types.rs`
- Modify: `rust-api/src/routes/mod.rs`
- Modify: `server/src/routes/apiV2ProxyRoutes.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`
- Test: inline Rust tests in `center.rs`

**Interfaces:**
- Produces: `GET /v2/digiflazz-seller/center-summary` typed `SellerCenterSummaryResponse`.
- Produces: `SellerCenterIssue { code: &'static str, source: &'static str }`.
- Produces statuses `ready | disabled | needs_setup | attention | unavailable`.
- Consumes: Task 3 IRS config reader and existing Digiflazz settings/order/mapping collections.

- [ ] **Step 1: Add RED Rust summary classification tests**

```rust
#[test]
fn disabled_irs_is_neutral_while_failed_sources_are_unavailable() {
    assert_eq!(irs_center_status(false, true, 4, true), "disabled");
    assert_eq!(irs_center_status(true, true, 4, true), "ready");
    assert_eq!(irs_center_status(true, false, 4, true), "needs_setup");
    assert_eq!(irs_center_status(true, true, 0, true), "attention");
    assert_eq!(irs_center_status(true, true, 4, false), "unavailable");
}

#[test]
fn summary_issue_codes_are_stable_and_non_secret() {
    let issue = SellerCenterIssue::new("IRS_ORDER_SUMMARY_UNAVAILABLE", "mongodb.irsSellerOrders");
    assert_eq!(serde_json::to_value(issue).unwrap(), serde_json::json!({
        "code":"IRS_ORDER_SUMMARY_UNAVAILABLE", "source":"mongodb.irsSellerOrders"
    }));
}
```

- [ ] **Step 2: Add RED gateway ordering/boundary tests**

Assert exact routes:

```ts
assert.match(source, /app\.get\('\/digiflazz-seller\/center-summary', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\)\] \}/);
assert.match(source, /app\.post\('\/digiflazz-seller\/settings', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('integrations\.credentials'\)\] \}/);
assert.match(source, /app\.post\('\/irs-seller\/settings', \{ preHandler: \[authenticate, hasPermission\('manageVendors'\), requireStepUp\('integrations\.credentials'\)\] \}/);
```

Also prove both prepaid `app.post` routes have no `authenticate` block and occur before their protected `app.all('/.../*')` catch-alls.

Add an app-source contract that leftover Node seller routes stay unregistered:

```ts
const appSource = readFileSync(join(__dirname, '..', '..', 'src', 'app.ts'), 'utf8');
assert.doesNotMatch(appSource, /digiflazzSellerRoutes/);
assert.doesNotMatch(appSource, /irsSellerRoutes/);
```

- [ ] **Step 3: Run RED tests**

```bash
cd rust-api
cargo test routes::digiflazz_seller::center::tests -- --nocapture
cd ..
node --import tsx --test server/src/routes/apiV2ProxyRoutes.test.ts
```

Expected: FAIL because the summary route is absent.

- [ ] **Step 4: Implement typed fail-closed summary assembly**

- missing Mongo client → structured `503`, `ok:false`, issue `SELLER_CONFIG_UNAVAILABLE`;
- query Digiflazz config, IRS config, mappings, Digiflazz order summary, and IRS order summary separately;
- auxiliary failure adds its stable issue, sets `partial:true`, and affected status `unavailable`;
- absent config is a valid `needs_setup`, not a query failure;
- summary fields contain counts/status only—no usernames, merchant IDs, configured-secret indicators, targets, IPs, messages, SNs, or raw documents;
- corrected Digiflazz `callbackPending` counts only required, undelivered callbacks;
- serialize `generatedAt` as RFC3339.

- [ ] **Step 5: Register exact Node/Rust routes**

Place the explicit Node `GET /digiflazz-seller/center-summary` before `app.all('/digiflazz-seller/*')`. Preserve the public and settings routes exactly. Rust still calls `require_proxy_context`; no client-created permission/action headers are accepted.

- [ ] **Step 6: Verify GREEN and commit**

```bash
cd rust-api
cargo test routes::digiflazz_seller::center::tests -- --nocapture
cargo check
cd ..
node --import tsx --test server/src/routes/apiV2ProxyRoutes.test.ts
npm --prefix server run build
git diff --check
git add rust-api/src/routes/digiflazz_seller/center.rs rust-api/src/routes/digiflazz_seller.rs \
  rust-api/src/routes/digiflazz_seller/types.rs rust-api/src/routes/mod.rs \
  server/src/routes/apiV2ProxyRoutes.ts server/src/routes/apiV2ProxyRoutes.test.ts
git commit -m "feat: expose private seller center summary"
```

---

### Task 6: Define Canonical Client Contracts and Navigation

**Files:**
- Create: `client/src/lib/digiflazzSellerCenter.ts`
- Create: `client/src/lib/digiflazzSellerCenter.test.ts`
- Modify: `client/src/lib/adminNav.ts`
- Modify: `client/src/lib/adminNav.test.ts`
- Modify: `client/src/pages/admin/AdminRoutes.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/layouts/AdminLayout.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `SellerCenterSection = 'overview' | 'settings' | 'mappings' | 'orders' | 'irs'`.
- Produces: `parseSellerCenterSection(value: unknown) -> SellerCenterSection`.
- Produces: `legacySellerCenterDestination(pathname: string) -> string`.
- Produces: `parseSellerCenterSummary(value: unknown) -> SellerCenterSummary` with fail-closed statuses/issues.
- Produces canonical nav identity `Digiflazz Seller Center` at `/admin/addons/digiflazz-seller-center`.
- Keeps persisted sidebar order/pin preferences top-level only; no submenu-name alias migration is introduced.

- [ ] **Step 1: Add RED pure parser and redirect tests**

```ts
test('seller center sections and legacy routes fail closed to canonical destinations', () => {
  assert.equal(parseSellerCenterSection('irs'), 'irs');
  assert.equal(parseSellerCenterSection('unknown'), 'overview');
  assert.equal(parseSellerCenterSection(['irs']), 'overview');
  assert.equal(legacySellerCenterDestination('/admin/addons/digiflazz-seller'), '/admin/addons/digiflazz-seller-center?section=overview');
  assert.equal(legacySellerCenterDestination('/admin/addons/irs-seller'), '/admin/addons/digiflazz-seller-center?section=irs');
});

test('malformed summary never becomes ready', () => {
  const parsed = parseSellerCenterSummary({ ok: true, digiflazz: { status: 'ready' } });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.digiflazz.status, 'unavailable');
  assert.deepEqual(parsed.issues, [{ code: 'MALFORMED_SELLER_CENTER_RESPONSE', source: 'client.parser' }]);
});
```

- [ ] **Step 2: Add RED nav identity/migration tests**

Assert:

- exactly one submenu item named `Digiflazz Seller Center`;
- no `IRS Seller` sidebar item;
- no canonical sidebar destination at either legacy path;
- top-level menu order and pin normalization remain unchanged and do not attempt unsupported submenu migration;
- route permission for canonical and both redirect paths remains `manageVendors`.

- [ ] **Step 3: Run client tests to verify RED**

```bash
node --import tsx --test client/src/lib/digiflazzSellerCenter.test.ts client/src/lib/adminNav.test.ts
```

Expected: FAIL because the module/canonical identity do not exist.

- [ ] **Step 4: Implement pure contracts and canonical nav metadata**

The parser allowlists only stable statuses/issues, finite nonnegative counts, valid RFC3339 timestamp, and booleans. Any missing required branch produces the malformed issue and unavailable states; it never invents `ok:true`.

Update `ADMIN_NAV_BLUEPRINT`, route permissions, and presentation metadata. Keep `ADMIN_MENU_NAME_ALIASES` and the Add Ons parent identity unchanged because persisted preferences address top-level menus only.

Add the new pure test to `test:dev-verify:unit`.

- [ ] **Step 5: Add canonical route and redirect-only legacy routes**

Export `AdminDigiflazzSellerCenter`. In `App.tsx`:

```tsx
<Route path="addons/digiflazz-seller-center" element={
  <AdminGuarded path="/admin/addons/digiflazz-seller-center"><AdminDigiflazzSellerCenter /></AdminGuarded>
} />
<Route path="addons/digiflazz-seller" element={<Navigate replace to="/admin/addons/digiflazz-seller-center?section=overview" />} />
<Route path="addons/irs-seller" element={<Navigate replace to="/admin/addons/digiflazz-seller-center?section=irs" />} />
```

Do not render old page components on redirect routes.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --import tsx --test client/src/lib/digiflazzSellerCenter.test.ts client/src/lib/adminNav.test.ts tools/dev-verification/unit/adminPageChrome.test.ts
npm run test:dev-verify:unit
npm --prefix client run build
git diff --check
git add client/src/lib/digiflazzSellerCenter.ts client/src/lib/digiflazzSellerCenter.test.ts \
  client/src/lib/adminNav.ts client/src/lib/adminNav.test.ts client/src/pages/admin/AdminRoutes.tsx \
  client/src/App.tsx client/src/layouts/AdminLayout.tsx package.json
git commit -m "feat: define canonical digiflazz seller center navigation"
```

---

### Task 7: Build Seller Center Shell, IRS Integration UI, and One Add Ons Card

**Files:**
- Create: `client/src/pages/admin/DigiflazzSellerCenter.tsx`
- Create: `client/src/pages/admin/DigiflazzSellerChannel.tsx`
- Create: `client/src/pages/admin/IrsSellerIntegration.tsx`
- Modify: `client/src/pages/admin/AddOns.tsx`
- Modify: `client/src/pages/admin/AdminRoutes.tsx`
- Remove: `client/src/pages/admin/DigiflazzSellerSettings.tsx`
- Remove: `client/src/pages/admin/IrsSellerSettings.tsx`
- Modify: `tools/dev-verification/unit/adminPageChrome.test.ts`

**Interfaces:**
- Produces shell props to children: `{ section, refreshRevision, onMutationComplete }`.
- Consumes Task 5 `/digiflazz-seller/center-summary` and existing channel endpoints.
- Consumes Task 6 pure parser/section helpers.

- [ ] **Step 1: Add RED source-contract tests for shell hierarchy and refresh**

Assert the new shell contains:

```ts
for (const contract of [
  /admin:refresh-current-page/,
  /parseSellerCenterSection/,
  /parseSellerCenterSummary/,
  /latestSummaryRequestId/,
  /aria-busy/,
  /aria-label="Navigasi Digiflazz Seller Center"/,
  /role="status"/,
  /role="alert"/,
  /stepUp\.dialog/,
]) assert.match(shell, contract);
```

Assert old files are removed, neither child has a pure `Refresh` button, and the Add Ons source has exactly one `digiflazz-seller-center` card with both `Digiflazz API` and `Integrasi IRS` labels.

- [ ] **Step 2: Run source tests to verify RED**

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: FAIL because the shell/new files do not exist.

- [ ] **Step 3: Implement the canonical shell and overview**

- use `useSearchParams` and `parseSellerCenterSection`;
- update query with `replace:true` and preserve only allowlisted `section`;
- render named section navigation: Ringkasan, Konfigurasi Seller, Mapping Produk, Order & Callback, Integrasi IRS;
- load summary initially and on global refresh;
- increment `refreshRevision` for the active child on the same event;
- use request IDs so older summary/child responses cannot overwrite newer ones;
- overview renders separate compact Digiflazz/IRS status rows and shared mapping count;
- show stable issue codes only, never raw server errors.

- [ ] **Step 4: Move Digiflazz behavior into section-scoped child UI**

Preserve all existing mutations and step-up orchestration, but remove `activeChannel` and local pure refresh controls. Fetch only the active section:

- `settings` → settings only;
- `mappings` → mapping list/search/editor;
- `orders` → logs/orders/scheduler;
- `overview` summary stays in the shell.

Mapping sync and callback retry buttons remain explicit mutations and call `onMutationComplete()` after success so summary refreshes.

- [ ] **Step 5: Implement typed IRS integration UI**

- no `any` response/order/log types;
- secret inputs start blank/write-only and show only boolean configured readiness, never masked fragments or hydrated secret values;
- blank secret values preserve server values;
- show IRS enabled/configured/ready and shared mapping count;
- link Mapping Produk by updating canonical `section=mappings`;
- order/log queries show distinct loading, empty, permission-denied, storage-unavailable states;
- desktop table and mobile cards expose only allowlisted DTO fields;
- use global refresh revision, no local Refresh button;
- retain `integrations.credentials` step-up dialog and bounded formatter fields.

- [ ] **Step 6: Replace Add Ons cards/status loading**

Remove standalone IRS and old seller cards. Fetch the one center summary and map status rows fail-closed:

- rejected/malformed summary → both rows `Tidak tersedia`;
- IRS disabled → neutral `Nonaktif`;
- zero mappings with configured channel → `Perlu tindakan`;
- card settings link → canonical path only.

No source failure is represented as zero/ready.

- [ ] **Step 7: Verify focused UI/build tests and commit**

```bash
node --import tsx --test client/src/lib/digiflazzSellerCenter.test.ts client/src/lib/adminNav.test.ts tools/dev-verification/unit/adminPageChrome.test.ts
npm run test:dev-verify:unit
npm --prefix client run build
npm --prefix server run build
git diff --check
git add client/src/pages/admin/DigiflazzSellerCenter.tsx \
  client/src/pages/admin/DigiflazzSellerChannel.tsx client/src/pages/admin/IrsSellerIntegration.tsx \
  client/src/pages/admin/AddOns.tsx client/src/pages/admin/AdminRoutes.tsx \
  client/src/pages/admin/DigiflazzSellerSettings.tsx client/src/pages/admin/IrsSellerSettings.tsx \
  tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: unify private digiflazz seller center admin"
```

---

### Task 8: Prove Security, Fulfillment, Redirects, and Responsive UX End to End

**Files:**
- Modify: `tools/dev-verification/seed.ts`
- Modify: `tools/dev-verification/unit/seed.test.ts`
- Create: `tools/dev-verification/integration/sellerCenter.test.ts`
- Create: `tools/dev-verification/e2e/seller-center.spec.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`
- Modify: `tools/dev-verification/unit/verificationMatrix.test.ts`
- Modify: `docs/superpowers/plans/2026-08-20-digiflazz-seller-center.md` (mark progress after all evidence)

**Interfaces:**
- Produces fixtures `seller-center-manager` (`manageVendors`, `viewTransactions`) and `seller-center-denied` (neither permission).
- Produces required checks `seller-center-integration`, `seller-center-desktop`, `seller-center-mobile`.
- Consumes all Tasks 1–7 and exact disposable DB `webtopup_task14_dev`.

- [ ] **Step 1: Add RED seed and matrix source tests**

Assert both fixtures exist with unique email/device identity and matrix contains exactly:

```ts
[
  ['seller-center-integration', 'session-cs'],
  ['seller-center-desktop', 'session-cs'],
  ['seller-center-mobile', 'session-cs'],
]
```

All are `required:true`, isolated, and use the canonical test files.

- [ ] **Step 2: Run seed/matrix tests to verify RED**

```bash
node --import tsx --test tools/dev-verification/unit/seed.test.ts tools/dev-verification/unit/verificationMatrix.test.ts
```

Expected: FAIL because fixtures/checks are absent.

- [ ] **Step 3: Implement test-local fixtures and integration cleanup guards**

Global seed creates users only. `sellerCenter.test.ts` inserts marked, test-local:

- shared mapping/product fixtures;
- Digiflazz/IRS config fixtures using synthetic secrets;
- historical order/log rows containing synthetic `rawRequest`/`raw` secrets;
- exact seller indexes after proving the separate `seller_order_readiness --apply` binary creates and verifies them in disposable mode.

Every write includes `task14Fixture:true` and `fixtureRunId`. Cleanup first verifies the `__localVerification` marker and exact DB name, then removes only marked rows. Never place vendor/provider URL fixtures in global seed.

- [ ] **Step 4: Implement integration permission and step-up assertions**

Through Node gateway prove:

- anonymous summary/settings reads → `401`;
- denied fixture → `403`;
- manager summary → typed response with no credential/target/SN fields;
- both settings mutations without grant → `AUTH_STEP_UP_REQUIRED` for exact `integrations.credentials`;
- valid step-up permits a settings update while omitted secrets remain unchanged and all responses expose booleans only;
- public prepaid routes do not require admin auth.

- [ ] **Step 5: Prove secrecy and historical hygiene**

- send invalid Digiflazz and IRS requests containing synthetic signatures/password/PIN/secret;
- query Mongo directly and assert no newly created seller order/log contains those values, `raw`, or `rawRequest`;
- query admin order/log endpoints and assert response keys are exact allowlists and synthetic secrets are absent;
- run scrubber dry-run and assert affected counts but `modifiedDocuments:0`;
- run disposable `--apply`, assert raw fields are removed and exact unique indexes are ready;
- re-run dry-run and assert `affected:0`, `blocking:false`;
- scan captured stdout/stderr/report artifacts and assert fixture secret strings are absent.

- [ ] **Step 6: Prove concurrent IRS fulfillment executes once**

With `PROVIDER_MODE=mock`, submit two concurrent requests with the same valid `refId`. Assert:

- both responses preserve exact IRS envelope keys;
- exactly one `irssellerorders` row exists;
- `executionStartedAt` exists once and `executionState` reaches `completed`;
- one safe IRS request event is associated with the execution outcome (duplicate-return logging, if retained, uses a distinct safe event and never triggers fulfillment);
- persisted supplier/internal reference is identical across responses;
- no external host was contacted; disposable logs contain no non-loopback provider request.

Also test a Mongo failure seam/invalid collection readiness yields generic channel-compatible failure and zero provider execution.

- [ ] **Step 7: Implement desktop/mobile route-intercepted browser coverage**

Browser test requirements:

1. login as `seller-center-manager`;
2. old Digiflazz URL redirects to canonical overview with `replace` behavior;
3. old IRS URL redirects to canonical `section=irs`;
4. sidebar contains one **Digiflazz Seller Center**, no standalone IRS;
5. section navigation is keyboard-accessible and URL-addressable;
6. Add Ons renders one card with Digiflazz and IRS rows;
7. global refresh increments summary and active-section requests exactly once;
8. delayed old response cannot overwrite newer response;
9. partial/unavailable summary uses `role=alert` and never displays ready/zero as health;
10. IRS secrets remain blank/write-only with boolean configured indicators, and order/log fields are responsive on desktop/mobile;
11. no pure local Refresh button exists; save/sync/retry mutations remain.

Use Playwright route interception for UI race/degraded states. Do not call provider endpoints.

- [ ] **Step 8: Register matrix checks and run focused disposable verification**

```bash
npm run api-v2:build
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.integration.config.ts sellerCenter.test.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts seller-center.spec.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts seller-center.spec.ts --project=chromium-mobile --workers=1
```

Expected: all three focused checks PASS; no provider call; test database exact.

- [ ] **Step 9: Commit end-to-end coverage**

```bash
git add tools/dev-verification/seed.ts tools/dev-verification/unit/seed.test.ts \
  tools/dev-verification/integration/sellerCenter.test.ts tools/dev-verification/e2e/seller-center.spec.ts \
  tools/dev-verification/verificationMatrix.ts tools/dev-verification/unit/verificationMatrix.test.ts
git commit -m "test: verify digiflazz seller center end to end"
```

- [ ] **Step 10: Run complete focused verification on the final tree**

```bash
cd rust-api
cargo test services::seller_secrecy::tests -- --nocapture
cargo test services::seller_integrity::tests -- --nocapture
cargo test routes::irs_seller:: -- --nocapture
cargo test routes::digiflazz_seller:: -- --nocapture
cargo test
cargo check
cd ..
node --test scripts/security/seller-secret-policy.test.js scripts/security/scrub-seller-secrets.test.js
node --import tsx --test client/src/lib/digiflazzSellerCenter.test.ts client/src/lib/adminNav.test.ts \
  tools/dev-verification/unit/adminPageChrome.test.ts server/src/routes/apiV2ProxyRoutes.test.ts
npm run test:dev-verify:unit
npm --prefix client run build
npm --prefix server run build
git diff --check
```

Expected: every command PASS. Record `cargo fmt --check` as unavailable if `rustfmt` remains absent.

- [ ] **Step 11: Run the complete aggregate disposable matrix**

Rebuild the Rust binary, ensure disposable infrastructure is up, then run:

```bash
npm run api-v2:build
npm run dev-verify -- infra-up
npm run dev-verify -- test
```

Expected: `LOCAL DEV VERIFIED`; aggregate report contains all required checks including the three Seller Center checks. Record run ID, check count, and result.

- [ ] **Step 12: Tear down and audit secrecy**

```bash
npm run dev-verify -- down
npm run dev-verify -- status
node --import tsx tools/dev-verification/cli.ts audit-reports
```

Expected: zero processes/services, rollout disabled, report secrecy PASS, and no fixture credentials/raw bodies in retained reports.

- [ ] **Step 13: Obtain independent review and resolve findings**

Request a fresh read-only review of `origin/main..HEAD` against the spec. Fix every Critical/Important finding with a focused RED/GREEN test and separate checkpoint commit. Re-run affected focused checks plus full Rust/client/server builds after fixes.

- [ ] **Step 14: Mark plan complete and commit progress**

After all evidence and review are green, change only this plan's completed step checkboxes from `[ ]` to `[x]`, then:

```bash
git add -f docs/superpowers/specs/2026-08-20-digiflazz-seller-center-design.md \
  docs/superpowers/plans/2026-08-20-digiflazz-seller-center.md
git diff --cached --check
git commit -m "docs: mark digiflazz seller center verified"
```

- [ ] **Step 15: Run finishing workflow without implicit release**

Invoke `superpowers:finishing-a-development-branch`. Present integration options only after the final tree's full tests pass. Do not push, scrub production, apply production indexes, deploy, restart, or call a provider until the user explicitly authorizes that separate operation.
