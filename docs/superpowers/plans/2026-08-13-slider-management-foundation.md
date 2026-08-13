# Slider Management Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build transaction-only, permanently idempotent, revisioned slider management with shared managed-asset fencing, archive/restore, authoritative public freshness, accessible admin/homepage UX, and disposable end-to-end proof.

**Architecture:** Rust owns authoritative slider normalization, revision snapshots, managed-asset registry/fencing, transaction state, permanent claims, domain audit, and public ETag. Node preserves authentication, active-account, permission, CSRF, trusted-proxy, body-limit, idempotency, optional step-up, route-closure, and header-forwarding boundaries. React enables mutations only after the exact backend capability marker, retains stable intents across step-up/replay/conflict, and uses accessible slider/ImagePicker/carousel primitives. All mutation and migration verification runs only against marked `webtopup_task14_dev`.

**Tech Stack:** React 19, TypeScript 5.9, Axios, Zustand, dnd-kit, Fastify 4, Node test runner, Rust 1.97/Axum 0.8, MongoDB Rust driver 3.x replica-set transactions, `unicode-normalization` 0.1.x, Playwright 1.61, existing disposable verification harness.

**Spec:** `docs/superpowers/specs/2026-08-13-slider-management-foundation-design.md`

## Global Constraints

- Execute inline on the existing `main` checkout only if the user selects inline execution; do not create a worktree without renewed consent.
- Follow strict TDD for every production behavior: RED test, observe expected failure, minimal GREEN implementation, focused verification, `git diff --check`, checkpoint commit.
- Preserve Node/Rust `manageSettings`, database-backed active-account checks, 2FA, step-up, CSRF, credential cookies, refresh semantics, trusted proxy/header stripping, correlation IDs, route ordering, and existing upload permission mappings.
- Every create, update/status, archive, restore, and reorder is MongoDB-transaction-only and returns `503 SLIDER_TRANSACTIONS_UNAVAILABLE` when unavailable; no best-effort fallback exists.
- Every slider mutation requires a permanent `Idempotency-Key` bound to contract version, operator, action, target, expected revision, and authoritative canonical payload digest.
- Same key/binding/digest replays; changed binding/digest returns `409 IDEMPOTENCY_CONFLICT`; fenced ambiguity returns `503 SLIDER_COMMIT_UNKNOWN` and is never reclaimable.
- One global slider revision increments exactly once per successful mutation. Stale `expectedRevision` returns frozen `409 SLIDER_VERSION_CONFLICT` with the latest snapshot.
- Trusted step-up group is exactly `settings.sensitive`; Rust derives sensitivity from effective state. Stable intent/key survives step-up.
- New/changed slider images must be registered, available canonical `/uploads/covers/<filename>` assets. New/changed links are empty, safe internal, or HTTPS without credentials.
- At most 20 current/non-archived sliders and eight public/active sliders. Archive replaces hard delete; restore always creates a nonactive draft; no purge exists.
- Managed registry reference rows/count ownership is slider-only in phase one. Every discovered active non-slider `covers` writer must increment `acquisitionFenceVersion` in the same transaction as its domain write or `covers` deletion remains fail closed.
- Public sliders remain an array, use strong `ETag: "sliders-<revision>"`, `Cache-Control: no-cache`, conditional `304`, no Node body cache, and no internal timestamps/status/lifecycle/order fields.
- New client writes require exact `mutationContract: "slider-revision-v1"`; never fall back to legacy slider mutations. Rust emits this marker only after local readiness and a fresh HMAC-authenticated gateway-capability assertion from a new Node gateway. The assertion is bound to method, upstream path, timestamp, and gateway correlation ID under the existing server-only Node↔Rust proxy secret; browser-supplied assertion headers are stripped/overwritten.
- Automated readiness/index/repair `--apply` is permitted only for exact database `webtopup_task14_dev`. Production scan, repair, index creation, migration, restart, deployment, and push require separate approval.
- Synthetic verification uses loopback MongoDB `127.0.0.1:27018`, replica set `rs0`, marked fixtures, mock provider, and real hardened JPEG/PNG/WebP uploads. Never use production users or provider mutations.
- Slider node:test integrations run with `node --import tsx --test`; browser e2e runs with Playwright.
- Direct Chromium launched from node:test must map `webtopup.local.test` to `127.0.0.1` and ignore certificate errors.
- `cargo fmt --check` remains unavailable because `rustfmt` is not installed; do not install it without approval.
- Full completion requires fresh `LOCAL DEV VERIFIED` and teardown `serviceCount: 0`.

---

## File structure and responsibility map

### Rust: create

- `rust-api/src/routes/content/slider_types.rs` — request/response/domain types for snapshots, limits, mutation actions, and public DTOs.
- `rust-api/src/routes/content/slider_policy.rs` — NFC normalization, exact validation, canonical action payload/digest input, effective sensitivity, limits, and order validation.
- `rust-api/src/routes/content/slider_snapshot.rs` — global metadata, bounded stable admin/public snapshots, public DTO, ETag parsing, and readiness-plus-gateway-handshake-controlled capability marker.
- `rust-api/src/routes/content/slider_idempotency.rs` — permanent claims, exact indexes, claim binding, lease/reclaim, recovery IDs, transaction-start fence, replay, and conditional commit-unknown handling.
- `rust-api/src/routes/content/slider_mutation.rs` — read-only preflight, write transaction orchestration, create/update/archive/restore/reorder, audit, commit recovery, and frozen responses.
- `rust-api/src/services/managed_asset_registry.rs` — reusable asset/asset-reference schema, exact indexes, registration, reference acquire/release, legacy acquisition fence, deletion transition, and reconciliation states.
- `rust-api/src/bin/slider_managed_asset_readiness.rs` — dry-run report and exact disposable-only apply workflow.

### Rust: modify

- `rust-api/Cargo.toml`, `rust-api/Cargo.lock` — pin `unicode-normalization` and register readiness binary.
- `rust-api/src/services/mod.rs`, `rust-api/src/lib.rs` — export registry/readiness primitives.
- `rust-api/src/routes/content.rs` — module declarations and new handler exports.
- `rust-api/src/routes/content/sliders.rs` — thin read/mutation HTTP handlers and closed legacy handlers.
- `rust-api/src/routes/content/types.rs` — remove obsolete slider payload/item types after migration.
- `rust-api/src/routes/mod.rs` — new archive/restore/reorder/archived routes, 64 KiB slider JSON limit, old route closures.
- `rust-api/src/routes/uploads/publication.rs`, `uploads/handlers.rs`, `uploads/types.rs` — registry registration/rollback and transactional delete gate.
- `rust-api/src/routes/taxonomy/product_types.rs`, `content/flash_admin.rs`, `content/flash_payload.rs`, `articles.rs`, `articles/validation.rs`, `rewards.rs`, `rewards/validation.rs` — transaction-bound `covers` acquisition-fence participation for intended non-slider cover writers.
- `rust-api/src/routes/products/payload.rs`, `products/mutations.rs`, `taxonomy/categories.rs`, `taxonomy/operators.rs`, `payment/validation.rs`, `payment/categories.rs`, `payment/methods.rs`, `settings/validation.rs`, `settings/mutation.rs` — explicit field-folder policy that prevents icon/popup/settings fields from newly persisting `covers`, plus session-bound fence use if a reviewed field remains cover-capable.
- `rust-api/src/services/local_fault.rs` — guarded slider/registry fault seams.
- `rust-api/src/main.rs`, `rust-api/src/security_hardening_checks.rs` — startup readiness checks without production auto-apply and source-contract guards.

### Node/gateway: modify

- `server/src/routes/apiV2ProxyRoutes.ts`, `server/src/routes/apiV2ProxyRoutes.test.ts` — route inventory, 64 KiB limits, required idempotency, optional exact step-up, archive/restore/reorder forwarding, legacy closure, HMAC-authenticated internal gateway-capability assertion, and public ETag forwarding.
- `server/src/middlewares/stepUp.ts`, `server/src/middlewares/authMiddleware.test.ts` — preserve `settings.sensitive` optional proof semantics.
- `server/src/app.ts` — expose `ETag`, ensure public sliders are not body cached, and keep route order.
- `server/src/services/adminAuditService.ts`, `adminAuditService.test.ts` — label new slider actions while preserving sanitized, bounded gateway audit.
- `server/src/controllers/sliderController.ts`, `server/src/routes/sliderRoutes.ts` — retain only as explicitly inactive legacy reference; add source contract preventing registration.

### Client: create

- `client/src/lib/sliderManagement.ts` — snapshot parsing, capability gate, stable intent creation, save request construction, conflict classification, nested error mapping, link normalization mirrors, and order helpers.
- `client/src/lib/sliderManagement.test.ts` — pure client contracts.
- `client/src/lib/sliderCarousel.ts` — active-slide index normalization, pause/reduced-motion state, safe public link classification, and swipe threshold helpers.
- `client/src/lib/sliderCarousel.test.ts` — pure carousel behavior.
- `client/src/components/admin/AccessibleDialog.tsx` — shared focus trap, Escape, restoration, body lock, and inert-parent support.
- `client/src/components/home/HomeSliderCarousel.tsx` — isolated accessible public carousel.

### Client: modify

- `client/src/pages/admin/Sliders.tsx` — revisioned main/archive views, stable mutation intents, archive/restore, conflict/uncertain UX, mobile cards, reorder rollback, accessible dialogs/status/errors, previews, and capacity.
- `client/src/components/admin/ImagePicker.tsx`, `ImagePickerField.tsx` — accessible modal/radio grid/delete confirmation and covers-only selection mode.
- `client/src/pages/Home.tsx` — delegate slider rendering to `HomeSliderCarousel` and remove duplicate link/carousel state.
- `client/src/auth/withStepUp.ts`, `client/src/auth/useStepUpOrchestration.tsx` — verify slider stable-key retry provenance without changing other actions.

### Verification: create

- `tools/dev-verification/integration/sliderManagement.test.ts` — real Node/Rust/Mongo/filesystem permission, mutation, registry, concurrency, audit, fault, ETag, and recovery proof.
- `tools/dev-verification/e2e/sliders.spec.ts` — desktop/mobile admin CRUD/archive/conflict/step-up/accessibility/mobile reorder.
- `tools/dev-verification/e2e/home-slider.spec.ts` — public carousel click/focus/pause/reduced-motion/mobile/fallback proof.

### Verification: modify

- `tools/dev-verification/seed.ts`, `unit/seed.test.ts` — denied/manager/inactive slider fixtures and real cover fixture metadata.
- `tools/dev-verification/faults.ts`, `faultProxy.ts`, `unit/faults.test.ts`, `unit/faultProxy.test.ts` — closed slider fault inventory and response-loss seam.
- `tools/dev-verification/processes.ts`, `unit/processes.test.ts` — disposable readiness apply before host startup.
- `tools/dev-verification/verificationMatrix.ts`, `unit/verificationMatrix.test.ts` — slider integration and desktop/mobile browser checks.
- `scripts/smoke/api-v2-read-smoke.js`, `api-v2-mutation-smoke.js` — capability/ETag/array contract and real uploaded PNG/WebP mutation smoke; remove SVG assumptions.

---

### Task 1: Establish slider policy, normalized types, and public DTO contracts

**Files:**
- Create: `rust-api/src/routes/content/slider_types.rs`
- Create: `rust-api/src/routes/content/slider_policy.rs`
- Modify: `rust-api/src/routes/content.rs`
- Modify: `rust-api/src/routes/content/types.rs`
- Modify: `rust-api/Cargo.toml`
- Modify: `rust-api/Cargo.lock`
- Test: inline `#[cfg(test)]` modules in `slider_policy.rs` and `slider_types.rs`

**Interfaces:**
- Produces:
  - `pub const SLIDER_MUTATION_CONTRACT: &str = "slider-revision-v1"`
  - `pub const MAX_CURRENT_SLIDERS: i64 = 20`
  - `pub const MAX_PUBLIC_SLIDERS: i64 = 8`
  - `pub enum SliderAction { Create, Update, Archive, Restore, Reorder }`
  - `pub struct NormalizedSliderChanges`
  - `pub fn normalize_create(payload: SliderCreateRequest) -> Result<NormalizedSliderChanges, SliderPolicyError>`
  - `pub fn normalize_update(payload: SliderUpdateRequest, current: &SliderSnapshotItem) -> Result<NormalizedSliderChanges, SliderPolicyError>`
  - `pub fn effective_requires_step_up(action: SliderAction, before: Option<&SliderSnapshotItem>, after: Option<&SliderSnapshotItem>, old_public_order: &[ObjectId], new_public_order: &[ObjectId]) -> bool`
  - `pub fn canonical_slider_claim_input(contract_version: &str, operator_id: ObjectId, action: SliderAction, target_id: Option<ObjectId>, expected_revision: i64, normalized_payload: &Value) -> Value`
  - `pub fn public_slider_from_document(document: &Document) -> PublicSliderItem`
- Consumes later: Tasks 2, 7, 8, 9, and 12 use these exact types/functions.

- [ ] **Step 1: Add the dependency and write RED normalization/validation tests**

Add `unicode-normalization = "=0.1.24"` to `rust-api/Cargo.toml`, then create tests covering exact policy:

```rust
#[test]
fn name_uses_trim_then_nfc_and_enforces_scalar_and_byte_bounds() {
    let normalized = normalize_slider_name("  Cafe\u{301}  ").unwrap();
    assert_eq!(normalized, "Café");
    assert_eq!(normalize_slider_name(&"é".repeat(120)).unwrap().chars().count(), 120);
    assert_eq!(normalize_slider_name(&"é".repeat(121)).unwrap_err().code(), "SLIDER_NAME_INVALID");
    assert_eq!(normalize_slider_name("bad\nname").unwrap_err().code(), "SLIDER_NAME_INVALID");
}

#[test]
fn image_requires_exact_canonical_cover_path() {
    for bad in [
        "https://cdn.example/x.webp",
        "/uploads/icons/x.webp",
        "/uploads/covers/../x.webp",
        "/uploads/covers/%2e%2e.png",
        "/uploads/covers/x.webp?raw=1",
    ] {
        assert_eq!(normalize_slider_image(bad).unwrap_err().code(), "SLIDER_IMAGE_INVALID");
    }
    assert_eq!(
        normalize_slider_image("/uploads/covers/1710000000000-deadbeef.webp").unwrap(),
        "/uploads/covers/1710000000000-deadbeef.webp"
    );
}

#[test]
fn links_accept_internal_or_https_and_normalize_authoritatively() {
    assert_eq!(normalize_slider_link("").unwrap(), "");
    assert_eq!(normalize_slider_link("/promo?a=1&a=2#x").unwrap(), "/promo?a=1&a=2#x");
    assert_eq!(normalize_slider_link("HTTPS://EXAMPLE.COM:443").unwrap(), "https://example.com/");
    for bad in ["http://example.com", "https://u:p@example.com", "//example.com", "/../admin", "/%2fadmin", "javascript:alert(1)"] {
        assert_eq!(normalize_slider_link(bad).unwrap_err().code(), "SLIDER_LINK_INVALID");
    }
}
```

Add tests for unknown fields (`#[serde(deny_unknown_fields)]`), literal booleans, nonnegative integer revision, 64 KiB policy constant, public DTO omission, and canonical claim input. Prove that changing any one of contract version, operator, action, target, expected revision, or normalized payload changes the SHA-256 digest.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd rust-api && cargo test slider_policy -- --nocapture
```

Expected: FAIL because `slider_policy`, normalized types, and functions do not exist.

- [ ] **Step 3: Implement minimal authoritative policy and types**

Use NFC exactly in Rust:

```rust
use unicode_normalization::UnicodeNormalization;

pub fn trim_nfc(raw: &str) -> String {
    raw.trim().nfc().collect::<String>()
}
```

Define request types with `#[serde(rename_all = "camelCase", deny_unknown_fields)]`; preserve internal link query/fragment bytes after validating percent escapes and traversal; use `url::Url` serialization for HTTPS external links. Count name with `.chars().count()` and UTF-8 with `.as_bytes().len()`.

Implement sensitivity truth table exactly:

```rust
match action {
    SliderAction::Create => after.is_some_and(|value| value.status),
    SliderAction::Update => {
        let was_public = before.is_some_and(SliderSnapshotItem::is_public);
        let becomes_public = after.is_some_and(SliderSnapshotItem::is_public);
        (!was_public && becomes_public)
            || (was_public && public_fields_changed(before, after))
    }
    SliderAction::Archive => before.is_some_and(SliderSnapshotItem::is_public),
    SliderAction::Restore => false,
    SliderAction::Reorder => old_public_order != new_public_order,
}
```

- [ ] **Step 4: Run GREEN tests and focused compile**

Run:

```bash
cd rust-api && cargo test slider_policy -- --nocapture
cargo test slider_types -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: all focused tests PASS and `cargo check` exits `0`.

- [ ] **Step 5: Commit**

```bash
git add rust-api/Cargo.toml rust-api/Cargo.lock rust-api/src/routes/content.rs rust-api/src/routes/content/types.rs rust-api/src/routes/content/slider_types.rs rust-api/src/routes/content/slider_policy.rs
git commit -m "feat: define slider mutation policy"
```

---

### Task 2: Add global revision snapshots, mutation-disabled admin reads, and public ETag

**Files:**
- Create: `rust-api/src/routes/content/slider_snapshot.rs`
- Modify: `rust-api/src/routes/content.rs`
- Modify: `rust-api/src/routes/content/sliders.rs`
- Modify: `rust-api/src/routes/mod.rs`
- Test: inline `#[cfg(test)]` in `slider_snapshot.rs`
- Test: `scripts/smoke/api-v2-read-smoke.js`

**Interfaces:**
- Consumes: Task 1 DTO/policy constants.
- Produces:
  - `pub const SLIDER_METADATA_COLLECTION: &str = "slidermetadata"`
  - `pub async fn load_slider_revision(client: &Client, db_name: &str) -> Result<i64, SliderSnapshotError>`
  - `pub async fn load_current_snapshot(...) -> Result<SliderAdminSnapshot, SliderSnapshotError>`
  - `pub async fn load_archived_snapshot(...) -> Result<SliderAdminSnapshot, SliderSnapshotError>`
  - `pub async fn load_public_snapshot(...) -> Result<(i64, Vec<PublicSliderItem>), SliderSnapshotError>`
  - `pub fn slider_etag(revision: i64) -> String`
  - `pub fn matches_slider_etag(value: Option<&HeaderValue>, revision: i64) -> bool`

- [ ] **Step 1: Write RED stable snapshot and ETag tests**

```rust
#[test]
fn exact_strong_slider_etag_list_matching() {
    let current = HeaderValue::from_static("\"old\", \"sliders-14\"");
    assert!(matches_slider_etag(Some(&current), 14));
    for raw in ["W/\"sliders-14\"", "*", "\"sliders-014\"", "sliders-14", "\"sliders-15\""] {
        assert!(!matches_slider_etag(Some(&HeaderValue::from_str(raw).unwrap()), 14));
    }
}

#[test]
fn public_dto_omits_internal_slider_fields() {
    let json = serde_json::to_value(public_fixture()).unwrap();
    assert_eq!(json.as_object().unwrap().keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from(["_id".into(), "image".into(), "link".into(), "name".into()]));
}
```

Add unit seams for three-attempt stable reads: revision sequence `[1,2,2,2]` succeeds at revision 2; `[1,2,2,3,3,4]` returns `SLIDER_SNAPSHOT_UNSTABLE`. Add legacy missing lifecycle => current and invalid/HTTP public link => empty.

- [ ] **Step 2: Run RED tests**

Run: `cd rust-api && cargo test slider_snapshot -- --nocapture`

Expected: FAIL because snapshot/ETag helpers do not exist.

- [ ] **Step 3: Implement stable reads and thin handlers**

Implement max three attempts, treat missing metadata as `0`, and use filter equivalent to current legacy data:

```rust
let current_filter = doc! { "lifecycle": { "$ne": "archived" } };
let public_filter = doc! {
    "lifecycle": { "$ne": "archived" },
    "status": true,
};
```

Change admin response to versioned read shape `{ revision, sliders, limits }` but deliberately omit `mutationContract` in this milestone. Add `/v2/sliders/admin/archived`. Public handler returns array plus `ETag`/`no-cache`, and `304` on exact list-member match. Add a RED/GREEN assertion that the marker is absent while any mutation action, legacy route closure, exact index, registry, or transaction readiness gate is incomplete. Keep mutation handlers temporarily legacy and keep the read response explicitly mutation-disabled.

- [ ] **Step 4: Verify reads and compile**

Run:

```bash
cd rust-api && cargo test slider_snapshot -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && node --check scripts/smoke/api-v2-read-smoke.js
git diff --check
```

Expected: PASS; smoke syntax valid.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/content.rs rust-api/src/routes/content/sliders.rs rust-api/src/routes/content/slider_snapshot.rs rust-api/src/routes/mod.rs scripts/smoke/api-v2-read-smoke.js
git commit -m "feat: version slider snapshots"
```

---

### Task 3: Build managed-asset registry schema, indexes, and pure transition helpers

**Files:**
- Create: `rust-api/src/services/managed_asset_registry.rs`
- Modify: `rust-api/src/services/mod.rs`
- Modify: `rust-api/src/lib.rs`
- Test: inline tests in `managed_asset_registry.rs`

**Interfaces:**
- Produces:
  - `MANAGED_ASSETS_COLLECTION`, `MANAGED_ASSET_REFERENCES_COLLECTION`
  - `ManagedAssetState::{Available, Deleting}`
  - `pub fn managed_asset_index_models() -> Vec<IndexModel>`
  - `pub async fn ensure_managed_asset_indexes(db: &Database) -> Result<(), RegistryError>`
  - `pub async fn register_published_asset(db: &Database, upload: &PublishedUpload, metadata: &CanonicalImageMetadata) -> Result<ObjectId, RegistryError>`
  - `pub async fn register_published_batch_in_transaction(db: &Database, uploads: &[PublishedAssetRegistration]) -> Result<Vec<ObjectId>, RegistryError>`
  - `pub async fn acquire_slider_reference(session: &mut ClientSession, db: &Database, path: &str, slider_id: ObjectId) -> Result<ManagedReferenceOutcome, RegistryError>`
  - `pub async fn release_slider_reference(...)`
  - `pub async fn increment_legacy_acquisition_fence(...)`
  - `pub async fn begin_asset_deletion(...)`
  - `pub async fn mark_asset_deleted(...)`
- Consumes later: Tasks 4–6 and 9–10.

- [ ] **Step 1: Write RED index and transition tests**

Assert exact semantic index keys/options and pure rules:

```rust
#[test]
fn registry_indexes_are_unique_only_where_required() {
    let models = managed_asset_index_models();
    assert_index(&models, doc! { "canonicalPath": 1 }, true, None);
    assert_index(&models, doc! { "assetId": 1, "resourceType": 1, "resourceId": 1, "field": 1 }, true, None);
    assert_no_ttl(&models);
}

#[test]
fn deleting_assets_never_accept_new_references() {
    assert_eq!(reference_transition(ManagedAssetState::Deleting, 0, ReferenceAction::Acquire).unwrap_err().code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
}
```

Add tests for reference underflow, duplicate row mismatch, `acquisitionFenceVersion` monotonic increment, and canonical folder/path checks.

- [ ] **Step 2: Run RED tests**

Run: `cd rust-api && cargo test managed_asset_registry -- --nocapture`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement registry service with session-aware operations**

Use conditional document filters, not read-then-unconditional updates. Also expose `register_published_batch_in_transaction(db, uploads) -> Result<Vec<ObjectId>, RegistryError>` so Task 4 can atomically insert all registry rows:

```rust
let result = assets.update_one(
    doc! { "_id": asset_id, "state": "available", "referenceCount": expected_count },
    doc! { "$inc": { "referenceCount": 1_i64 }, "$set": { "updatedAt": now } },
).session(session).await?;
if result.modified_count != 1 { return Err(RegistryError::Unavailable); }
```

For legacy fence, require `$inc: { acquisitionFenceVersion: 1 }` with `state: available`. For release, delete exact unique reference in session and conditionally decrement count; mismatch aborts transaction.

- [ ] **Step 4: Run GREEN tests**

Run:

```bash
cd rust-api && cargo test managed_asset_registry -- --nocapture
cargo check --lib
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/services/managed_asset_registry.rs rust-api/src/services/mod.rs rust-api/src/lib.rs
git commit -m "feat: add managed asset registry"
```

---

### Task 4: Register hardened uploads and make publication rollback-safe

**Files:**
- Modify: `rust-api/src/routes/uploads/policy.rs`
- Modify: `rust-api/src/routes/uploads/publication.rs`
- Modify: `rust-api/src/routes/uploads/handlers.rs`
- Modify: `rust-api/src/routes/uploads/types.rs`
- Test: inline upload publication/handler tests
- Test: `tools/dev-verification/integration/uploadSecurity.test.ts`

**Interfaces:**
- Consumes: Task 3 `register_published_asset`.
- Produces: every successful new upload has exactly one `managedassets` row with dimensions/format/size and `referenceCount: 0`.

- [ ] **Step 1: Write RED registration rollback tests**

Add a publication orchestration seam accepting a registry callback and assert:

```rust
#[tokio::test]
async fn published_file_is_removed_when_registry_insert_fails() {
    let staged = valid_staged(&root, "covers");
    let result = publish_and_register_batch(vec![staged], |_uploads| async {
        Err(RegistryError::Storage)
    }).await;
    assert_eq!(result.unwrap_err().code(), "MANAGED_ASSET_REGISTRY_UNAVAILABLE");
    assert!(public_batch_files(&root).is_empty());
}
```

Add duplicate canonical-path and batch partial-registration rollback cases. Inject failure after the first registry insert in a two-file batch and assert both zero registry rows for the batch and zero published files. Extend node:test integration expectations: upload success returns canonical URL; Mongo registry row exists and matches actual bytes/dimensions.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd rust-api && cargo test uploads::publication -- --nocapture
cd .. && node --import tsx --test tools/dev-verification/integration/uploadSecurity.test.ts
```

Expected: unit FAIL because registry orchestration is absent; integration may fail if disposable host is not running—record that as environment-blocked and still require unit RED.

- [ ] **Step 3: Implement publication registration**

Expose canonical metadata from `CanonicalImage`, publish all files, then insert every batch registry row inside one MongoDB transaction. Commit only if every row inserts successfully. On transaction abort/failure, prove zero registry rows from that batch, then unlink every newly published file. If zero-row absence or cleanup cannot be proven, return `MANAGED_ASSET_REGISTRY_UNAVAILABLE`, leave a readiness finding, and never report upload success. Never mark registry `available` before final file existence. Existing historical files remain unregistered.

- [ ] **Step 4: Verify focused tests**

Run:

```bash
cd rust-api && cargo test uploads::publication -- --nocapture
cargo test managed_asset_registry -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/uploads/policy.rs rust-api/src/routes/uploads/publication.rs rust-api/src/routes/uploads/handlers.rs rust-api/src/routes/uploads/types.rs tools/dev-verification/integration/uploadSecurity.test.ts
git commit -m "feat: register managed uploads"
```

---

### Task 5: Close the complete covers-writer inventory without migrating non-slider reference rows

**Files:**
- Modify: `rust-api/src/services/managed_assets.rs`
- Modify: `rust-api/src/routes/taxonomy/product_types.rs`
- Modify: `rust-api/src/routes/content/flash_admin.rs`
- Modify: `rust-api/src/routes/content/flash_payload.rs`
- Modify: `rust-api/src/routes/articles.rs`
- Modify: `rust-api/src/routes/articles/validation.rs`
- Modify: `rust-api/src/routes/rewards.rs`
- Modify: `rust-api/src/routes/rewards/validation.rs`
- Modify: `rust-api/src/routes/products/payload.rs`
- Modify: `rust-api/src/routes/products/mutations.rs`
- Modify: `rust-api/src/routes/taxonomy/categories.rs`
- Modify: `rust-api/src/routes/taxonomy/operators.rs`
- Modify: `rust-api/src/routes/payment/validation.rs`
- Modify: `rust-api/src/routes/payment/categories.rs`
- Modify: `rust-api/src/routes/payment/methods.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Modify: `rust-api/src/routes/settings/mutation.rs`
- Modify: `rust-api/src/security_hardening_checks.rs`
- Test: inline tests/source contracts for every `ensure_managed_fields` writer

**Interfaces:**
- Consumes: Task 3 `increment_legacy_acquisition_fence`.
- Produces:
  - `pub enum ManagedFieldFolderPolicy { Icons, Covers, Popups, Instructions, AnyManaged }`
  - `pub fn require_managed_folder(value: &str, policy: ManagedFieldFolderPolicy) -> Result<(), ManagedAssetReferenceError>`
  - `pub async fn fence_legacy_managed_writes(session, db, changed_paths) -> Result<(), RegistryError>`
  - an explicit closed inventory: intended cover writers are `producttypes.cover`, `flashsales.banner`, `articles.image`, `rewards.imageUrl`, and `sliders.image`; every other current managed field rejects new `covers` values.

- [ ] **Step 1: Write RED closed-inventory and transaction-fence tests**

Define the discovered cover writer inventory in tests:

```rust
const ACTIVE_COVERS_WRITERS: &[(&str, &str)] = &[
    ("producttypes", "cover"),
    ("flashsales", "banner"),
    ("articles", "image"),
    ("rewards", "imageUrl"),
    ("sliders", "image"),
];

const RESTRICTED_MANAGED_FIELDS: &[(&str, &str, ManagedFieldFolderPolicy)] = &[
    ("products", "icon", ManagedFieldFolderPolicy::Icons),
    ("categories", "icon", ManagedFieldFolderPolicy::Icons),
    ("operators", "icon", ManagedFieldFolderPolicy::Icons),
    ("operators", "instructionImage", ManagedFieldFolderPolicy::Instructions),
    ("producttypes", "icon", ManagedFieldFolderPolicy::Icons),
    ("producttypes", "popupInfo.image", ManagedFieldFolderPolicy::Popups),
    ("paymentmethods", "icon", ManagedFieldFolderPolicy::Icons),
    ("paymentcategories", "icon", ManagedFieldFolderPolicy::Icons),
    ("settings", "favicon", ManagedFieldFolderPolicy::Icons),
    ("settings", "logo", ManagedFieldFolderPolicy::Icons),
    ("settings", "popupBannerImage", ManagedFieldFolderPolicy::Popups),
];
```

Add a source-contract scan that fails whenever a new `ensure_managed_fields` call is introduced without an entry in one of these inventories. Assert every intended non-slider cover handler writes its domain row in a transaction and calls the fence helper only for an effectively changed `covers` path. Assert restricted fields reject a new `/uploads/covers/...` value but preserve unchanged historical values until explicitly repaired. Add a service test where deletion changes state concurrently and writer retry cannot persist after `deleting`.

- [ ] **Step 2: Run RED tests/source guard**

Run:

```bash
cd rust-api && cargo test covers_writer -- --nocapture
cargo test managed_asset_registry -- --nocapture
```

Expected: FAIL because handlers are not session-aware and no closed fence inventory exists.

- [ ] **Step 3: Implement transactional fence participation**

For each intended non-slider cover writer:

1. normalize/validate payload;
2. detect an effective changed path in folder `covers`;
3. start a transaction for that domain write;
4. increment `acquisitionFenceVersion` conditional on `available`;
5. perform the existing domain write in the same session;
6. commit with bounded transient retry of the whole nonfinancial writer transaction;
7. preserve existing permission and response contracts.

For every restricted managed field, reject newly submitted values whose parsed folder differs from its exact policy; an unchanged historical wrong-folder value may pass only when the field is not part of the effective update. Do not create registry reference rows or change `referenceCount` for non-slider writers. If an intended cover handler cannot safely use a transaction, make new `covers` persistence fail with `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE`; do not leave an unfenced path. Record deletion readiness per folder: this task can make `covers` ready after its inventory is complete; `icons`, `popups`, and `instructions` remain not ready until their writer inventories participate in a future phase.

- [ ] **Step 4: Verify writer tests and regression suites**

Run:

```bash
cd rust-api && cargo test covers_writer -- --nocapture
cargo test managed_field_folder_policy -- --nocapture
cargo test product_types -- --nocapture
cargo test flash_sale -- --nocapture
cargo test articles -- --nocapture
cargo test rewards -- --nocapture
cargo test products -- --nocapture
cargo test categories -- --nocapture
cargo test operators -- --nocapture
cargo test payment -- --nocapture
cargo test settings -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/services/managed_assets.rs rust-api/src/routes/taxonomy/product_types.rs rust-api/src/routes/content/flash_admin.rs rust-api/src/routes/content/flash_payload.rs rust-api/src/routes/articles.rs rust-api/src/routes/articles/validation.rs rust-api/src/routes/rewards.rs rust-api/src/routes/rewards/validation.rs rust-api/src/routes/products/payload.rs rust-api/src/routes/products/mutations.rs rust-api/src/routes/taxonomy/categories.rs rust-api/src/routes/taxonomy/operators.rs rust-api/src/routes/payment/validation.rs rust-api/src/routes/payment/categories.rs rust-api/src/routes/payment/methods.rs rust-api/src/routes/settings/validation.rs rust-api/src/routes/settings/mutation.rs rust-api/src/security_hardening_checks.rs
git commit -m "fix: fence managed cover writers"
```

---

### Task 6: Replace upload deletion scans with transactional registry deletion and reconciliation

**Files:**
- Modify: `rust-api/src/routes/uploads/handlers.rs`
- Modify: `rust-api/src/services/managed_asset_registry.rs`
- Modify: `rust-api/src/services/local_fault.rs`
- Test: inline handler/registry/fault tests
- Test: `tools/dev-verification/integration/uploadSecurity.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5 registry and writer fence.
- Produces: registry deletion decision `available -> deleting`, idempotent unlink, `ASSET_IN_USE`, and fail-closed readiness behavior.

- [ ] **Step 1: Write RED deletion race/retry tests**

Add tests for:

```rust
#[tokio::test]
async fn deletion_retry_reruns_legacy_scan_after_writer_conflict() {
    // first scan = zero; writer increments acquisitionFenceVersion and persists reference;
    // retry scan = one; deletion returns AssetInUse and leaves state available.
}
```

Also assert `referenceCount > 0`, actual reference rows, existing legacy scan results, missing registry, `state: deleting`, unlink failure, and unavailable transactions all fail with exact codes and no unlink.

- [ ] **Step 2: Run RED tests**

Run: `cd rust-api && cargo test upload_delete_registry -- --nocapture`

Expected: FAIL because delete handler still uses two best-effort scans and direct unlink.

- [ ] **Step 3: Implement registry-backed delete protocol**

Perform the legacy scan inside the transaction, conditionally write the same asset document to `deleting`, and retry the transaction only from the beginning so each retry reruns the scan. Enable registry-backed deletion only when the requested folder's readiness flag is true. In this phase `covers` may become ready after Task 5; `icons`, `popups`, and `instructions` return `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE` rather than using the old race-prone deletion path. After commit, unlink with a guarded fault seam. On unlink failure, retain `deleting`; on success record `deletedAt` without reopening availability.

- [ ] **Step 4: Verify focused tests**

Run:

```bash
cd rust-api && cargo test upload_delete_registry -- --nocapture
cargo test managed_asset_registry -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/uploads/handlers.rs rust-api/src/services/managed_asset_registry.rs rust-api/src/services/local_fault.rs tools/dev-verification/integration/uploadSecurity.test.ts
git commit -m "fix: transact managed upload deletion"
```

---

### Task 7: Add slider readiness scanner, exact indexes, and startup mutation gates

**Files:**
- Create: `rust-api/src/bin/slider_managed_asset_readiness.rs`
- Modify: `rust-api/Cargo.toml`
- Modify: `rust-api/src/services/managed_asset_registry.rs`
- Modify: `rust-api/src/routes/content/slider_snapshot.rs`
- Create: `rust-api/src/routes/content/slider_idempotency.rs` (initial index models only; behavior completed in Task 8)
- Modify: `rust-api/src/main.rs`
- Modify: `tools/dev-verification/processes.ts`
- Test: inline readiness tests
- Test: `tools/dev-verification/unit/processes.test.ts`

**Interfaces:**
- Produces:
  - `pub struct SliderReadinessReport`
  - `pub async fn inspect_slider_foundation(...) -> SliderReadinessReport`
  - CLI `slider_managed_asset_readiness [--apply] [--json]`
  - startup capability state consumed by Task 9 mutation handlers.

- [ ] **Step 1: Write RED readiness/apply-gate tests**

Cover missing registry file, orphan file, duplicate path/reference, count mismatch, stuck deleting, missing lifecycle/revision, invalid ordering, 20/8 overflow, invalid claims, and exact database gate:

```rust
#[test]
fn apply_refuses_every_database_except_exact_disposable_name() {
    for name in ["webtopup", "webtopup_task14", "webtopup_task14_dev_backup", ""] {
        assert!(!apply_allowed(name));
    }
    assert!(apply_allowed("webtopup_task14_dev"));
}
```

In `processes.test.ts`, assert host startup invokes the release binary with `--apply --json` only when shared env database is exact disposable and stops on nonzero readiness.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd rust-api && cargo test slider_readiness -- --nocapture
cd .. && node --import tsx --test tools/dev-verification/unit/processes.test.ts
```

Expected: FAIL because CLI/apply wiring does not exist.

- [ ] **Step 3: Implement dry-run report and disposable apply**

`--apply` may create exact indexes, register only reviewed real existing cover fixtures, create current slider reference rows, reconcile counts, normalize missing lifecycle to `active`, and initialize metadata. It must not invent replacement image/link data. Production startup inspects indexes/capability only and logs mutation readiness; it does not create/repair.

- [ ] **Step 4: Verify CLI and process contract**

Run:

```bash
cd rust-api && cargo test slider_readiness -- --nocapture
cargo build --release --bin slider_managed_asset_readiness
cd .. && node --import tsx --test tools/dev-verification/unit/processes.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/Cargo.toml rust-api/Cargo.lock rust-api/src/bin/slider_managed_asset_readiness.rs rust-api/src/services/managed_asset_registry.rs rust-api/src/routes/content/slider_snapshot.rs rust-api/src/routes/content/slider_idempotency.rs rust-api/src/main.rs tools/dev-verification/processes.ts tools/dev-verification/unit/processes.test.ts
git commit -m "feat: define slider readiness gates"
```

---

### Task 8: Implement permanent slider claims and conservative recovery primitives

**Files:**
- Modify: `rust-api/src/routes/content/slider_idempotency.rs`
- Modify: `rust-api/src/routes/content.rs`
- Modify: `rust-api/src/services/local_fault.rs`
- Test: inline `slider_idempotency.rs` tests

**Interfaces:**
- Consumes: Tasks 1 and 7 policy/index constants.
- Produces:
  - `SliderClaimBinding { key, contract_version, operator_id, action, target_id, expected_revision, payload_digest }`
  - `SliderClaimBegin::{Started, Completed, Conflict, InProgress, CommitUnknown}`
  - `begin_slider_claim`, `store_recovery_identifiers`, `mark_slider_transaction_started`, `complete_slider_claim_in_session`, `recover_slider_commit`, `mark_slider_commit_unknown_conditionally`
  - five-minute reclaim policy and 256 KiB response bound.

- [ ] **Step 1: Write RED permanent-claim tests**

Tests must prove:

```rust
#[test]
fn binding_includes_action_target_and_contract_version() { /* each difference conflicts */ }

#[test]
fn fenced_claim_is_never_reclaimable_even_after_proven_non_commit() {
    let claim = fixture_claim(doc! { "transactionStartedAt": DateTime::now(), "commitUnknown": false });
    assert!(!can_reclaim_slider_claim(&claim, far_future()));
}

#[test]
fn recovery_ids_are_immutable_and_create_has_candidate_slider_id() { /* exact fields */ }

#[test]
fn commit_unknown_update_cannot_overwrite_completed_result() { /* conditional filter */ }
```

Add frozen response 256 KiB boundary, replay-only toggles `replayed`, stale pre-transaction reclaim, lease generation/token fence, and exact semantic index tests.

- [ ] **Step 2: Run RED tests**

Run: `cd rust-api && cargo test slider_idempotency -- --nocapture`

Expected: FAIL because claim operations are incomplete.

- [ ] **Step 3: Implement claim lifecycle**

Reuse proven Site Config/giveaway helpers only for SHA-256 and commit-label classification; keep slider collection/fields/action binding separate. Preallocate create ObjectId and audit ObjectId before fence. Conditional commit-unknown update must include token, binding fields, lease generation, transactionStartedAt, incomplete status, and no frozen response.

- [ ] **Step 4: Run GREEN claim tests**

Run:

```bash
cd rust-api && cargo test slider_idempotency -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/content/slider_idempotency.rs rust-api/src/routes/content.rs rust-api/src/services/local_fault.rs
git commit -m "feat: add permanent slider claims"
```

---

### Task 9: Implement transaction-only create/update with revision, step-up, assets, audit, and replay

**Files:**
- Create: `rust-api/src/routes/content/slider_mutation.rs`
- Modify: `rust-api/src/routes/content.rs`
- Modify: `rust-api/src/routes/content/sliders.rs`
- Modify: `rust-api/src/routes/content/slider_snapshot.rs`
- Modify: `rust-api/src/main.rs`
- Modify: `rust-api/src/services/audit_sanitize.rs`
- Modify: `rust-api/src/routes/mod.rs`
- Modify: `rust-api/src/services/local_fault.rs`
- Test: inline mutation tests with extracted pure/session seams

**Interfaces:**
- Consumes: Tasks 1–3, 7–8.
- Produces: `pub async fn execute_slider_mutation(state, headers, action, target, payload) -> Response` for create/update.

- [ ] **Step 1: Write RED create/update transaction tests**

Create table tests for:

- transactions/index/registry unavailable => exact 503 and no claim/domain/audit/reference/revision write;
- draft create no step-up;
- active create requires exact trusted step-up;
- active-field edit requires step-up; deactivate does not;
- stale revision frozen conflict;
- total/active limits;
- managed cover reference acquire/swap;
- unrelated update preserves legacy image; explicit legacy image change rejects;
- legacy-invalid link must be corrected on any save;
- same key replay and changed digest conflict;
- audit before/after, revision `n -> n+1`, candidate create ID;
- fault after registry/domain/audit and response loss recovery.

Representative pure assertion:

```rust
assert_eq!(draft_create_result.revision, 15);
assert_eq!(db.slider_count(candidate_id).await, 1);
assert_eq!(db.reference_count(asset_id).await, 1);
assert_eq!(db.domain_audit_count(audit_id).await, 1);
assert_eq!(replay.body["replayed"], true);
```

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd rust-api && cargo test slider_mutation_create -- --nocapture
cargo test slider_mutation_update -- --nocapture
```

Expected: FAIL because transaction orchestrator is absent.

- [ ] **Step 3: Implement read-only preflight and write transaction**

Order exactly:

1. permission + key + readiness + transaction probe;
2. normalize request and begin/resume claim;
3. authoritative read-only transaction validates revision/sensitivity;
4. missing proof returns step-up with claim still pre-transaction;
5. store recovery IDs and durable fence;
6. write transaction revalidates claim/revision/sensitivity;
7. asset acquire/swap, slider write, revision, sanitized audit, frozen result;
8. bounded commit-only retry and conservative recovery.

Use a single write transaction closure; never call it again after an ambiguous commit. Keep `mutationContract` absent after this task because archive/restore/reorder and legacy closures are not complete yet.

- [ ] **Step 4: Verify focused mutation tests**

Run:

```bash
cd rust-api && cargo test slider_mutation_create -- --nocapture
cargo test slider_mutation_update -- --nocapture
cargo test slider_idempotency -- --nocapture
cargo test managed_asset_registry -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/content/slider_mutation.rs rust-api/src/routes/content.rs rust-api/src/routes/content/sliders.rs rust-api/src/routes/content/slider_snapshot.rs rust-api/src/main.rs rust-api/src/services/audit_sanitize.rs rust-api/src/routes/mod.rs rust-api/src/services/local_fault.rs
git commit -m "feat: transact slider create and update"
```

---

### Task 10: Add archive, restore, reorder, limits under concurrency, and legacy route closure

**Files:**
- Modify: `rust-api/src/routes/content/slider_mutation.rs`
- Modify: `rust-api/src/routes/content/sliders.rs`
- Modify: `rust-api/src/routes/content/slider_policy.rs`
- Modify: `rust-api/src/routes/content/slider_snapshot.rs`
- Modify: `rust-api/src/main.rs`
- Modify: `rust-api/src/routes/mod.rs`
- Test: inline mutation/concurrency policy tests

**Interfaces:**
- Consumes: Task 9 orchestrator.
- Produces: archive/restore/reorder actions and explicit 405 legacy routes.

- [ ] **Step 1: Write RED lifecycle/reorder tests**

Cover:

- archive active => step-up, `status=false`, `lifecycle=archived`, reference released, current order compacted, revision +1;
- archive nonactive => no step-up;
- archive legacy-unmanaged => no decrement, audit `managedReferenceReleased=false`;
- restore => draft, append, reacquire, limit checked;
- restore missing/deleting/unregistered => no writes;
- reorder public relative change => step-up;
- draft-only reorder preserving public sequence => no step-up;
- reorder exact full current list and contiguous `0..n-1`;
- concurrent create/create, create/reorder, archive/reorder => deterministic one-winner/conflict and valid final order;
- DELETE and old sort-order => exact 405 codes.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd rust-api && cargo test slider_archive -- --nocapture
cargo test slider_restore -- --nocapture
cargo test slider_reorder -- --nocapture
```

Expected: FAIL because lifecycle/reorder actions are absent.

- [ ] **Step 3: Implement lifecycle/reorder in the same transaction protocol**

Archive/restore use current record before-state and exact reference behavior. Reorder writes all current sliders in the transaction, with global metadata serving as the conflict serialization point. Do not add unique `sortOrder` index. Close Rust old routes with static structured responses before dynamic route matching can capture them. Keep `mutationContract` absent through this task even when local Rust readiness is true; end-to-end gateway readiness is not established until Task 11.

- [ ] **Step 4: Verify lifecycle/concurrency tests**

Run:

```bash
cd rust-api && cargo test slider_archive -- --nocapture
cargo test slider_restore -- --nocapture
cargo test slider_reorder -- --nocapture
cargo test slider_concurrency -- --nocapture
cargo check --bin webtopup-rust-api
cd .. && git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/content/slider_mutation.rs rust-api/src/routes/content/sliders.rs rust-api/src/routes/content/slider_policy.rs rust-api/src/routes/content/slider_snapshot.rs rust-api/src/main.rs rust-api/src/routes/mod.rs
git commit -m "feat: add slider archive and ordering"
```

---

### Task 11: Wire Node gateway boundaries, split-deploy gate, and ETag forwarding

**Files:**
- Modify: `rust-api/src/routes/content/slider_snapshot.rs`
- Modify: `rust-api/src/routes/content/sliders.rs`
- Modify: `server/src/routes/apiV2ProxyRoutes.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/services/adminAuditService.ts`
- Modify: `server/src/services/adminAuditService.test.ts`
- Modify: `server/src/controllers/sliderController.ts`
- Modify: `server/src/routes/sliderRoutes.ts`
- Test: inline Rust capability-marker tests plus Node test files above

**Interfaces:**
- Consumes: Rust routes from Tasks 2, 9, 10.
- Produces: exact public/admin gateway contract; no client-trusted sensitivity decision.

- [ ] **Step 1: Write RED gateway route inventory tests**

Assert:

```ts
const mutationRoutes = [
  ['POST', '/sliders/admin/create'],
  ['PUT', '/sliders/admin/:id'],
  ['POST', '/sliders/admin/:id/archive'],
  ['POST', '/sliders/admin/:id/restore'],
  ['PUT', '/sliders/admin/reorder'],
];
```

Each requires authenticate, `manageSettings`, 64 KiB body limit, required valid Idempotency-Key, `acceptOptionalStepUp('settings.sensitive')`, trusted step-up stamp, then proxy. Tests must prove browser trusted/capability headers are stripped, same key survives auth retry, archive/restore routes precede dynamic routes, old DELETE/sort route returns exact 405 locally, and public route forwards `If-None-Match`/ETag/304/no-cache without body cache.

Define internal headers:

```text
x-webtopup-slider-contract-version: slider-revision-v1
x-webtopup-slider-contract-timestamp: <unix milliseconds>
x-webtopup-slider-contract-assertion: <lowercase hex HMAC-SHA256>
```

Only the new Node admin-read proxy generates them after authentication/permission and only toward trusted Rust. Build the exact MAC input as UTF-8:

```text
slider-contract-capability/v1
GET
<exact-canonical-upstream-path>
<timestamp>
<gateway-correlation-id>
```

Implementation constructs this value as `[version, method, path, timestamp, correlationId].join("\n")`: exactly four ASCII LF separators and no trailing LF. `path` is the actual selected canonical upstream path and must be exactly one of `/v2/sliders/admin/all` or `/v2/sliders/admin/archived`; prefixes, query-derived variants, normalized alternatives, and every other path are rejected. Compute HMAC-SHA256 under the existing `API_V2_PROXY_SECRET` shared only by Node and Rust. Rust first validates the existing proxy boundary, then requires exact version, decimal timestamp within ±30 seconds, the trusted gateway correlation ID selected for this request, constant-time MAC equality, exact GET method, and byte-exact equality between the signed path and actual request path. Only then, and only when local mutation readiness is true, may Rust emit `mutationContract`.

New Node removes every browser-provided header with these names before signing and overwrites rather than appends. Old Node cannot produce a valid MAC; a static browser capability header forwarded by an old/generic proxy must not enable the marker. Capability headers are never returned to clients or logged. Run the complete split-deploy table for both `/all` and `/archived`: new Rust + old/generic Node forwarding forged static headers => marker absent; old Rust + new Node => marker absent; new Rust + new Node but readiness false => marker absent; expired timestamp/wrong path/wrong correlation/wrong MAC => marker absent; only new/new/ready with a valid assertion for the exact current path => marker present. Explicitly prove an `/all` assertion on `/archived` and an `/archived` assertion on `/all` are rejected.

Add legacy controller source contract: `sliderRoutes` is never registered in `app.ts`.

- [ ] **Step 2: Run RED Rust/Node tests**

Run:

```bash
cd rust-api && cargo test slider_capability_marker -- --nocapture
cd ../server && node --import tsx --test src/routes/apiV2ProxyRoutes.test.ts src/services/adminAuditService.test.ts
```

Expected: FAIL because the handshake and new route inventory/gates/closures are absent.

- [ ] **Step 3: Implement minimal gateway boundary**

Reuse Site Config key validation middleware shape but keep slider-specific message/code. Node does not decide sensitivity; optional proof only stamps exact trusted group when a valid grant is supplied. Node creates the HMAC capability assertion with `createHmac('sha256', proxySecret)` and never synthesizes the response marker; it forwards only what Rust returns. Rust verifies with the existing `hmac`/`sha2`/`subtle` dependencies. Ensure CORS exposes ETag. Audit labels archive/restore/reorder as `Sliders` and continues sanitizing payloads.

- [ ] **Step 4: Run GREEN tests/build**

Run:

```bash
cd rust-api && cargo test slider_capability_marker -- --nocapture
cargo check --bin webtopup-rust-api
cd ../server && node --import tsx --test src/routes/apiV2ProxyRoutes.test.ts src/services/adminAuditService.test.ts src/middlewares/authMiddleware.test.ts
npm run build
cd .. && git diff --check
```

Expected: PASS and TypeScript build exits `0`.

- [ ] **Step 5: Commit**

```bash
git add rust-api/src/routes/content/slider_snapshot.rs rust-api/src/routes/content/sliders.rs server/src/routes/apiV2ProxyRoutes.ts server/src/routes/apiV2ProxyRoutes.test.ts server/src/app.ts server/src/services/adminAuditService.ts server/src/services/adminAuditService.test.ts server/src/controllers/sliderController.ts server/src/routes/sliderRoutes.ts
git commit -m "feat: gate revisioned slider routes"
```

---

### Task 12: Add pure client slider intent, capability, conflict, and error contracts

**Files:**
- Create: `client/src/lib/sliderManagement.ts`
- Create: `client/src/lib/sliderManagement.test.ts`
- Modify: `client/src/auth/withStepUp.ts`
- Test: `tools/dev-verification/unit/stepUpOrchestration.test.ts`

**Interfaces:**
- Produces:
  - `parseSliderAdminSnapshot(input): SliderAdminSnapshot | SliderLegacyReadOnlySnapshot`
  - `createSliderIntent(action, targetId, expectedRevision, payload, cryptoSource): SliderIntent`
  - `retrySameSliderIntent(intent): SliderIntent`
  - `rebaseSliderIntent(intent, nextRevision, payload, cryptoSource): SliderIntent`
  - `createSliderRequest(intent): { method, url, body, headers }`
  - `classifySliderConflict(base, draft, server)`
  - `sliderErrorMessage(error)` and `parseSliderVersionConflict(error)`.

- [ ] **Step 1: Write RED pure client tests**

```ts
test('legacy array is read-only and exact capability enables writes', () => {
  const legacy = parseSliderAdminSnapshot([]);
  assert.equal(legacy.versioned, false);
  assert.equal(legacy.mutationEnabled, false);
  const current = parseSliderAdminSnapshot({ mutationContract: 'slider-revision-v1', revision: 4, sliders: [], limits: fixtureLimits });
  assert.equal(current.mutationEnabled, true);
});

test('same intent survives step-up and replay but rebase creates a new key', () => { /* exact key assertions */ });

test('commit unknown never maps to retry copy', () => {
  assert.match(sliderErrorMessage(error('SLIDER_COMMIT_UNKNOWN')), /belum dapat dipastikan/i);
});
```

Add exact request body tests for create/update/archive/restore/reorder, nested errors, conflict snapshot parsing, and invalid present revision/marker fail-closed.

- [ ] **Step 2: Run RED tests**

Run: `cd client && node --import tsx --test src/lib/sliderManagement.test.ts`

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement pure client helper and step-up provenance test**

Keys are `slider_<crypto UUID>` and stable across `AUTH_STEP_UP_REQUIRED` retry. `createSliderRequest` always attaches exact key and never creates a legacy flat payload. `SLIDER_COMMIT_UNKNOWN` returns investigation state, not automatic retry.

- [ ] **Step 4: Verify pure tests**

Run:

```bash
cd client && node --import tsx --test src/lib/sliderManagement.test.ts
cd .. && node --import tsx --test tools/dev-verification/unit/stepUpOrchestration.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/sliderManagement.ts client/src/lib/sliderManagement.test.ts client/src/auth/withStepUp.ts tools/dev-verification/unit/stepUpOrchestration.test.ts
git commit -m "feat: define slider client intents"
```

---

### Task 13: Build an accessible dialog primitive and fix ImagePicker semantics

**Files:**
- Create: `client/src/components/admin/AccessibleDialog.tsx`
- Modify: `client/src/components/admin/ImagePicker.tsx`
- Modify: `client/src/components/admin/ImagePickerField.tsx`
- Test: `tools/dev-verification/unit/adminPageChrome.test.ts`
- Test: browser behavior completed in Task 16

**Interfaces:**
- Produces:
  - `AccessibleDialog({ open, titleId, descriptionId, initialFocusRef, returnFocusRef, parentDialogRef, busy, onClose, children })`
  - ImagePicker `restrictSelectionTo?: 'icons' | 'covers' | 'popups' | 'instructions'`.

- [ ] **Step 1: Write RED source/behavior contracts**

Add unit source contracts asserting `role="dialog"`, `aria-modal`, title/description IDs, Escape handler, Tab trap, body scroll restoration, return focus, parent inert handling, named close/delete controls, gallery `button`/`aria-pressed`, and no raw `confirm(`. Assert slider can browse all tabs but selection confirm is disabled when selected asset folder is not `covers`.

- [ ] **Step 2: Run RED test**

Run: `node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts`

Expected: FAIL on missing accessible dialog/ImagePicker contracts.

- [ ] **Step 3: Implement dialog and ImagePicker fixes**

Use refs and a single document keydown listener. Restore previous body overflow exactly. Parent dialog receives `inert` while picker is open. Render each image as a named button with filename, size, selection state, and separate named delete button. Delete confirmation is a nested accessible dialog; `ASSET_IN_USE` and nested server messages render in `role="alert"`.

- [ ] **Step 4: Verify source contracts and client build**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
npm --prefix client run build
git diff --check
```

Expected: PASS/build `0`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/admin/AccessibleDialog.tsx client/src/components/admin/ImagePicker.tsx client/src/components/admin/ImagePickerField.tsx tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "fix: make admin image dialogs accessible"
```

---

### Task 14: Rebuild `/admin/sliders` around revisioned snapshots and accessible lifecycle UX

**Files:**
- Modify: `client/src/pages/admin/Sliders.tsx`
- Modify: `client/src/auth/useStepUpOrchestration.tsx`
- Test: `client/src/lib/sliderManagement.test.ts`
- Test: `tools/dev-verification/unit/adminPageChrome.test.ts`

**Interfaces:**
- Consumes: Tasks 12–13.
- Produces: main/archive views, version gate, create/update/archive/restore/reorder intents, conflict/unknown UX, desktop table/mobile cards.

- [ ] **Step 1: Write RED UI state/source contracts**

Assert page contains exact marker gate copy, revision/capacity labels, `Aktif & Draft`/`Arsip`, no DELETE request, archive/restore endpoints, no legacy sort-order endpoint, nested error extraction, dialog-local alert, mobile Move Up/Down, reorder rollback snapshot, conflict controls, commit-unknown controls with no Retry Mutation, and contextual aria labels.

Extend pure conflict tests:

```ts
test('three-way slider conflict preserves draft-only fields and flags overlapping server edits', () => {
  const result = classifySliderConflict(base, draft, server);
  assert.equal(result.name, 'conflict');
  assert.equal(result.link, 'server-only');
  assert.equal(result.image, 'draft-only');
});
```

- [ ] **Step 2: Run RED tests**

Run:

```bash
cd client && node --import tsx --test src/lib/sliderManagement.test.ts
cd .. && node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
```

Expected: FAIL because page still uses legacy arrays/routes/dialogs.

- [ ] **Step 3: Implement revisioned admin UX**

Use a request ID for both main/archive loads. Disable all mutations when marker absent. For each action create one intent before first request and pass through `stepUp.run('settings.sensitive', ...)`; let Rust return step-up only when effective. On success update from frozen response snapshot/revision. On refresh failure retain proven success plus stale warning. Reorder saves previous list and rolls back immediately on failure.

Use `AccessibleDialog` for form/archive/restore/conflict. Keep dialog-local errors. Desktop table hidden below mobile breakpoint; mobile cards expose position and Move Up/Down. Image previews use desktop/mobile aspect boxes and broken-image state.

- [ ] **Step 4: Verify page tests/build**

Run:

```bash
cd client && node --import tsx --test src/lib/sliderManagement.test.ts
npm run build
cd .. && node --import tsx --test tools/dev-verification/unit/adminPageChrome.test.ts
git diff --check
```

Expected: PASS/build `0`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/Sliders.tsx client/src/auth/useStepUpOrchestration.tsx client/src/lib/sliderManagement.test.ts tools/dev-verification/unit/adminPageChrome.test.ts
git commit -m "feat: rebuild slider administration"
```

---

### Task 15: Isolate and harden the homepage carousel

**Files:**
- Create: `client/src/lib/sliderCarousel.ts`
- Create: `client/src/lib/sliderCarousel.test.ts`
- Create: `client/src/components/home/HomeSliderCarousel.tsx`
- Modify: `client/src/pages/Home.tsx`
- Test: pure tests above

**Interfaces:**
- Produces:
  - `normalizeSlideIndex(index, count): number`
  - `classifyPublicSliderLink(raw): { href: string | null; external: boolean }`
  - `shouldAutoRotate({ reducedMotion, userPaused, hovered, focusWithin, count }): boolean`
  - `swipeDirection(start, end, threshold): -1 | 0 | 1`
  - `HomeSliderCarousel({ sliders, defaultSlides })`.

- [ ] **Step 1: Write RED carousel tests**

```ts
test('inactive links are never interactive and auto rotation respects all pause sources', () => {
  assert.equal(shouldAutoRotate({ reducedMotion: true, userPaused: false, hovered: false, focusWithin: false, count: 3 }), false);
  assert.equal(shouldAutoRotate({ reducedMotion: false, userPaused: false, hovered: false, focusWithin: false, count: 3 }), true);
});

test('public links reject legacy http and dangerous internal paths', () => {
  assert.equal(classifyPublicSliderLink('http://example.com').href, null);
  assert.equal(classifyPublicSliderLink('/%2e%2e/admin').href, null);
  assert.equal(classifyPublicSliderLink('https://example.com').external, true);
});
```

Add count shrink/index normalization, swipe threshold/vertical dominance, and empty fallback cases.

- [ ] **Step 2: Run RED tests**

Run: `cd client && node --import tsx --test src/lib/sliderCarousel.test.ts`

Expected: FAIL because helper/component does not exist.

- [ ] **Step 3: Implement isolated carousel**

Render active slide anchor only; inactive slides are non-anchor containers with `inert` and `aria-hidden`. Decorative overlays use `pointer-events-none`; generic CTA layer stays above banner click layer. Add pause/play, focus/hover pause, reduced-motion media query, desktop/mobile controls, pointer swipe that ignores vertically dominant gestures, polite manual navigation announcement, and named fallback on image error.

- [ ] **Step 4: Verify pure tests/build**

Run:

```bash
cd client && node --import tsx --test src/lib/sliderCarousel.test.ts
npm run build
cd .. && git diff --check
```

Expected: PASS/build `0`.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/sliderCarousel.ts client/src/lib/sliderCarousel.test.ts client/src/components/home/HomeSliderCarousel.tsx client/src/pages/Home.tsx
git commit -m "fix: harden homepage slider carousel"
```

---

### Task 16: Seed disposable identities, closed fault inventory, and real slider integration proof

**Files:**
- Modify: `tools/dev-verification/seed.ts`
- Modify: `tools/dev-verification/unit/seed.test.ts`
- Modify: `tools/dev-verification/faults.ts`
- Modify: `tools/dev-verification/faultProxy.ts`
- Modify: `tools/dev-verification/unit/faults.test.ts`
- Modify: `tools/dev-verification/unit/faultProxy.test.ts`
- Modify: `rust-api/src/services/local_fault.rs`
- Create: `tools/dev-verification/integration/sliderManagement.test.ts`

**Interfaces:**
- Produces fixtures `slider-denied`, `slider-manager`, `slider-inactive`; closed scenarios:
  - `slider_transaction_probe_unavailable`
  - `slider_before_transaction_start`
  - `slider_after_claim_fence_before_write`
  - `slider_after_registry_write`
  - `slider_after_domain_write`
  - `slider_audit_failure`
  - `slider_commit_unknown_unresolved`
  - `slider_complete_during_commit_unknown_mark`
  - `slider_response_loss_after_commit`
  - `slider_frozen_response_oversize`
  - `slider_reference_count_mismatch`
  - `slider_unlink_failure`
  - `slider_revision_conflict`
  - `slider_create_contention`
  - `slider_order_contention`
  - `slider_limit_contention`.

- [ ] **Step 1: Write RED seed/fault/matrix-independent contracts**

Assert fixture permissions/status/TOTP, exact database marker, no balance/provider mutation capability, closed fault names, Rust-only vs gateway response-loss ownership, one-shot capability leases, and production guard rejection.

- [ ] **Step 2: Run RED unit tests**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/seed.test.ts tools/dev-verification/unit/faults.test.ts tools/dev-verification/unit/faultProxy.test.ts
```

Expected: FAIL on missing aliases/scenarios.

- [ ] **Step 3: Implement fixtures/faults and write real integration test**

`sliderManagement.test.ts` must:

1. assert exact disposable marker/database/replica set;
2. login real denied/manager/inactive users;
3. upload real small PNG/WebP through `/api/v2/upload?type=covers`;
4. execute a table-driven Node permission matrix across `GET /admin/all`, `GET /admin/archived`, create, update, archive, restore, reorder, hard-delete closure, and legacy sort-order closure: anonymous => `401 AUTH_TOKEN_INVALID`, denied => `403 PERMISSION_DENIED`, inactive => `403 AUTH_ACCOUNT_DISABLED`, and authorized => reads `200`, legacy closures `405` with exact closure code, while invalid mutation fixtures reach Rust and return `400`/the action-specific validation code rather than `403`; run the equivalent direct trusted-Rust matrix with anonymous `401`, denied/inactive `403` and exact sanitized message, and authorized handler reachability; separately assert public GET remains anonymous;
5. exercise create/update/activate/deactivate/archive/restore/reorder;
6. verify stable key replay/conflict, stale revision, limits/concurrency, and digest changes for contract/operator/action/target/revision/payload;
7. query Mongo for claims, revision, reference rows/counts, audit before/after;
8. parameterize intended legacy cover writers (`producttypes.cover`, `flashsales.banner`, `articles.image`, `rewards.imageUrl`) and prove each effective write increments the same asset's `acquisitionFenceVersion` while preserving its durable legacy reference;
9. run a synchronized writer-versus-delete race: first scan sees zero, writer commits, deletion transaction conflicts/retries, retry reruns the scan, and final response is `409 ASSET_IN_USE` with asset still `available`;
10. prove per-folder readiness enables `covers` only while `icons`, `popups`, and `instructions` deletion returns `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE`; also prove an injected not-ready covers writer keeps covers deletion fail closed;
11. activate every fault, including post-fence crash, complete-during-unknown-mark, and separate create/order/limit contention; assert the write closure is never rerun, post-fence claim is never reclaimable, and completed frozen result cannot be overwritten;
12. verify public ETag/list/304/legacy sanitization;
13. cleanup slider/asset/claims/audits and non-slider cover fixtures only by marked synthetic IDs.

Use `crypto.randomUUID()` fixture suffixes and never hard-code real production IDs.

- [ ] **Step 4: Run GREEN unit tests and focused integration**

Run unit tests first. With disposable host up, run:

```bash
node --import tsx --test tools/dev-verification/integration/sliderManagement.test.ts
```

Expected: PASS. Test output must name required subproofs `covers-writer-fence`, `covers-delete-race-rescan`, `folder-readiness-fail-closed`, `post-fence-nonreclaimable`, and `complete-wins-unknown-mark`; absence of any named assertion fails the matrix check. If host is down, start only the approved disposable lifecycle; never point the test at production.

- [ ] **Step 5: Commit**

```bash
git add tools/dev-verification/seed.ts tools/dev-verification/unit/seed.test.ts tools/dev-verification/faults.ts tools/dev-verification/faultProxy.ts tools/dev-verification/unit/faults.test.ts tools/dev-verification/unit/faultProxy.test.ts rust-api/src/services/local_fault.rs tools/dev-verification/integration/sliderManagement.test.ts
git commit -m "test: prove slider transaction foundation"
```

---

### Task 17: Add desktop/mobile Playwright, smoke, matrix, full verification, and independent review

**Files:**
- Create: `tools/dev-verification/e2e/sliders.spec.ts`
- Create: `tools/dev-verification/e2e/home-slider.spec.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`
- Modify: `tools/dev-verification/unit/verificationMatrix.test.ts`
- Modify: `scripts/smoke/api-v2-read-smoke.js`
- Modify: `scripts/smoke/api-v2-mutation-smoke.js`
- Modify: `tools/dev-verification/README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: required matrix checks `slider-management`, `sliders-desktop`, `sliders-mobile`, `home-slider-desktop`, and `home-slider-mobile`.

- [ ] **Step 1: Write RED matrix and browser specs**

Matrix assertions must require:

```ts
assertCheck('slider-management', 'session-cs-fault', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/sliderManagement.test.ts']);
// The integration TAP output must include all five required subproof names from Task 16;
// matrix verification rejects a passing exit code whose proof labels are incomplete.
assertBrowser('sliders', 'chromium-desktop', 'session-cs-fault');
assertBrowser('sliders', 'chromium-mobile', 'session-cs-fault');
assertBrowser('home-slider', 'chromium-desktop', 'session-cs');
assertBrowser('home-slider', 'chromium-mobile', 'session-cs');
```

Admin Playwright must verify marker read-only gate, create draft, active publish step-up using same key, nested ImagePicker keyboard selection, edit/archive/restore, conflict draft preservation, commit-unknown no-retry state, mobile cards/Move Up/Down, focus trap/Escape/restoration/inert/live regions.

Homepage Playwright must seed active/inactive synthetic sliders and verify only active rendering, entire intended banner click layer, generic CTA independence, external rel, hidden slide no focus, pause/play, reduced-motion default, mobile previous/next/indicator/swipe, and broken-image fallback.

- [ ] **Step 2: Run RED matrix/source tests**

Run:

```bash
node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts
npx playwright test --config tools/dev-verification/playwright.config.ts sliders.spec.ts --project=chromium-desktop --workers=1
```

Expected: matrix FAIL until checks are added; browser test FAIL until complete behavior/fixtures are wired.

- [ ] **Step 3: Implement matrix/smoke/docs and stabilize browser tests conditionally**

Mutation smoke must upload a valid generated PNG/WebP and use returned URLs; remove every `smoke-slider.svg` assumption. Smoke uses revisioned bodies and permanent unique keys, restores synthetic state through archive/restore or transaction-safe cleanup, and asserts public ETag. Do not increase arbitrary timeouts; wait for response/status/UI conditions and clear only synthetic fixture sessions.

- [ ] **Step 4: Run focused complete verification**

Run:

```bash
npm run test:dev-verify:unit
npm --prefix client run build
npm --prefix server run build
npm run api-v2:build
cd rust-api && cargo build --release --bin webtopup-rust-api --bin slider_managed_asset_readiness && cd ..
node --import tsx --test tools/dev-verification/integration/sliderManagement.test.ts
npx playwright test --config tools/dev-verification/playwright.config.ts sliders.spec.ts home-slider.spec.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts sliders.spec.ts home-slider.spec.ts --project=chromium-mobile --workers=1
RUN_API_V2_MUTATION_SMOKE=1 REQUIRE_MUTATION_SMOKE_MONGO=1 npm run api-v2:smoke:mutations
npm run api-v2:smoke
```

Run the full matrix and teardown through an unconditional shell block. Preserve the primary matrix failure and separately report teardown failure:

```bash
primary=0
npm run dev-verify -- test || primary=$?
teardown=0
npm run dev-verify -- down || teardown=$?
status=$(npm run -s dev-verify -- infra-status) || teardown=$?
printf '%s\n' "$status"
printf '%s' "$status" | grep -q '"serviceCount":0' || teardown=1
if [ "$primary" -eq 0 ]; then
  node -e 'const fs=require("fs"); const p=".dev-verification/reports/aggregate.json"; if (!fs.existsSync(p)) process.exit(1); const r=JSON.parse(fs.readFileSync(p,"utf8")); if (r.result !== "LOCAL DEV VERIFIED" || !Array.isArray(r.checks) || r.checks.some(c => c.required && c.result !== "LOCAL DEV VERIFIED")) process.exit(1);' || primary=$?
fi
if [ "$primary" -ne 0 ]; then exit "$primary"; fi
exit "$teardown"
```

Expected:

- all build/focused commands exit `0`;
- full harness reports `LOCAL DEV VERIFIED`;
- report has no failed checks;
- `down` runs after both success and failure;
- final parsed status contains exactly `"serviceCount":0`.

If full matrix exposes unrelated failures, follow systematic debugging and report them separately; do not weaken slider/auth/security assertions.

- [ ] **Step 5: Request independent read-only review and fix only verified findings**

Review scope:

- transaction/claim/commit-unknown correctness;
- managed asset race closure and writer inventory;
- permission/step-up/gateway route order;
- public DTO/ETag/split deploy;
- archive/restore/limits/order concurrency;
- dialog/ImagePicker/carousel accessibility;
- disposable proof completeness and production isolation.

After fixes, rerun affected focused tests and the full verification/teardown gate.

- [ ] **Step 6: Commit**

```bash
git add tools/dev-verification/e2e/sliders.spec.ts tools/dev-verification/e2e/home-slider.spec.ts tools/dev-verification/verificationMatrix.ts tools/dev-verification/unit/verificationMatrix.test.ts scripts/smoke/api-v2-read-smoke.js scripts/smoke/api-v2-mutation-smoke.js tools/dev-verification/README.md
git commit -m "test: verify slider management foundation"
```

---

## Milestone review gates

- **Milestone A — Policy and registry:** Tasks 1–7. Review normalization, stable reads, registry correctness, writer inventory, deletion race closure, and readiness safety before claims/mutations.
- **Milestone B — Transaction service:** Tasks 8–10. Review permanent claims, step-up preflight, write transaction, archive/restore, concurrency, audit, and commit recovery before gateway/client changes.
- **Milestone C — Gateway and client:** Tasks 11–15. Review split-deploy gate, exact route order, stable intents, accessibility, mobile UI, and homepage carousel before broad integration.
- **Milestone D — Disposable proof:** Tasks 16–17. Require focused proof, full matrix, independent review, and teardown before completion.

## Production operations deliberately excluded from execution

Do not include any of the following in implementation execution without a new explicit approval:

- production readiness scan;
- production registry registration or repair;
- production index creation;
- production MongoDB lifecycle/reference migration;
- service restart or deployment;
- production authenticated mutation smoke;
- GitHub push or PR;
- deletion of production uploads or slider records.

The plan may produce tooling and documented rollout commands, but execution ends after disposable verification and review.
