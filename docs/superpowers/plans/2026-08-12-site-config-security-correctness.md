# Site Config Security and Correctness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared uploads content-verified and reference-safe, make local transaction references and guest invoices collision-safe, and make `/admin/site-config` writes revision-checked, permanently idempotent, step-up protected when sensitive, transaction-only, atomically audited, and publicly revalidated by authoritative ETag.

**Architecture:** Rust owns image decoding, managed-asset reference checks, identifier integrity, authoritative settings validation, MongoDB transaction state, revision, audit, and idempotency. Node preserves the authentication/CSRF/trusted-proxy boundary, validates the Site Config idempotency header, optionally verifies a `settings.sensitive` grant, and transparently forwards public ETag revalidation without a response-body cache. The React page uses a pure mutation-state helper to retain one save intent across step-up/replay and preserve drafts on conflicts, while the disposable harness proves real-session behavior against the marked replica-set database.

**Tech Stack:** React 19, TypeScript, Axios, Zustand, Fastify 4, Mongoose 8, Node test runner, Rust 1.97/Axum 0.8, MongoDB Rust driver 3.x, `image` 0.25.10 with only JPEG/PNG/WebP features, MongoDB replica-set transactions, Playwright 1.61, existing disposable verification harness.

## Global Constraints

- Work on the existing `main` checkout only if inline execution is selected; do not create a worktree without renewed user approval. Subagent-driven execution may use the harness-managed isolation only after the user selects it.
- Use strict TDD for every task: write the failing test, run it and observe the intended failure, implement the minimum production behavior, rerun focused tests, run `git diff --check`, then commit.
- Specification authority: `docs/superpowers/specs/2026-08-12-site-config-security-correctness-design.md` at or after commit `9f0d9e9`.
- Preserve Node authentication, database-backed active-account checks, Rust trusted-proxy verification, database-backed permission resolution, effective team access, CSRF, credential cookies, refresh semantics, 2FA enrollment, request correlation, rate limits, trusted header stripping, and route ordering.
- Keep `manageSettings` at both Node and Rust for Site Config admin reads and writes. Do not widen upload folder permission mappings.
- The trusted step-up action group is exactly `settings.sensitive`. Browser-provided step-up groups and trusted proxy headers remain untrusted and must be stripped.
- Every Site Config PUT requires a valid `Idempotency-Key`. Claims are permanent and bind exact normalized key, operator, `expectedRevision`, and canonical SHA-256 payload digest.
- Site Config mutation is MongoDB-transaction-only. When disabled or unavailable return `503 SETTINGS_TRANSACTIONS_UNAVAILABLE`; do not write a claim, setting, revision, or audit row and do not fall back to the legacy Node controller.
- Commit-unknown handling is conservative. Never run a second mutation, reclaim an ambiguous claim, or apply manual rollback when absence is not proven.
- Upload input and encoded output are each at most 5,242,880 bytes. Multiple upload accepts at most 10 files and 20,971,520 aggregate input bytes. Width and height are each at most 4096; total decoded pixels are at most 16,777,216. New uploads accept only JPEG, PNG, and WebP.
- Existing GIF files remain serveable. Do not migrate, rewrite, scan, or delete production files.
- `referenceId` is the immutable local balance-transaction reference. `vendorTrxId` remains provider-owned and must never overwrite `referenceId`.
- Ref ID allocation uses one atomic counter per WIB date and requires exact unique identifier indexes. It does not fall back to `count_documents`.
- Ref ID date format must be date-bearing: writes reject `NONE`; historical missing/malformed/`NONE` reads and transaction-format loads use `DDMMYYYY` without read-time persistence. Unrelated saves do not repair raw storage; only an explicit effective change to an allowed date-bearing format may do so. Invoice date format may still be `NONE`.
- Invoice random policy is alphanumeric 8–12 or numeric 10–12, with at most five retries only for an exact duplicate on the reviewed `invoiceNumber` index.
- Identifier readiness is dry-run by default. Automated index apply is permitted only when the parsed database name is exactly `webtopup_task14_dev`; there is no protected-database override in automated verification.
- Public settings have no Node response-body cache. They use `Cache-Control: no-cache` and strong ETag syntax `"site-settings-<revision>"` derived only from Rust's authoritative revision.
- Gateway and Rust domain audit events remain separate rows. Do not deduplicate them.
- All automated mutation uses marked synthetic fixtures in `webtopup_task14_dev`, loopback MongoDB `127.0.0.1:27018`, replica set `rs0`, and mock provider mode. Never read or mutate production data.
- Do not install OS packages. Adding the reviewed pure-Rust Cargo dependency is allowed by the approved design; do not broaden default features.
- Do not run production readiness checks, create production indexes, repair production identifiers, deploy, restart production, push, or open a PR without separate approval.
- `cargo fmt --check` remains unavailable while `rustfmt` is not installed. Report the limitation; do not install it without approval.
- Context7 documentation used for this plan: `/image-rs/image` and `/websites/rs_image` for content detection, strict dimension limits, orientation, and encoders; `/mongodb/docs-rust` for driver 3.x session-aware operations, commit retry labels, and unique indexes.

---

## File structure and responsibility map

### Create

- `rust-api/src/routes/uploads/policy.rs` — canonical byte, format, dimension, pixel, decode, orientation, re-encode, and error policy shared by single/multiple upload.
- `rust-api/src/routes/uploads/publication.rs` — same-filesystem staging, RAII cleanup guards, atomic publication, and all-or-nothing batch rollback.
- `rust-api/src/services/managed_assets.rs` — managed upload URL normalization, existence validation, and database reference registry/counting.
- `rust-api/src/services/audit_sanitize.rs` — shared Rust BSON audit sanitizer moved from the audit-log disclosure module so settings persistence and audit list/export use one policy.
- `rust-api/src/services/identifier_integrity.rs` — exact index models/checks, WIB counter allocation/format helpers, immutable reference construction, invoice entropy policy, and duplicate constraint classification.
- `rust-api/src/bin/site_config_identifier_readiness.rs` — dry-run readiness report and disposable-only exact index apply.
- `rust-api/src/routes/settings/snapshot.rs` — revision metadata constants and bounded revision-before/settings/revision-after consistent reads.
- `rust-api/src/routes/settings/policy.rs` — bulk request normalization, effective changes, sensitive-key classification, canonical payload serialization/digest, and conflict snapshots.
- `rust-api/src/routes/settings/idempotency.rs` — permanent claim model, indexes, lease/fencing, binding, replay, conflict, commit-unknown resolution, and frozen response bounds.
- `rust-api/src/routes/settings/mutation.rs` — transaction-only Site Config orchestration, atomic settings/revision/audit/claim writes, and conservative commit protocol.
- `client/src/lib/siteConfigMutation.ts` — pure revision parsing, changed payload creation, intent key lifecycle, three-way conflict classification, and error-copy helpers.
- `client/src/lib/siteConfigMutation.test.ts` — pure client mutation contract tests.
- `tools/dev-verification/unit/stepUpOrchestration.test.ts` — shared orchestrator provenance and stable-key retry tests for Rust-originated Site Config step-up.
- `tools/dev-verification/integration/uploadSecurity.test.ts` — real-session content validation, batch cleanup, managed reference, and deletion checks.
- `tools/dev-verification/integration/identifierIntegrity.test.ts` — disposable readiness/index, invoice collision, and parallel reference checks.
- `tools/dev-verification/integration/siteConfigFoundation.test.ts` — real-session permission, revision, step-up, idempotency, transaction-disabled, replay, conflict, audit, and ETag checks.
- `tools/dev-verification/e2e/site-config-foundation.spec.ts` — desktop/mobile Site Config mutation, step-up, replay, conflict, uncertain result, image-error, and request-count flows.

### Modify

- `rust-api/Cargo.toml` and `rust-api/Cargo.lock` — add `image = { version = "=0.25.10", default-features = false, features = ["jpeg", "png", "webp"] }`.
- `rust-api/src/services/mod.rs` and `rust-api/src/lib.rs` — expose shared managed-asset and identifier-integrity services to the API binary and readiness binary.
- `rust-api/src/routes/uploads.rs`, `uploads/handlers.rs`, `uploads/storage.rs`, `uploads/types.rs`, `uploads/validation.rs` — route all writes through the canonical policy/publication pipeline and guard deletion.
- `rust-api/src/routes/products/payload.rs`, `taxonomy/categories.rs`, `taxonomy/operators.rs`, `taxonomy/product_types.rs`, `payment/validation.rs`, `payment/categories.rs`, `content/sliders.rs`, `content/flash_payload.rs`, `articles.rs`, `rewards/validation.rs` — reject managed upload references whose target file does not exist before committing active resource mutations.
- `rust-api/src/routes/settings.rs`, `settings/defaults.rs`, `settings/conversion.rs`, `settings/store.rs`, `settings/types.rs`, `settings/validation.rs` — versioned reads, safe invoice defaults, bulk contract, effective policy, and transaction orchestration.
- `rust-api/src/routes/audit_logs.rs`, `audit_logs/mappers.rs`, and `audit_logs/export.rs` — consume the shared audit sanitizer after `audit_logs/sanitize.rs` is removed/moved, preserving disclosure behavior.
- `rust-api/src/routes/transactions.rs`, `transactions/types.rs`, `transactions/json.rs`, `transactions/list.rs`, `transactions/csv.rs`, `transactions/provider.rs`, `transactions/status.rs`, and `rust-api/src/routes/open_api/create.rs` — immutable `referenceId` for both active balance-transaction insert paths, atomic counter/insert boundary, serialization, labels, index gate, and commit resolution.
- `rust-api/src/routes/guest_transactions/checkout.rs`, `guest_transactions/public.rs`, `guest_transactions/types.rs`, `guest_transactions/mappers.rs` — safe invoice policy, first-write candidate reservation, exact duplicate retry, and index gate.
- `rust-api/src/routes/mod.rs` — single-setting PUT closure and upload body ceiling scoped above the 5 MiB application limit.
- `rust-api/src/routes/auth/step_up.rs`, `rust-api/src/security_hardening_checks.rs`, `rust-api/src/services/local_fault.rs` — action group, trusted proof tests, security source contracts, and guarded disposable fault seams.
- `server/src/middlewares/stepUp.ts`, `server/src/middlewares/authMiddleware.test.ts` — action group and optional exact grant middleware.
- `server/src/routes/apiV2ProxyRoutes.ts`, `server/src/routes/apiV2ProxyRoutes.test.ts` — Site Config idempotency gate, optional step-up stamping, single-PUT closure, public ETag forwarding, and removal of public body cache.
- `server/src/app.ts` — expose `ETag` through CORS and retain the 5 MiB multipart boundary.
- `server/src/models/Transaction.ts` — add immutable `referenceId` shape/index parity for active Node tooling.
- `client/src/auth/stepUp.ts`, `client/src/auth/withStepUp.ts`, `client/src/components/auth/StepUpDialog.tsx` — register/explain `settings.sensitive` and make shared retry provenance honest for Rust-originated step-up responses protected by stable idempotency.
- `client/src/pages/admin/SiteConfig.tsx` — versioned bulk save, stable key per intent, step-up, conflict/uncertain states, safe invoice limits, and accurate public-freshness copy.
- `client/src/components/admin/ImagePicker.tsx` — visible API policy/list/delete errors and accepted-format copy; full modal redesign remains deferred.
- `client/src/pages/admin/Transactions.tsx`, `client/src/pages/admin/ManualTransactions.tsx`, `client/src/pages/Transactions.tsx`, and shared transaction types — distinguish `referenceId` from `vendorTrxId` wherever new references appear.
- `tools/dev-verification/seed.ts`, `tools/dev-verification/unit/seed.test.ts`, `tools/dev-verification/e2e/fixtures.ts` — denied/active/inactive Site Config fixtures, synthetic identifier-ready records, and synthetic TOTP.
- `tools/dev-verification/faults.ts`, `faultProxy.ts`, `processes.ts`, `unit/faultProxy.test.ts`, `unit/processes.test.ts` — guarded Site Config response-loss and unresolved-commit fault behavior, disposable-only exact identifier-index preflight before host traffic, and disabled-transaction subprocess support.
- `tools/dev-verification/verificationMatrix.ts`, `unit/verificationMatrix.test.ts` — mandatory isolated upload, identifier, Site Config integration, and desktop/mobile checks.
- `tools/dev-verification/integration/mongo.test.ts`, `unit/rustStartupIndexes.test.ts` — exact index/readiness contracts without production auto-create.
- `package.json` — include the pure Site Config mutation test in the canonical unit command and add a readable readiness script.
- `scripts/smoke/api-v2-mutation-smoke.js` — update the Site Config mutation body/header contract without making live production changes.
- `docs/superpowers/specs/2026-08-12-site-config-security-correctness-design.md` — retain only consistency corrections discovered during implementation planning.

---

### Task 1: Define and verify the canonical image policy

**Files:**
- Modify: `rust-api/Cargo.toml`
- Modify: `rust-api/Cargo.lock`
- Create: `rust-api/src/routes/uploads/policy.rs`
- Modify: `rust-api/src/routes/uploads.rs`
- Modify: `rust-api/src/routes/uploads/types.rs`
- Modify: `rust-api/src/routes/uploads/validation.rs`

**Interfaces:**
- Produces: `pub const MAX_UPLOAD_BYTES: usize = 5 * 1024 * 1024`.
- Produces: `pub const MAX_IMAGE_DIMENSION: u32 = 4096` and `pub const MAX_IMAGE_PIXELS: u64 = 16_777_216`.
- Produces upload batch constants `MAX_UPLOAD_BATCH_FILES: usize = 10` and `MAX_UPLOAD_BATCH_BYTES: usize = 20 * 1024 * 1024`.
- Produces: `pub enum CanonicalImageFormat { Jpeg, Png, WebP }` with `extension()` and `content_type()`.
- Produces: `pub struct CanonicalImage { pub bytes: Vec<u8>, pub format: CanonicalImageFormat, pub width: u32, pub height: u32 }`.
- Produces: `pub enum ImagePolicyError` mapping exactly to the approved API codes.
- Produces: `pub fn validate_and_reencode_image(input: &[u8]) -> Result<CanonicalImage, ImagePolicyError>`.
- Consumes: image 0.25.10 `ImageReader`, strict `Limits`, `JpegEncoder`, `PngEncoder`, and lossless `WebPEncoder` from the reviewed docs.

- [ ] **Step 1: Write failing policy tests before adding the dependency**

At the bottom of `rust-api/src/routes/uploads/policy.rs`, define fixture generators using encoders rather than committing binary secrets or large files. The tests must include this contract:

```rust
#[test]
fn canonical_policy_accepts_only_jpeg_png_and_webp_by_content() {
    for (format, extension) in [
        (CanonicalImageFormat::Jpeg, "jpg"),
        (CanonicalImageFormat::Png, "png"),
        (CanonicalImageFormat::WebP, "webp"),
    ] {
        let source = fixture_image(format, 2, 2, true);
        let canonical = validate_and_reencode_image(&source).unwrap();
        assert_eq!(canonical.format, format);
        assert_eq!(canonical.format.extension(), extension);
        assert_eq!((canonical.width, canonical.height), (2, 2));
        assert!(canonical.bytes.len() <= MAX_UPLOAD_BYTES);
    }
}

#[test]
fn canonical_policy_rejects_spoofed_truncated_gif_and_excessive_inputs() {
    assert_eq!(validate_and_reencode_image(b"not-an-image").unwrap_err().code(), "UNSUPPORTED_IMAGE_FORMAT");
    assert_eq!(validate_and_reencode_image(&[0xff, 0xd8, 0xff]).unwrap_err().code(), "INVALID_IMAGE_CONTENT");
    assert_eq!(validate_and_reencode_image(b"GIF89a").unwrap_err().code(), "UNSUPPORTED_IMAGE_FORMAT");
    assert_eq!(validate_and_reencode_image(&vec![0; MAX_UPLOAD_BYTES + 1]).unwrap_err().code(), "UPLOAD_TOO_LARGE");
}
```

Add generated header/dimension cases that assert:

- width 4097 → `IMAGE_DIMENSIONS_EXCEEDED`;
- height 4097 → `IMAGE_DIMENSIONS_EXCEEDED`;
- dimensions whose checked product exceeds 16,777,216 → `IMAGE_PIXEL_LIMIT_EXCEEDED`;
- a deterministic encoder test seam that returns output above 5 MiB → `ENCODED_IMAGE_TOO_LARGE`;
- JPEG orientation is applied before metadata is removed when the decoder exposes orientation;
- PNG and WebP alpha values survive re-encode;
- supplied filename/MIME are absent from the policy signature and cannot affect format.

- [ ] **Step 2: Run RED and record the missing interface**

Run:

```bash
cd rust-api
cargo test --bin webtopup-rust-api routes::uploads::policy --no-fail-fast
```

Expected RED: module/types/functions or `image` dependency are unresolved.

- [ ] **Step 3: Add the minimum reviewed dependency and implement bounded decoding**

Add exactly:

```toml
image = { version = "=0.25.10", default-features = false, features = ["jpeg", "png", "webp"] }
```

Implement content detection with `image::guess_format(input)` and accept only `ImageFormat::Jpeg`, `ImageFormat::Png`, or `ImageFormat::WebP`. Construct the reader from `Cursor<&[u8]>`, set the detected format explicitly, and apply:

```rust
let mut limits = image::Limits::default();
limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
limits.max_alloc = Some((MAX_IMAGE_PIXELS * 4).min(u64::MAX));
reader.limits(limits);
```

Construct two readers over the same bounded in-memory bytes. Use the first reader's exact stable `ImageReader::into_dimensions()` API before full decode, then perform an independent checked `u64::from(width) * u64::from(height)` limit check. For the second reader call `ImageReader::into_decoder()`, then `ImageDecoder::orientation(&mut decoder)`, then `DynamicImage::from_decoder(decoder)`, and finally `DynamicImage::apply_orientation(orientation)`. This is the pinned image 0.25.10 API verified from local crate source. Do not copy EXIF/XMP/ICC metadata into output.

Encode deterministically:

```rust
match format {
    CanonicalImageFormat::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88),
    CanonicalImageFormat::Png => image::codecs::png::PngEncoder::new(&mut out),
    CanonicalImageFormat::WebP => image::codecs::webp::WebPEncoder::new_lossless(&mut out),
}
```

Convert the decoded image to the encoder-supported RGB/RGBA shape intentionally. Check output length before returning.

- [ ] **Step 4: Map policy failures to stable API envelopes**

In `uploads/types.rs`, add:

```rust
#[derive(Serialize)]
pub struct UploadErrorEnvelope {
    pub error: UploadErrorBody,
}

#[derive(Serialize)]
pub struct UploadErrorBody {
    pub code: &'static str,
    pub message: &'static str,
}
```

Give `ImagePolicyError` an `IntoResponse` implementation returning `400` for policy errors. `UPLOAD_STORAGE_FAILED` is not emitted by this pure module.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
cd rust-api
cargo test --bin webtopup-rust-api routes::uploads::policy --no-fail-fast
cargo test --lib --no-fail-fast
cd ..
git diff --check
```

Expected: all policy tests pass; lockfile contains image 0.25.10 with no GIF feature.

- [ ] **Step 6: Commit Task 1**

```bash
git add rust-api/Cargo.toml rust-api/Cargo.lock rust-api/src/routes/uploads.rs rust-api/src/routes/uploads/policy.rs rust-api/src/routes/uploads/types.rs rust-api/src/routes/uploads/validation.rs
git commit -m "fix: validate uploaded image content"
```

---

### Task 2: Stage and publish single/multiple uploads atomically

**Files:**
- Create: `rust-api/src/routes/uploads/publication.rs`
- Modify: `rust-api/src/routes/uploads.rs`
- Modify: `rust-api/src/routes/uploads/handlers.rs`
- Modify: `rust-api/src/routes/uploads/storage.rs`
- Modify: `rust-api/src/routes/uploads/types.rs`
- Modify: `rust-api/src/routes/mod.rs`

**Interfaces:**
- Consumes: `validate_and_reencode_image(&[u8]) -> Result<CanonicalImage, ImagePolicyError>` from Task 1.
- Produces: `pub struct StagedUpload` whose `Drop` removes an unpublished temporary file.
- Produces: `pub fn stage_canonical_image(root: &Path, folder: &str, image: CanonicalImage) -> Result<StagedUpload, UploadStorageError>`.
- Produces: `pub fn publish_batch(staged: Vec<StagedUpload>) -> Result<Vec<PublishedUpload>, UploadStorageError>`.
- Produces: `async fn read_bounded_field(field: Field<'_>) -> Result<Vec<u8>, ImagePolicyError>`.

- [ ] **Step 1: Add failing RAII and all-or-nothing tests**

Create tests with an isolated temp root beneath `std::env::temp_dir()` and random marker. Cover:

```rust
#[test]
fn dropped_staged_upload_removes_private_temp_file() {
    let root = fixture_upload_root();
    let staged = stage_canonical_image(&root, "icons", fixture_canonical_png()).unwrap();
    let temp = staged.temp_path().to_path_buf();
    assert!(temp.exists());
    drop(staged);
    assert!(!temp.exists());
}

#[test]
fn failed_batch_publication_removes_only_files_from_that_batch() {
    let root = fixture_upload_root();
    let existing = create_existing_public_file(&root, "icons", "existing.png");
    let staged = vec![valid_staged(&root, "icons"), forced_publish_failure(&root, "icons")];
    assert!(publish_batch(staged).is_err());
    assert!(existing.exists());
    assert!(public_batch_files(&root).is_empty());
    assert!(private_stage_files(&root).is_empty());
}
```

Add handler-level tests for:

- a file whose browser MIME says PNG but bytes are JPEG publishes `.jpg`;
- GIF returns `UNSUPPORTED_IMAGE_FORMAT`;
- single upload leaves no temp/public file after decode or storage failure;
- multiple upload with valid + invalid returns one error and no published batch files;
- the 11th file or aggregate byte 20,971,521 returns `UPLOAD_BATCH_LIMIT_EXCEEDED` and publishes nothing;
- empty multiple upload returns `400` rather than success with an empty array;
- client basename never appears in final filename;
- public response shape remains `{ success, url, filename }` / `{ success, files }`.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api routes::uploads::publication --no-fail-fast
cargo test --bin webtopup-rust-api routes::uploads::handlers --no-fail-fast
```

Expected RED: staged/publication APIs are absent and handlers still write raw bytes directly.

- [ ] **Step 3: Implement private same-filesystem staging**

Use a private sibling under the configured upload root's parent, not a publicly served folder:

```text
<UPLOAD_DIR parent>/.webtopup-upload-staging/
```

Create the staging directory with restrictive permissions where supported. Generate the final basename from timestamp/random bytes plus `CanonicalImageFormat::extension()`. Write with `OpenOptions::create_new(true)`, `write_all`, and `sync_all`; close before rename. Ensure the final folder exists. `StagedUpload` owns temp path, final path, public URL, and a `published` flag.

Use `std::fs::rename` only on the same filesystem. If rename fails, return `UPLOAD_STORAGE_FAILED`; do not copy into the public tree as a fallback.

- [ ] **Step 4: Refactor handlers through one bounded pipeline**

Replace `field.bytes()` and MIME checks with a bounded chunk loop that reads at most `MAX_UPLOAD_BYTES + 1`. Call the Task 1 policy and Task 2 staging function.

For multiple upload, track file count and aggregate bytes before staging; stop at 10 files or 20,971,520 bytes and return `UPLOAD_BATCH_LIMIT_EXCEEDED`. Collect every staged item, fail on the first invalid field, then call one `publish_batch`. If publication partially succeeds, remove only the final paths recorded by that batch and every remaining temp file.

Scope Axum upload routes with separate total-request ceilings so handler limits remain authoritative without raising unrelated routes:

```rust
.route(
    "/v2/upload",
    post(uploads::upload_file)
        .delete(uploads::delete_file)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
)
.route(
    "/v2/upload/multiple",
    post(uploads::upload_multiple)
        .layer(DefaultBodyLimit::max(24 * 1024 * 1024)),
)
```

The 24 MiB multiple-request ceiling allows the approved 20 MiB aggregate file content plus bounded multipart framing; it is not the business limit. The handler still stops at 10 files or exactly 20,971,520 aggregate file bytes. Keep Node's 5 MiB multipart `fileSize` unchanged as a per-file boundary. Add route tests proving a batch above 8 MiB but at or below the 20 MiB handler aggregate reaches the handler successfully, while 20,971,521 file bytes fail with `UPLOAD_BATCH_LIMIT_EXCEEDED` and an oversized framed request is rejected by the scoped 24 MiB parser ceiling.

- [ ] **Step 5: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api routes::uploads --no-fail-fast
cargo test --lib --no-fail-fast
cd ..
npm --prefix server run build
git diff --check
```

- [ ] **Step 6: Commit Task 2**

```bash
git add rust-api/src/routes/uploads.rs rust-api/src/routes/uploads/handlers.rs rust-api/src/routes/uploads/publication.rs rust-api/src/routes/uploads/storage.rs rust-api/src/routes/uploads/types.rs rust-api/src/routes/mod.rs
git commit -m "fix: publish uploads atomically"
```

---

### Task 3: Reject deletion of referenced managed assets

**Files:**
- Create: `rust-api/src/services/managed_assets.rs`
- Modify: `rust-api/src/services/mod.rs`
- Modify: `rust-api/src/routes/uploads/handlers.rs`
- Modify: `rust-api/src/routes/uploads/types.rs`
- Modify: `rust-api/src/routes/uploads/validation.rs`

**Interfaces:**
- Produces: `pub struct ManagedAssetPath { pub folder: String, pub filename: String, pub url: String, pub filesystem_path: PathBuf }`.
- Produces: `pub fn normalize_managed_asset(root: &Path, folder: &str, filename: &str) -> Result<ManagedAssetPath, ManagedAssetError>`.
- Produces: `pub struct AssetReferenceSummary { pub resource: &'static str, pub count: u64 }`.
- Produces: `pub async fn count_asset_references(db: &Database, url: &str) -> Result<Vec<AssetReferenceSummary>, mongodb::error::Error>`.
- Produces: `pub async fn managed_asset_exists(root: &Path, value: &str) -> Result<bool, ManagedAssetError>` for Task 4.

- [ ] **Step 1: Write failing normalization and reference-registry tests**

Tests must assert exact rejection of:

```rust
for name in ["", ".", "..", "../x.png", "x\\y.png", "%2fetc.png", "%5cetc.png"] {
    assert!(normalize_managed_asset(&root, "icons", name).is_err(), "{name}");
}
```

Create marked synthetic documents for each registry field and prove exact URL matching, including nested `producttypes.popupInfo.image`, authoritative `products.icon`, and `flashsales.banner`. Do not create or test an embedded `flashsales.products[].icon` reference: it is read-time enrichment rather than stored authority. Assert the response summary contains only resource/count pairs and omits document IDs/names.

Add a handler test that creates a file, inserts two synthetic references, attempts deletion, and expects:

```json
{
  "error": {
    "code": "ASSET_IN_USE",
    "message": "Asset masih digunakan",
    "references": [{ "resource": "Settings", "count": 1 }]
  }
}
```

Also prove an unreferenced marked file is deleted and a nonexistent file remains `404`.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api services::managed_assets --no-fail-fast
cargo test --bin webtopup-rust-api routes::uploads::handlers --no-fail-fast
```

- [ ] **Step 3: Implement the fixed reference registry**

Represent the inventory as reviewed constants/functions; do not accept collection or field names from the request. Exact minimum registry:

```rust
const SCALAR_REFERENCES: &[(&str, &str, &str)] = &[
    ("settings", "Settings", "value"), // constrained by key filter below
    ("products", "Products", "icon"),
    ("operators", "Operators", "icon"),
    ("operators", "Operators", "instructionImage"),
    ("producttypes", "Product types", "icon"),
    ("producttypes", "Product types", "cover"),
    ("producttypes", "Product types", "popupInfo.image"),
    ("categories", "Categories", "icon"),
    ("paymentmethods", "Payment methods", "icon"),
    ("paymentcategories", "Payment categories", "icon"),
    ("sliders", "Sliders", "image"),
    ("flashsales", "Flash sales", "banner"),
    ("articles", "Articles", "image"),
    ("rewards", "Rewards", "imageUrl"),
];
```

For settings, filter only keys `favicon`, `logo`, and `popupBannerImage`. Do not add `flashsales.products[].icon`: `flash_mappers.rs` enriches that icon from `products.icon` at read time and the stored flash-sale document contains only product IDs/discount/stock fields. Test `products.icon` and `flashsales.banner` as the two applicable authorities.

Normalize the URL without percent-decoding ambiguity: only server-generated safe basename characters and canonical folder names are accepted. Resolve the final path and prove it starts with `root/folder/`.

- [ ] **Step 4: Guard deletion with a second immediate reference scan**

After permission and path normalization:

1. return 404 if the file does not exist;
2. scan references;
3. if non-empty, return `409 ASSET_IN_USE`;
4. immediately scan again before `remove_file`;
5. delete only if both scans are empty.

Do not expose unauthorized resource details. The fixed categories/counts are safe because upload deletion already requires one of the folder permissions.

- [ ] **Step 5: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api services::managed_assets --no-fail-fast
cargo test --bin webtopup-rust-api routes::uploads --no-fail-fast
cd ..
git diff --check
```

- [ ] **Step 6: Commit Task 3**

```bash
git add rust-api/src/services/mod.rs rust-api/src/services/managed_assets.rs rust-api/src/routes/uploads/handlers.rs rust-api/src/routes/uploads/types.rs rust-api/src/routes/uploads/validation.rs
git commit -m "fix: protect referenced upload assets"
```

---

### Task 4: Reject new references to missing managed assets

**Files:**
- Modify: `rust-api/src/services/managed_assets.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Modify: `rust-api/src/routes/products/payload.rs`
- Modify: `rust-api/src/routes/taxonomy/categories.rs`
- Modify: `rust-api/src/routes/taxonomy/operators.rs`
- Modify: `rust-api/src/routes/taxonomy/product_types.rs`
- Modify: `rust-api/src/routes/payment/validation.rs`
- Modify: `rust-api/src/routes/payment/categories.rs`
- Modify: `rust-api/src/routes/content/sliders.rs`
- Modify: `rust-api/src/routes/content/flash_payload.rs`
- Modify: `rust-api/src/routes/articles.rs`
- Modify: `rust-api/src/routes/rewards/validation.rs`

**Interfaces:**
- Consumes: `managed_asset_exists(root, value)` from Task 3.
- Produces: `pub async fn require_existing_managed_asset(root: &Path, value: &str) -> Result<(), ManagedAssetReferenceError>`.
- Behavior: empty values, emoji/category glyphs, and valid external HTTPS URLs are unchanged; only `/uploads/<folder>/<file>` is treated as a managed reference.

- [ ] **Step 1: Add failing writer-validation tests**

For every active writer listed above, add one focused test with a missing `/uploads/...` path and assert it returns `400 MANAGED_ASSET_NOT_FOUND` before a database write. Add one matching test with an existing canonical synthetic file and one external HTTPS URL where the field already permits HTTPS.

Use a shared table test for pure paths:

```rust
#[tokio::test]
async fn managed_reference_requires_an_existing_canonical_file() {
    let root = fixture_upload_root();
    assert!(require_existing_managed_asset(&root, "").await.is_ok());
    assert!(require_existing_managed_asset(&root, "📦").await.is_ok());
    assert!(require_existing_managed_asset(&root, "https://cdn.invalid/x.png").await.is_ok());
    assert_eq!(
        require_existing_managed_asset(&root, "/uploads/icons/missing.png").await.unwrap_err().code(),
        "MANAGED_ASSET_NOT_FOUND",
    );
}
```

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api managed_asset_reference --no-fail-fast
```

Expected RED: resource validators accept missing managed paths.

- [ ] **Step 3: Make validation async only where needed and call the shared helper**

Do not duplicate `Path::exists` checks. For synchronous normalizers such as slider/article/reward, either:

- validate the normalized managed field in the async handler immediately before the write; or
- convert the normalizer to async only when its caller is already async.

For update routes, validate the resulting effective value, not only newly submitted fields. Ensure settings validate `favicon`, `logo`, and `popupBannerImage`. Ensure product type validates `popupInfo.image` as well as icon/cover.

Return the active error envelope:

```json
{
  "error": {
    "code": "MANAGED_ASSET_NOT_FOUND",
    "message": "Asset upload tidak ditemukan"
  }
}
```

This code is an allowed implementation detail supporting the spec's deletion race bound; add it to route tests and documentation if exposed.

- [ ] **Step 4: Run focused GREEN and sibling regression tests**

```bash
cd rust-api
cargo test --bin webtopup-rust-api managed_asset_reference --no-fail-fast
cargo test --bin webtopup-rust-api products --no-fail-fast
cargo test --bin webtopup-rust-api taxonomy --no-fail-fast
cargo test --bin webtopup-rust-api payment --no-fail-fast
cargo test --bin webtopup-rust-api content --no-fail-fast
cargo test --bin webtopup-rust-api rewards --no-fail-fast
cd ..
git diff --check
```

- [ ] **Step 5: Commit Task 4**

```bash
git add rust-api/src/services/managed_assets.rs rust-api/src/routes/settings/validation.rs rust-api/src/routes/products/payload.rs rust-api/src/routes/taxonomy/categories.rs rust-api/src/routes/taxonomy/operators.rs rust-api/src/routes/taxonomy/product_types.rs rust-api/src/routes/payment/validation.rs rust-api/src/routes/payment/categories.rs rust-api/src/routes/content/sliders.rs rust-api/src/routes/content/flash_payload.rs rust-api/src/routes/articles.rs rust-api/src/routes/rewards/validation.rs
git commit -m "fix: validate managed asset references"
```

---

### Task 5: Define identifier indexes and the guarded readiness tool

**Files:**
- Create: `rust-api/src/services/identifier_integrity.rs`
- Modify: `rust-api/src/services/mod.rs`
- Create: `rust-api/src/bin/site_config_identifier_readiness.rs`
- Modify: `rust-api/Cargo.toml`
- Modify: `package.json`
- Modify: `tools/dev-verification/integration/mongo.test.ts`
- Modify: `tools/dev-verification/unit/rustStartupIndexes.test.ts`

**Interfaces:**
- Produces constants:
  - `INDEX_TRANSACTION_REFERENCE = "uniq_transactions_reference_id"`;
  - `INDEX_GUEST_INVOICE = "uniq_guest_invoice_number"`;
  - `INDEX_DAILY_REFERENCE_COUNTER = "uniq_identifier_counter_scope_date"`.
- Produces: `pub fn identifier_index_models() -> Vec<IdentifierIndexRequirement>`.
- Produces: `pub async fn inspect_identifier_indexes(db: &Database) -> Result<IdentifierIndexReadiness, mongodb::error::Error>`.
- Produces: `pub async fn require_identifier_indexes(db: &Database) -> Result<(), IdentifierReadinessError>`.
- Produces CLI: `cargo run --bin site_config_identifier_readiness -- [--apply]`.

- [ ] **Step 1: Write failing pure index-definition and protected-database tests**

In `identifier_integrity.rs`, add tests that assert exact names, keys, and uniqueness:

```rust
#[test]
fn required_identifier_indexes_are_exact_and_unique() {
    let requirements = identifier_index_models();
    assert_requirement(&requirements, INDEX_TRANSACTION_REFERENCE, "transactions", doc! { "referenceId": 1 }, true);
    assert_requirement(&requirements, INDEX_GUEST_INVOICE, "guesttransactions", doc! { "invoiceNumber": 1 }, true);
    assert_requirement(&requirements, INDEX_DAILY_REFERENCE_COUNTER, "identifiercounters", doc! { "scope": 1, "dateWib": 1 }, true);
}
```

In the binary tests, assert:

```rust
assert!(apply_is_allowed("webtopup_task14_dev"));
for name in ["webtopup", "POBB", "webtopup_task14_dev_backup", "", "admin"] {
    assert!(!apply_is_allowed(name), "{name}");
}
```

Add report tests for missing/malformed/duplicate `referenceId`, invoice numbers, unsafe invoice settings, stored Ref ID date format that is missing/malformed/`NONE`, absent indexes, and drifted unique/key definitions. Stored unsafe Ref ID date format is a blocking finding even though runtime will fail safe. Report examples may include at most five ObjectId hex values and no target/phone/provider payload.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin site_config_identifier_readiness --no-fail-fast
cargo test --lib identifier_integrity --no-fail-fast
```

- [ ] **Step 3: Implement read-only inspection and disposable-only apply**

Add Cargo binary registration:

```toml
[[bin]]
name = "site_config_identifier_readiness"
path = "src/bin/site_config_identifier_readiness.rs"
```

The CLI defaults to dry-run. Unknown flags fail. `--apply` first runs all data checks; if any blocking issue exists, it exits nonzero without creating an index. If clean and database is exact disposable, create the three exact models and verify them by `list_indexes()`.

Do not call the apply function from `main.rs`. Rust application startup may inspect and log readiness, but protected route gates use `require_identifier_indexes` and fail closed; startup does not silently mutate production indexes.

Add root script:

```json
"site-config:identifier-readiness": "cd rust-api && cargo run --bin site_config_identifier_readiness --"
```

- [ ] **Step 4: Add runtime cache contract without weakening inspection**

`require_identifier_indexes` may cache a successful exact inspection for at most five seconds per process. Errors and missing/drifted results are not cached as success. The cache key includes database name. Provide a test-only cache reset.

Return `IdentifierReadinessError::Unavailable`, mapped later to `503 IDENTIFIER_INDEX_UNAVAILABLE`.

- [ ] **Step 5: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin site_config_identifier_readiness --no-fail-fast
cargo test --lib identifier_integrity --no-fail-fast
cd ..
node --import tsx --test tools/dev-verification/unit/rustStartupIndexes.test.ts
node --import tsx --test tools/dev-verification/unit/rustStartupIndexes.test.ts tools/dev-verification/unit/verificationMatrix.test.ts
git diff --check
```

- [ ] **Step 6: Commit Task 5**

```bash
git add rust-api/Cargo.toml rust-api/src/services/mod.rs rust-api/src/services/identifier_integrity.rs rust-api/src/bin/site_config_identifier_readiness.rs package.json tools/dev-verification/integration/mongo.test.ts tools/dev-verification/unit/rustStartupIndexes.test.ts
git commit -m "feat: define identifier readiness gates"
```

---

### Task 6: Enforce invoice entropy and bounded duplicate retry

**Files:**
- Modify: `rust-api/src/services/identifier_integrity.rs`
- Modify: `rust-api/src/routes/settings/defaults.rs`
- Modify: `rust-api/src/routes/settings/conversion.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Modify: `server/src/services/siteSettingsService.ts`
- Modify: `server/src/controllers/settingsController.ts`
- Modify: `client/src/pages/admin/SiteConfig.tsx`
- Modify: `rust-api/src/routes/guest_transactions/checkout.rs`
- Modify: `rust-api/src/routes/guest_transactions/public.rs`
- Modify: `rust-api/src/routes/guest_transactions/types.rs`
- Modify: `server/src/models/GuestTransaction.ts`

**Interfaces:**
- Produces: `pub const MAX_INVOICE_CANDIDATES: usize = 5`.
- Produces: `pub fn safe_invoice_length(random_type: &str, raw: i64) -> usize`.
- Produces: `pub fn validate_invoice_length(random_type: &str, raw: i64) -> Result<usize, InvoicePolicyError>`.
- Produces: `pub fn classify_invoice_duplicate(error: &mongodb::error::Error) -> bool`, true only for exact index `uniq_guest_invoice_number`.
- Consumes: `require_identifier_indexes(db)` from Task 5 before any checkout effects.

- [ ] **Step 1: Write failing parity and retry-policy tests**

Add Rust tests:

```rust
#[test]
fn invoice_policy_uses_safe_type_specific_minimums() {
    assert_eq!(safe_invoice_length("alphanumeric", 1), 8);
    assert_eq!(safe_invoice_length("alphanumeric", 12), 12);
    assert_eq!(safe_invoice_length("numeric", 1), 10);
    assert!(validate_invoice_length("numeric", 9).is_err());
    assert!(validate_invoice_length("alphanumeric", 7).is_err());
}

#[test]
fn invoice_retry_is_bounded_and_constraint_specific() {
    assert_eq!(MAX_INVOICE_CANDIDATES, 5);
    assert!(retry_invoice_candidate(0, DuplicateConstraint::InvoiceNumber));
    assert!(!retry_invoice_candidate(4, DuplicateConstraint::InvoiceNumber));
    assert!(!retry_invoice_candidate(0, DuplicateConstraint::Other));
}
```

Add source/default parity tests asserting Node/Rust/client defaults are `8` and numeric input min is `10`. Add date-format parity tests asserting Ref ID allowed values exclude `NONE`, invoice allowed values retain `NONE`, and a historical unsafe Ref ID value reads as `DDMMYYYY` without persistence. Add a pure transaction-builder test proving invoice candidate insertion is the first domain write in a transaction attempt and a duplicate occurs before voucher/flash effects.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api invoice_policy --no-fail-fast
cd ..
npm --prefix server run build
npm --prefix client run build
```

Expected RED: old default/minimum is 6/1 and no exact retry exists.

- [ ] **Step 3: Align defaults, readers, validators, and UI**

Set Node/Rust/client default `invoiceRandomLength` to 8. Split the shared date-format inventory into `REF_ID_DATE_FORMATS` (five date-bearing formats, no `NONE`) and `INVOICE_DATE_FORMATS` (the same five plus `NONE`) across Rust validation/conversion, Node normalization/legacy validation parity, and React controls. Read a stored Ref ID `NONE`, missing, malformed, null, or wrong-type value as `DDMMYYYY`; do not write during reads or unrelated changed-only saves. Reject a new `refIdDateFormat: "NONE"`, continue accepting `invoiceDateFormat: "NONE"`, and remove only the Ref ID **Tanpa Tanggal** option from the UI. Because `DDMMYYYY` is already the effective fallback, selecting/sending the same value is a no-op and must not be presented as a repair; only an explicitly different allowed date-bearing value creates an effective mutation. Rust PUT validation requires the selected invoice random-type minimum. In Site Config, use:

```tsx
const invoiceRandomMin = form.invoiceRandomType === 'numeric' ? 10 : 8;
```

Clamp only display/input editing to `[invoiceRandomMin, 12]`; backend remains authoritative.

- [ ] **Step 4: Reserve the invoice candidate before other checkout effects**

Refactor each guest transaction attempt so that, after pure calculations and before flash-sale/voucher effects, it inserts a skeletal transaction document carrying `_id`, `invoiceNumber`, idempotency marker identity, and a bounded internal creation state inside the MongoDB session. A duplicate on the exact invoice index aborts that attempt before any other effect.

Then execute the existing in-transaction domain logic and replace the skeleton with the complete frozen document using the same `_id`; do not issue a second insert for the candidate.

Wrap transaction attempt execution in at most five candidates. On exact invoice duplicate: abort, create a fresh session/transaction, and retry. On any other error, preserve existing definitive/ambiguous classification. After five exact collisions return:

```json
{
  "error": {
    "code": "INVOICE_IDENTIFIER_EXHAUSTED",
    "message": "Nomor invoice sementara tidak tersedia"
  }
}
```

Keep the existing guest-checkout idempotency record authoritative so same-key retries replay the first committed invoice.

- [ ] **Step 5: Gate before effects and verify duplicate isolation**

Call `require_identifier_indexes(&db)` immediately after transaction capability and before maintenance/product/voucher/payment effects. Missing/drifted index returns `503 IDENTIFIER_INDEX_UNAVAILABLE` and leaves all collections unchanged.

Tests must inject four exact invoice collisions then success and assert:

- one guest transaction;
- one voucher/flash effect at most;
- the fifth candidate is the response invoice;
- another duplicate constraint or network/database error is not retried.

- [ ] **Step 6: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api invoice_policy --no-fail-fast
cargo test --bin webtopup-rust-api guest_transactions --no-fail-fast
cd ..
npm --prefix server run build
npm --prefix client run build
git diff --check
```

- [ ] **Step 7: Commit Task 6**

```bash
git add rust-api/src/services/identifier_integrity.rs rust-api/src/routes/settings/defaults.rs rust-api/src/routes/settings/conversion.rs rust-api/src/routes/settings/validation.rs server/src/services/siteSettingsService.ts server/src/controllers/settingsController.ts client/src/pages/admin/SiteConfig.tsx rust-api/src/routes/guest_transactions/checkout.rs rust-api/src/routes/guest_transactions/public.rs rust-api/src/routes/guest_transactions/types.rs server/src/models/GuestTransaction.ts
git commit -m "fix: harden guest invoice generation"
```

---

### Task 7: Allocate immutable transaction references atomically

**Files:**
- Modify: `rust-api/src/services/identifier_integrity.rs`
- Modify: `rust-api/src/routes/transactions.rs`
- Modify: `rust-api/src/routes/transactions/types.rs`
- Modify: `rust-api/src/routes/transactions/json.rs`
- Modify: `rust-api/src/routes/transactions/list.rs`
- Modify: `rust-api/src/routes/transactions/csv.rs`
- Modify: `rust-api/src/routes/transactions/provider.rs`
- Modify: `rust-api/src/routes/transactions/status.rs`
- Modify: `rust-api/src/routes/open_api/create.rs`
- Modify: `server/src/models/Transaction.ts`
- Modify: `client/src/pages/admin/Transactions.tsx`
- Modify: `client/src/pages/admin/ManualTransactions.tsx`
- Modify: `client/src/pages/Transactions.tsx`
- Modify: `client/src/pages/dashboard/types.ts`

**Interfaces:**
- Produces: `pub const REFERENCE_COUNTER_SCOPE: &str = "transaction-reference"`.
- Produces: `pub fn wib_date_key(now_utc: chrono::DateTime<Utc>) -> String`.
- Produces: `pub async fn allocate_reference_in_session(db: &Database, session: &mut ClientSession, format: &ReferenceFormat) -> Result<AllocatedReference, ReferenceError>`.
- Produces: `pub struct AllocatedReference { pub reference_id: String, pub sequence: i64, pub date_wib: String }`.
- Consumes: exact index gate from Task 5 and existing bounded commit helper semantics.

- [ ] **Step 1: Write failing WIB/counter/immutability tests**

Tests must cover UTC boundaries mapping to WIB dates, including 16:59:59Z vs 17:00:00Z, and allowed format changes sharing one `(scope,dateWib)` counter. They must also prove `ReferenceFormat::from_settings` maps historical missing/malformed/`NONE` Ref ID format to `DDMMYYYY`, generated references remain date-bearing, and the write validator rejects `NONE`.

Add:

```rust
#[test]
fn sequence_must_fit_configured_width_without_wrap() {
    assert_eq!(format_reference_sequence(9999, 4).unwrap(), "9999");
    assert_eq!(format_reference_sequence(10_000, 4).unwrap_err().code(), "REF_ID_SEQUENCE_EXHAUSTED");
}

#[test]
fn vendor_updates_never_target_reference_id() {
    let update = vendor_result_update(&fixture_vendor_result());
    assert!(update.contains_key("vendorTrxId"));
    assert!(!update.contains_key("referenceId"));
}
```

Add mapper tests that expose both `referenceId` and `vendorTrxId`, and Node model/source tests requiring `referenceId` while not marking `vendorTrxId` unique.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api transaction_reference --no-fail-fast
```

Expected RED: `generate_ref_id` still counts documents and stores the result in `vendorTrxId`.

- [ ] **Step 3: Implement the session-aware WIB counter**

Use `find_one_and_update` with `.session(&mut *session)`, `$inc: { sequence: 1 }`, `$setOnInsert`, `upsert(true)`, and `ReturnDocument::After` on:

```rust
doc! { "scope": REFERENCE_COUNTER_SCOPE, "dateWib": &date_wib }
```

Load the effective format before starting irreversible side effects. `refIdSequenceDigits` must be valid 1–10. `ReferenceFormat::from_settings` must defensively collapse every non-date-bearing or invalid Ref ID format to `DDMMYYYY`, even if an upstream reader regresses. Build `referenceId` from the allocated sequence and the date-bearing format/separator contract.

- [ ] **Step 4: Insert counter and transaction in one MongoDB transaction**

In both active balance-transaction insert paths—browser/member `routes/transactions.rs::create_transaction` and signed `routes/open_api/create.rs::create_transaction`—before balance/voucher/flash or vendor effects, check:

- `state.mongo_transactions_enabled`, otherwise `503 IDENTIFIER_TRANSACTIONS_UNAVAILABLE`;
- exact required indexes, otherwise `503 IDENTIFIER_INDEX_UNAVAILABLE`.

Preallocate transaction `_id`. Preserve each path's existing authorization and caller-supplied `customerRefId` semantics, but replace `generate_ref_id`, `generate_open_api_ref_id`, and raw inserts with one bounded shared function that:

1. starts a session/transaction;
2. allocates counter in session;
3. inserts the transaction with `_id` and immutable `referenceId` in session;
4. commits with bounded `UnknownTransactionCommitResult` retry;
5. invokes the vendor only after positive commit or proof that the preallocated transaction exists.

On definitive abort, run only the existing compensations whose prior effects are proven. On ambiguous commit, query `_id` plus `referenceId` with majority semantics:

- found exact transaction → treat insert as committed;
- proven absent after definitive abort → compensate;
- still unproven → return `503 TRANSACTION_REFERENCE_COMMIT_UNKNOWN` and do not compensate or call vendor.

Delete `generate_ref_id`, `generate_open_api_ref_id`, and every `count_documents(today)` path. OpenAPI's `customerRefId` remains separate and per-user; it does not replace internal `referenceId`. Do not add a non-transactional fallback.

- [ ] **Step 5: Update mappers and UI labels**

Add `referenceId` to `ManualTransactionItem`, JSON/CSV/list projections, public/member transaction types, and Node model. Render it as **Ref ID**. Keep `vendorTrxId` rendered as **Ref vendor**. Manual status updates may edit only provider fields and never accept `referenceId`.

- [ ] **Step 6: Add concurrency and commit-protocol tests**

Using disposable Mongo in route tests or integration seam, allocate at least 50 parallel references for one WIB date and assert:

- all unique;
- sequences exactly 1..50 after sorting;
- prefix change midway does not reset sequence;
- counter and transaction insert abort together;
- width exhaustion inserts neither transaction nor counter increment;
- ambiguous pure seam never triggers compensation or vendor invocation.

- [ ] **Step 7: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api transaction_reference --no-fail-fast
cargo test --bin webtopup-rust-api transactions --no-fail-fast
cd ..
npm --prefix server run build
npm --prefix client run build
git diff --check
```

- [ ] **Step 8: Commit Task 7**

```bash
git add rust-api/src/services/identifier_integrity.rs rust-api/src/routes/transactions.rs rust-api/src/routes/transactions/types.rs rust-api/src/routes/transactions/json.rs rust-api/src/routes/transactions/list.rs rust-api/src/routes/transactions/csv.rs rust-api/src/routes/transactions/provider.rs rust-api/src/routes/transactions/status.rs rust-api/src/routes/open_api/create.rs server/src/models/Transaction.ts client/src/pages/admin/Transactions.tsx client/src/pages/admin/ManualTransactions.tsx client/src/pages/Transactions.tsx client/src/pages/dashboard/types.ts
git commit -m "fix: allocate immutable transaction references"
```

---

### Task 8: Add consistent revisioned reads and public ETag revalidation

**Files:**
- Create: `rust-api/src/routes/settings/snapshot.rs`
- Modify: `rust-api/src/routes/settings.rs`
- Modify: `rust-api/src/routes/settings/store.rs`
- Modify: `rust-api/src/routes/settings/defaults.rs`
- Modify: `rust-api/src/routes/settings/types.rs`
- Modify: `server/src/routes/apiV2ProxyRoutes.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Produces: `pub const SITE_CONFIG_REVISION_KEY: &str = "__site_config_revision__"`.
- Produces: `pub struct SiteSettingsSnapshot { pub revision: i64, pub settings: Map<String, Value> }`.
- Produces: `pub async fn load_consistent_snapshot(client, db_name, selected_keys) -> Result<SiteSettingsSnapshot, SnapshotError>` with three bounded attempts.
- Produces: `pub fn site_settings_etag(revision: i64) -> String`.
- Produces: `pub fn matches_site_settings_etag(raw: Option<&HeaderValue>, revision: i64) -> bool`.

- [ ] **Step 1: Write failing revision/snapshot/ETag tests**

Add pure tests:

```rust
#[test]
fn revision_key_is_reserved_and_never_a_normal_setting() {
    assert!(!default_site_settings().contains_key(SITE_CONFIG_REVISION_KEY));
    assert!(!public_site_setting_keys().contains(&SITE_CONFIG_REVISION_KEY));
}

#[test]
fn etag_matching_accepts_only_the_exact_strong_service_tag() {
    assert!(matches_site_settings_etag(Some(&HeaderValue::from_static("\"site-settings-14\"")), 14));
    for value in ["W/\"site-settings-14\"", "\"site-settings-014\"", "*", "\"other-14\""] {
        assert!(!matches_site_settings_etag(Some(&HeaderValue::from_str(value).unwrap()), 14));
    }
}
```

Use a fake snapshot store to prove revision-before/settings/revision-after retries on mismatch and returns `SnapshotError::Unstable` after three mismatches rather than combining versions.

In Node route tests, assert every public request reaches fetch, cached bodies are absent, `If-None-Match` forwards, 304 has empty body, and upstream `ETag`/`Cache-Control: no-cache` survive filtering.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::snapshot --no-fail-fast
cd ..
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js
```

- [ ] **Step 3: Implement lazy revision reads and compatible responses**

Read missing revision as 0; wrong type, negative value, duplicate metadata document, or Mongo error fails closed. Add `revision` to top-level admin and public JSON after normalized settings are loaded. Single-setting GET returns `{ key, value, revision }` and rejects the reserved key as 404.

Use three revision-before/settings/revision-after attempts. Do not use a transaction for reads so GET remains available in transaction-disabled mode.

- [ ] **Step 4: Remove the Node public response-body cache**

Delete `PUBLIC_SETTINGS_CACHE_MS`, `PublicSettingsCacheEntry`, cache dependency options, HIT/MISS logic, and mutation-time body-cache resets. `proxyPublicSettingsRequest` always performs the upstream request. Preserve correlation and filtered headers.

Set:

```http
Cache-Control: no-cache
ETag: "site-settings-<revision>"
```

in Rust. Return 304 with no body only on exact ETag match. Expose `ETag` through CORS in `server/src/app.ts` together with existing `x-trace-id`.

- [ ] **Step 5: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::snapshot --no-fail-fast
cd ..
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js
npm --prefix client run build
git diff --check
```

- [ ] **Step 6: Commit Task 8**

```bash
git add rust-api/src/routes/settings.rs rust-api/src/routes/settings/snapshot.rs rust-api/src/routes/settings/store.rs rust-api/src/routes/settings/defaults.rs rust-api/src/routes/settings/types.rs server/src/routes/apiV2ProxyRoutes.ts server/src/routes/apiV2ProxyRoutes.test.ts server/src/app.ts
git commit -m "feat: version site settings reads"
```

---

### Task 9: Define the bulk mutation policy and gateway trust contract

**Files:**
- Create: `rust-api/src/routes/settings/policy.rs`
- Modify: `rust-api/src/routes/settings.rs`
- Modify: `rust-api/src/routes/settings/types.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Modify: `rust-api/src/routes/auth/step_up.rs`
- Modify: `server/src/middlewares/stepUp.ts`
- Modify: `server/src/middlewares/authMiddleware.test.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.ts`
- Modify: `server/src/routes/apiV2ProxyRoutes.test.ts`
- Modify: `client/src/auth/stepUp.ts`
- Modify: `client/src/auth/withStepUp.ts`
- Modify: `client/src/components/auth/StepUpDialog.tsx`
- Create: `tools/dev-verification/unit/stepUpOrchestration.test.ts`
- Modify: `rust-api/src/security_hardening_checks.rs`

**Interfaces:**
- Produces: `BulkSettingsUpdatePayload { expected_revision: i64, changes: Map<String, Value> }`.
- Produces: `pub const SENSITIVE_SITE_SETTING_KEYS: &[&str]` with the exact approved 16 keys.
- Produces: `NormalizedSettingsIntent { expected_revision, normalized_changes, effective_changes, digest, requires_step_up }`.
- Produces: `pub fn canonical_settings_payload(expected_revision, normalized_changes) -> Vec<u8>` and SHA-256 hex digest.
- Produces Node middleware: `acceptOptionalStepUp('settings.sensitive')`.
- Produces Node middleware: `requireSiteConfigIdempotencyKey` using the existing 8–128 safe key syntax.

- [ ] **Step 1: Write failing policy parity/canonicalization tests**

Rust tests must assert:

```rust
#[test]
fn sensitive_settings_inventory_is_exact() {
    assert_eq!(SENSITIVE_SITE_SETTING_KEYS, &[
        "maintenanceMode", "registrationEnabled", "guestCheckoutEnabled",
        "minDeposit", "maxDeposit", "depositFee", "depositFeeType",
        "refIdPrefix", "refIdDateFormat", "refIdSeparator", "refIdSequenceDigits",
        "invoicePrefix", "invoiceDateFormat", "invoiceSeparator",
        "invoiceRandomLength", "invoiceRandomType",
    ]);
}

#[test]
fn canonical_digest_is_key_order_independent_but_revision_and_values_bound() {
    let left = normalized_intent(14, json!({"brand":"A", "title":"B"}));
    let reordered = normalized_intent(14, json!({"title":"B", "brand":"A"}));
    assert_eq!(left.digest, reordered.digest);
    assert_ne!(left.digest, normalized_intent(15, json!({"brand":"A", "title":"B"})).digest);
    assert_ne!(left.digest, normalized_intent(14, json!({"brand":"C", "title":"B"})).digest);
}
```

Add cases for unknown/reserved keys, negative/fractional revision, empty `changes`, normalized no-op, cross-field validation, and sensitive submitted-but-equal values not requiring step-up.

Node tests must prove missing/duplicate/malformed key rejection, optional grant behavior, spoof header stripping, exact group stamping only after valid grant, and no preemptive rejection when token is absent. Add client orchestrator tests proving an `AUTH_STEP_UP_REQUIRED` response on a request with stable `Idempotency-Key` is classified as possibly Rust-originated (`gatewayRejectedBeforeUpstream: false`) but remains auto-retryable because the key is preserved; legacy no-key closed routes retain their gateway-local provenance.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::policy --no-fail-fast
cargo test --bin webtopup-rust-api routes::auth::step_up --no-fail-fast
cd ..
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
```

- [ ] **Step 3: Implement pure bulk normalization and canonical JSON**

Deserialize only:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkSettingsUpdatePayload {
    pub expected_revision: i64,
    pub changes: Map<String, Value>,
}
```

Sort object keys recursively for canonical serialization. JSON values are already bounded by setting types; reject arrays/objects for scalar settings through existing validation. Use the normalized submitted change map for digest binding and the current snapshot to derive `effective_changes`.

Do not issue the authoritative revision conflict in this pre-claim policy. It may load the current snapshot for validation/sensitivity, but Task 11 compares revision inside the transaction so conflict can be frozen.

- [ ] **Step 4: Register `settings.sensitive` across all closed inventories**

Add the exact string to:

- Rust `ACTION_GROUPS`;
- Node `STEP_UP_ACTION_GROUPS`;
- client `STEP_UP_ACTION_GROUPS`;
- StepUp dialog copy: **“mengubah konfigurasi situs sensitif”**.

In `client/src/auth/withStepUp.ts`, replace the unconditional `gatewayRejectedBeforeUpstream: true` assignment. Inspect the original headers snapshot: when a stable `Idempotency-Key` exists, record `false` because Rust may have issued the 403 and let `isStepUpRetrySafe` authorize retry by key; without a key, retain `true` only for the existing Node-closed route inventory. Never infer that an arbitrary keyless Rust 403 is gateway-local.

Add parity/source tests so one layer cannot drift.

- [ ] **Step 5: Implement optional gateway grant validation**

Create a middleware factory that behaves as follows:

- no `X-Step-Up-Token` → continue without setting a trusted group;
- one valid grant bound to current user/SID and `settings.sensitive` → store `request.stepUpActionGroup` for trusted stamping;
- duplicate, empty, invalid, expired, wrong SID/user/group token → `403 AUTH_STEP_UP_REQUIRED` for `settings.sensitive`;
- browser trusted-group variants are always stripped before forwarding.

Register bulk PUT in this order:

```ts
app.put('/settings/admin/update', {
  preHandler: [
    authenticate,
    hasPermission('manageSettings'),
    requireSiteConfigIdempotencyKey,
    acceptOptionalStepUp('settings.sensitive'),
  ],
}, proxyRequest);
```

Do not use unconditional `requireStepUp`; non-sensitive changes must pass without a grant.

- [ ] **Step 6: Close single-setting PUT explicitly**

Keep GET registered before a method-specific PUT handler that authenticates/authorizes then returns `405 SETTINGS_SINGLE_MUTATION_DISABLED`. Remove Rust `.put(settings::admin_set)` registration. Add tests proving it cannot fall through to a legacy Node controller or generic wildcard.

- [ ] **Step 7: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::policy --no-fail-fast
cargo test --bin webtopup-rust-api routes::auth::step_up --no-fail-fast
cargo test --bin webtopup-rust-api security_hardening_checks --no-fail-fast
cd ..
npm --prefix server run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js
node --import tsx --test tools/dev-verification/unit/stepUpOrchestration.test.ts
npm --prefix client run build
git diff --check
```

- [ ] **Step 8: Commit Task 9**

```bash
git add rust-api/src/routes/settings.rs rust-api/src/routes/settings/policy.rs rust-api/src/routes/settings/types.rs rust-api/src/routes/settings/validation.rs rust-api/src/routes/auth/step_up.rs server/src/middlewares/stepUp.ts server/src/middlewares/authMiddleware.test.ts server/src/routes/apiV2ProxyRoutes.ts server/src/routes/apiV2ProxyRoutes.test.ts client/src/auth/stepUp.ts client/src/auth/withStepUp.ts client/src/components/auth/StepUpDialog.tsx tools/dev-verification/unit/stepUpOrchestration.test.ts rust-api/src/security_hardening_checks.rs
git commit -m "feat: define site config mutation policy"
```

---

### Task 10: Add permanent fenced Site Config claims

**Files:**
- Create: `rust-api/src/routes/settings/idempotency.rs`
- Modify: `rust-api/src/routes/settings.rs`
- Modify: `rust-api/src/routes/settings/types.rs`
- Modify: `rust-api/src/main.rs`
- Modify: `tools/dev-verification/unit/rustStartupIndexes.test.ts`

**Interfaces:**
- Produces: `SITE_CONFIG_CLAIMS_COLLECTION = "siteconfigidempotencyclaims"`.
- Produces: `SITE_CONFIG_CLAIM_INDEX = "uniq_site_config_idempotency_key"` on `{ idempotencyKey: 1 }`, unique, no TTL.
- Produces: semantic requirement `{ key: 1 }, unique: true, no TTL` for `settings`; an existing compatible name such as Mongoose `key_1` is accepted.
- Produces: `pub async fn ensure_site_config_foundation_indexes(db: &Database) -> Result<(), SiteConfigClaimError>`.
- Produces: `SiteConfigClaimBinding { key, operator_id, expected_revision, payload_digest }`.
- Produces: `SiteConfigClaimBegin::{Started { claim_token }, Completed { status, body }, Conflict, InProgress, CommitUnknown}` mapped to `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, and `SETTINGS_COMMIT_UNKNOWN` as applicable.
- Produces fenced operations: `begin_claim`, `mark_transaction_started`, `undo_pre_effect_claim`, `mark_retryable`, `mark_commit_unknown`, `complete_claim_in_session`, `resolve_claim`.
- Produces `SiteConfigClaimUndo::{DeleteNew, RestoreReclaimed { prior_document }}` returned only with a newly acquired claim and bound to its exact new claim token.
- Frozen response maximum: 256 KiB; oversized snapshots fail before transaction effects.

- [ ] **Step 1: Write failing state-machine and index tests**

Tests must assert:

- exact named unique claim-key index plus semantic unique settings-key index and absence of TTL;
- same binding completed replay;
- changed operator/revision/digest conflict;
- active in-progress response;
- five-minute stale pre-transaction reclaim with a new claim token;
- `transactionStartedAt` prevents reclaim forever;
- `commitUnknown: true` prevents reclaim forever;
- every state transition filters exact `idempotencyKey + claimToken + operatorId + expectedRevision + payloadDigest`;
- exact pre-effect undo deletes only a newly inserted claim or restores the complete prior stale pre-transaction document after a reclaim, and refuses a changed token/binding/status;
- failed undo does not expose the key as retryable or claim ordinary transaction unavailability;
- completed response template freezes status, revision, data/error fields and is replayed unchanged except for the derived `replayed: true` indicator, never replaced by current settings;
- raw idempotency key is not written to settings audit metadata.

Use pure claim-decision tests plus disposable Mongo route tests where atomic filters matter. Add a startup source-contract test proving `ensure_site_config_foundation_indexes(&db)` runs before listener bind and after Mongo connection, and that failure aborts readiness.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::idempotency --no-fail-fast
```

- [ ] **Step 3: Implement the durable pre-transaction claim**

Normalize the key using the same 8–128 ASCII contract as Node. Use a server-generated random `claimToken` and five-minute `leaseExpiresAt`. Insert the claim only after permission, active status, shape validation, snapshot validation, and any required step-up have passed.

On duplicate key, load the existing document and classify exact binding/status. Completed claims retain permanently. Do not add `cleanupAt` or a TTL index.

For a new acquisition, return an in-memory bounded undo description: delete the inserted claim by exact token/binding, or restore the entire prior stale pre-transaction claim after a fenced reclaim. `undo_pre_effect_claim` is allowed only after the real settings transaction has definitively failed before its first in-transaction write. It must use one exact compare-and-swap and verify the resulting document/absence; never use it after a transaction write, ambiguous outcome, or commit attempt.

- [ ] **Step 4: Gate listener readiness on exact foundational indexes**

Implement `ensure_site_config_foundation_indexes` with an exact named unique model for claim `idempotencyKey` and semantic verification for any existing `{ key: 1 }, unique: true` settings index. If a compatible settings index already exists (for example `key_1`), do not create a duplicate named index. If absent, create one reviewed unique `{ key: 1 }` model. Register the check in `rust-api/src/main.rs` before listener readiness, following the existing auth/idempotency startup pattern. Existing duplicates or conflicting definitions fail startup; do not delete or merge documents. Neither invariant has TTL or a partial filter.

- [ ] **Step 5: Fence transaction and ambiguous states**

Before starting the transaction, update the exact in-progress claim to set `transactionStartedAt` and clear the finite lease. A definitive pre-effect abort may call `mark_retryable`, which clears transaction markers only when abort is proven. `mark_commit_unknown` sets a permanent ambiguity marker and never makes the claim lease-reclaimable.

`complete_claim_in_session` writes response status/body/result revision within the settings transaction and retains binding fields.

- [ ] **Step 6: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::idempotency --no-fail-fast
cargo test --lib --no-fail-fast
cd ..
node --import tsx --test tools/dev-verification/unit/rustStartupIndexes.test.ts
git diff --check
```

- [ ] **Step 7: Commit Task 10**

```bash
git add rust-api/src/routes/settings.rs rust-api/src/routes/settings/idempotency.rs rust-api/src/routes/settings/types.rs rust-api/src/main.rs tools/dev-verification/unit/rustStartupIndexes.test.ts
git commit -m "feat: add permanent site config claims"
```

---

### Task 11: Commit settings, revision, audit, and claim atomically

**Files:**
- Create: `rust-api/src/routes/settings/mutation.rs`
- Modify: `rust-api/src/routes/settings.rs`
- Modify: `rust-api/src/routes/settings/store.rs`
- Modify: `rust-api/src/routes/settings/snapshot.rs`
- Modify: `rust-api/src/routes/settings/types.rs`
- Modify: `rust-api/src/routes/settings/validation.rs`
- Create: `rust-api/src/services/audit_sanitize.rs` by moving `rust-api/src/routes/audit_logs/sanitize.rs`
- Modify: `rust-api/src/services/mod.rs`
- Modify: `rust-api/src/routes/audit_logs.rs`
- Modify: `rust-api/src/routes/audit_logs/mappers.rs`
- Modify: `rust-api/src/routes/audit_logs/export.rs`
- Modify: `rust-api/src/services/local_fault.rs`
- Modify: `rust-api/src/security_hardening_checks.rs`

**Interfaces:**
- Consumes: policy from Task 9 and claim state from Task 10.
- Produces: `execute_site_config_mutation(state, headers, actor, idempotency_key, payload) -> Response`.
- Produces: `probe_site_config_transactions(client, db_name) -> Result<(), SettingsTransactionCapabilityError>` using a session-aware revision-metadata read in a transaction followed by abort, with no writes. Only reviewed transaction-not-supported/illegal-operation MongoDB codes classify as capability unavailable; network and unrelated database failures remain distinct fail-closed errors.
- Produces: `SiteConfigMutationOutcome::{Committed, VersionConflict, NoOp, CommitUnknown, DefiniteFailure}`.
- Produces pure seam: `commit_site_config_transaction(session, probe) -> SiteConfigCommitOutcome` with bounded unknown-result retry.
- Audit sanitizer consumes `services::audit_sanitize::{sanitize_audit_bson, sanitize_audit_document}` after moving the existing disclosure policy there; list/export imports are updated rather than duplicating logic.

- [ ] **Step 1: Write failing transaction/capability/revision tests**

Add tests proving:

```rust
#[tokio::test]
async fn disabled_or_unavailable_transactions_write_nothing() {
    for state in [state_with_transactions(false), state_with_transaction_probe_failure()] {
        let before = fixture_counts_and_claim_documents().await;
        let response = execute_fixture_mutation(state, intent()).await;
        assert_error(response, 503, "SETTINGS_TRANSACTIONS_UNAVAILABLE");
        assert_eq!(fixture_counts_and_claim_documents().await, before);
    }
}
```

Also cover:

- missing revision lazy bootstrap from 0 to 1;
- two parallel `expectedRevision: 0` intents produce one success and one frozen conflict;
- no-op completes claim without revision/audit change;
- effective sensitive change on the current revision without trusted proof creates no claim and returns step-up required;
- stale sensitive intent freezes version conflict without demanding step-up;
- non-sensitive change commits without proof;
- settings write failure rolls back revision/audit/claim completion;
- audit insert failure rolls back settings/revision;
- claim completion failure rolls back settings/revision/audit;
- exact transaction-not-supported/illegal-operation probe failure creates no claim, while network/unrelated database errors are not mislabeled as transaction unavailability;
- definitive real-transaction failure before its first write deletes an exact newly inserted claim or restores the byte-for-byte stale claim reclaimed by this attempt;
- failed/mismatched pre-effect undo remains fenced and returns `SETTINGS_COMMIT_UNKNOWN`, never `SETTINGS_TRANSACTIONS_UNAVAILABLE`;
- capability failure after the first transaction write is not treated as pre-effect unavailability;
- replay does not increment revision or write audit;
- version conflict freezes current complete snapshot and does not write settings audit;
- domain audit contains old/new revision, changed keys, sanitized from/to, actor, trace, and only a key fingerprint;
- exact committed response is bounded and replayable.

- [ ] **Step 2: Run RED**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::mutation --no-fail-fast
```

- [ ] **Step 3: Implement transaction-only orchestration**

At the route:

1. require `manageSettings` and obtain the authoritative actor;
2. require and normalize `Idempotency-Key`;
3. reject immediately if `state.mongo_transactions_enabled` is false;
4. run `probe_site_config_transactions`; on failure return `SETTINGS_TRANSACTIONS_UNAVAILABLE` before claim;
5. load the bounded consistent snapshot;
6. normalize and validate intent;
7. if snapshot revision matches `expectedRevision` and effective sensitive changes lack trusted group, return `AUTH_STEP_UP_REQUIRED` before claim;
8. if snapshot revision already differs, skip step-up because no change can execute and continue only to freeze a conflict;
9. begin/replay/classify the permanent claim and retain its exact undo description;
10. mark exact claim transaction-started;
11. start the real MongoDB session/transaction with an `effects_attempted = false` guard;
12. on definitive start/read capability failure while `effects_attempted == false`, abort and apply/verify exact undo; return `SETTINGS_TRANSACTIONS_UNAVAILABLE` only after undo succeeds;
13. reload settings/revision in session;
14. compare revision authoritatively;
15. recompute effective changes and trusted step-up requirement only when revision matches;
16. set `effects_attempted = true` immediately before the first in-transaction write;
17. upsert effective keys with `.session(&mut *session)`;
18. create/increment revision exactly once;
19. insert sanitized domain audit in session;
20. freeze response and complete claim in session;
21. commit conservatively.

For a revision conflict, complete the claim with the frozen 409 response in the transaction and commit only the claim update; settings/revision/audit remain untouched.

For no-op, complete the claim with unchanged snapshot/revision and commit only the claim update.

The pre-claim probe is a capability proof, not a durable guarantee. If the real transaction fails definitively before `effects_attempted`, abort and run `undo_pre_effect_claim`. For a new claim this deletes only the exact token/binding; for a reclaim it restores the complete captured prior stale document. Verify the result before returning `SETTINGS_TRANSACTIONS_UNAVAILABLE`. If undo is mismatched, fails, or cannot be proven, mark/retain conservative fencing and return `SETTINGS_COMMIT_UNKNOWN`. Never undo after the first transaction write or any ambiguous result.

- [ ] **Step 4: Implement bounded commit-unknown resolution**

Retry only errors labeled `UnknownTransactionCommitResult`, at most the existing reviewed bound (`MAX_UNKNOWN_COMMIT_RETRIES = 8`) and a bounded deadline. Do not retry the mutation callback.

After unresolved ambiguity:

1. attempt exact `mark_commit_unknown` outside the transaction;
2. read claim with majority read concern;
3. completed exact claim → replay the committed response;
4. otherwise return `503 SETTINGS_COMMIT_UNKNOWN`;
5. never call `mark_retryable`, rollback settings manually, or start a second transaction.

Add a guarded disposable-only local fault scenario `site_config_commit_unknown_unresolved` that aborts a synthetic attempt but intentionally retains the claim as unknown to verify fencing without placing real data at risk. The seam activates only with exact local marker, exact disposable database, loopback replica-set URI, capability, state directory, and one-shot lease.

- [ ] **Step 5: Remove old best-effort mutation path**

Delete direct `upsert_settings` plus post-write `write_settings_audit_log` from `admin_update`. Keep legacy Node controller inactive. Remove Rust `admin_set` mutation export/registration. Source-contract tests must prove the only active Site Config write calls `execute_site_config_mutation`.

- [ ] **Step 6: Run focused GREEN verification**

```bash
cd rust-api
cargo test --bin webtopup-rust-api settings::mutation --no-fail-fast
cargo test --bin webtopup-rust-api settings::idempotency --no-fail-fast
cargo test --bin webtopup-rust-api audit_logs --no-fail-fast
cargo test --bin webtopup-rust-api security_hardening_checks --no-fail-fast
cargo test --lib --no-fail-fast
cd ..
git diff --check
```

- [ ] **Step 7: Commit Task 11**

```bash
git add rust-api/src/routes/settings.rs rust-api/src/routes/settings/mutation.rs rust-api/src/routes/settings/store.rs rust-api/src/routes/settings/snapshot.rs rust-api/src/routes/settings/types.rs rust-api/src/routes/settings/validation.rs rust-api/src/services/audit_sanitize.rs rust-api/src/services/mod.rs rust-api/src/routes/audit_logs.rs rust-api/src/routes/audit_logs/mappers.rs rust-api/src/routes/audit_logs/export.rs rust-api/src/services/local_fault.rs rust-api/src/security_hardening_checks.rs
git add -u rust-api/src/routes/audit_logs/sanitize.rs
git commit -m "feat: transact site config mutations"
```

---

### Task 12: Implement the client revision, intent, conflict, and uncertainty flow

**Files:**
- Create: `client/src/lib/siteConfigMutation.ts`
- Create: `client/src/lib/siteConfigMutation.test.ts`
- Modify: `client/src/pages/admin/SiteConfig.tsx`
- Modify: `client/src/components/admin/ImagePicker.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseAdminSettingsResponse(input) -> { form: SettingsForm; revision: number }`.
- Produces: `createSiteConfigIntent(revision, changes, cryptoSource) -> SiteConfigIntent`.
- Produces: `SiteConfigIntent { key, expectedRevision, changes }` retained until terminal success/conflict/reset.
- Produces: `classifySettingsConflict(base, draft, server) -> Record<key, 'server-only' | 'draft-only' | 'conflict'>`.
- Produces: `siteConfigErrorMessage(error)`, with uncertain copy for `SETTINGS_COMMIT_UNKNOWN`.
- Consumes: existing `useStepUpOrchestration().run('settings.sensitive', ...)` and retains the same idempotency key.

- [ ] **Step 1: Write failing pure client tests**

Create tests that assert:

```ts
test('revision metadata never becomes an editable setting', () => {
  const parsed = parseAdminSettingsResponse({ ...fixtureSettings, revision: 14 });
  assert.equal(parsed.revision, 14);
  assert.equal('revision' in parsed.form, false);
});

test('one intent key survives step-up and replay but conflict creates a new intent', () => {
  const intent = createSiteConfigIntent(14, { maintenanceMode: true }, fixedCrypto);
  assert.equal(intent.key, 'sitecfg_fixture_key');
  assert.equal(retrySameIntent(intent).key, intent.key);
  assert.notEqual(rebaseAfterConflict(intent, 15, fixedCrypto2).key, intent.key);
});

test('commit unknown copy is explicitly uncertain', () => {
  const message = siteConfigErrorMessage(apiError(503, 'SETTINGS_COMMIT_UNKNOWN'));
  assert.match(message, /belum dapat dipastikan/i);
  assert.doesNotMatch(message, /gagal disimpan/i);
});
```

Add complete three-way conflict cases, invalid/missing revision fail-closed parsing, non-empty 8–128 key generation, changed-only payload, invoice minimum helper, and frozen replay response parsing.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test client/src/lib/siteConfigMutation.test.ts
```

- [ ] **Step 3: Implement pure intent/conflict helpers**

Generate keys with `crypto.randomUUID()` transformed into safe syntax, for example `sitecfg_<uuid-without-unsafe-chars>`. Never persist the key to localStorage/sessionStorage. Keep it in component memory only.

An intent remains live through:

- first request;
- auth refresh replay performed by the API layer;
- `AUTH_STEP_UP_REQUIRED` dialog and retry;
- explicit safe retry after response loss/unknown only when the same intent is being resolved.

Success/replay clears it. Conflict retains the draft but retires the old intent; a new save after choosing a current revision uses a new key.

- [ ] **Step 4: Refactor SiteConfig save through the versioned contract**

Track `revision`, `pendingIntent`, and optional conflict state separately from `SettingsForm`. Send:

```ts
await stepUp.run(
  'settings.sensitive',
  (config) => apiV2.put('/settings/admin/update', {
    expectedRevision: intent.expectedRevision,
    changes: intent.changes,
  }, config),
  { headers: { 'Idempotency-Key': intent.key } },
);
```

Call the orchestrator for every save intent; non-sensitive requests pass through Rust without opening a dialog, while sensitive Rust responses trigger the existing safe retry with the same key.

Prevent double submit while the intent is in flight. On success or replay, use response `data` and `revision` as form/lastSaved authority. Do not merge with stale local state.

On `SETTINGS_VERSION_CONFLICT`, preserve draft and display persistent server revision/snapshot summary. **Muat versi terbaru** replaces form/base/revision and clears conflict. **Tinjau ulang draft** keeps draft visible and records the server revision for a deliberate subsequent rebase; it does not auto-save.

On `SETTINGS_COMMIT_UNKNOWN`, retain intent for resolution and display:

```text
Status penyimpanan belum dapat dipastikan. Periksa revisi terbaru dan log audit sebelum mencoba tindakan baru.
```

- [ ] **Step 5: Make upload policy errors visible**

In `ImagePicker.tsx`, add an `error` state with `role="alert"`. Parse the API error code/message for upload, list, and delete. Show the accepted format/limit copy:

```text
JPEG, PNG, atau WebP · maks. 5 MiB · maks. 4096×4096
```

On `ASSET_IN_USE`, show persistent resource/count summary. Do not expose raw response bodies or only log to console. Full picker modal focus/tab redesign remains out of scope.

- [ ] **Step 6: Align invoice input constraints and public-freshness copy**

Set dynamic min 8/10 and max 12. Replace “berdampak langsung” with copy that states the saved revision is authoritative and public pages observe it on revalidation/navigation.

Add the pure test to the root unit command:

```json
"test:dev-verify:unit": "node --import tsx --test tools/dev-verification/unit/*.test.ts client/src/lib/auditLogQuery.test.ts client/src/lib/siteConfigMutation.test.ts && node --test scripts/security/*.test.js"
```

- [ ] **Step 7: Run focused GREEN verification**

```bash
node --import tsx --test client/src/lib/siteConfigMutation.test.ts
npm --prefix client run build
node --import tsx --test client/src/lib/siteConfigMutation.test.ts tools/dev-verification/unit/teamAccess.test.ts
git diff --check
```

- [ ] **Step 8: Commit Task 12**

```bash
git add client/src/lib/siteConfigMutation.ts client/src/lib/siteConfigMutation.test.ts client/src/pages/admin/SiteConfig.tsx client/src/components/admin/ImagePicker.tsx package.json
git commit -m "feat: coordinate versioned site config saves"
```

---

### Task 13: Prove the foundation through real-session disposable integration

**Files:**
- Create: `tools/dev-verification/integration/uploadSecurity.test.ts`
- Create: `tools/dev-verification/integration/identifierIntegrity.test.ts`
- Create: `tools/dev-verification/integration/siteConfigFoundation.test.ts`
- Modify: `tools/dev-verification/seed.ts`
- Modify: `tools/dev-verification/unit/seed.test.ts`
- Modify: `tools/dev-verification/e2e/fixtures.ts`
- Modify: `tools/dev-verification/faults.ts`
- Modify: `tools/dev-verification/faultProxy.ts`
- Modify: `tools/dev-verification/processes.ts`
- Modify: `tools/dev-verification/unit/faultProxy.test.ts`
- Modify: `tools/dev-verification/unit/processes.test.ts`
- Modify: `tools/dev-verification/integration/mongo.test.ts`

**Interfaces:**
- Produces fixtures:
  - `site-config-denied` active CS without `manageSettings`;
  - `site-config-manager` active CS with `manageSettings`, 2FA, and synthetic TOTP;
  - `site-config-inactive` inactive CS with `manageSettings`;
  - `identifier-member` active member with bounded synthetic balance and no production identity;
  - marked synthetic product/payment/content/settings records referencing disposable uploads;
  - every marked transaction seeded into `transactions` carries a unique synthetic `referenceId`, so disposable exact index creation is clean.
- Produces fault scenarios:
  - `site_config_response_loss_after_commit` at gateway fault proxy;
  - `site_config_transaction_probe_unavailable` at guarded Rust seam before claim;
  - `site_config_transaction_start_unavailable` at guarded Rust seam after claim but before the first transaction write;
  - `site_config_claim_undo_mismatch` at guarded Rust seam for conservative cleanup-failure proof;
  - `site_config_commit_unknown_unresolved` at guarded Rust seam.
- Reuses direct disabled-transaction Rust subprocess port `19012` and real trusted proxy headers generated by the integration login/session path, not browser-fabricated trust.

- [ ] **Step 1: Write failing fixture and fault-contract unit tests**

Extend `seed.test.ts` to assert exact permissions, active states, marker fields, 2FA secret availability only in the private disposable database, and identifier-ready synthetic records.

Extend fault tests to assert:

- scenario names are closed inventory;
- activation requires local marker/capability;
- response-loss destroys downstream only after upstream 2xx completion;
- transaction probe/start/undo and unresolved commit faults are Rust-only and cannot be activated by request headers;
- probe/start faults reproduce only the exact transaction-capability classifier, while the undo-mismatch fault changes only a marked synthetic claim token after acquisition;
- evidence schemas contain no credential, payload, cookie, OTP, or idempotency key.

Run RED:

```bash
node --import tsx --test tools/dev-verification/unit/seed.test.ts tools/dev-verification/unit/faultProxy.test.ts tools/dev-verification/unit/processes.test.ts
```

- [ ] **Step 2: Implement marked fixtures and guarded faults**

Use CS for the Site Config manager so real disposable staff 2FA remains stable. Add `manageSettings: true` only to manager/inactive fixtures. Do not give the denied fixture unrelated permissions.

Extend `FixtureDefinition` with an optional bounded synthetic balance so `identifier-member` can fund mock-provider transactions without borrowing the admin finance fixture. Ensure seed/database reset removes marked settings, claims, counters, uploads, audit rows, and identifier fixtures in isolated checks. Do not delete shared/unmarked data.

Before `startHostProcesses` spawns Rust for any disposable profile, call a new `prepareDisposableIdentifierIndexes(config)` helper that:

1. reuses `assertMarkedVerificationDatabaseReady(config)` so topology, exact database, marker, volume, stopped-host state, and capability are verified twice;
2. runs the already-built `site_config_identifier_readiness --apply` binary with environment from `.dev-verification/env/shared.env`;
3. refuses to run if `MONGO_DB !== 'webtopup_task14_dev'` or the executable is not the repository's expected target binary;
4. finishes before Rust/Node/Vite accept test traffic;
5. records no credentials or URI in logs.

Unit tests must prove protected names and an unmarked database never reach the child process. This is disposable harness automation only; `rust-api/src/main.rs` still does not create production identifier indexes.

Add a helper to launch port 19012 with `MONGO_TRANSACTIONS_ENABLED=false` only inside `siteConfigFoundation.test.ts`, following `giveawayAtomic.test.ts`; always terminate it in `finally`. Implement the four Rust-only Site Config fault scenarios with exact marker/database/loopback/capability/state-dir/one-shot guards. They must be unreachable through request headers and inactive unless the dedicated fault profile is selected.

- [ ] **Step 3: Write and run upload integration RED**

`uploadSecurity.test.ts` must use real staff login/cookies/CSRF through Node and assert:

1. MIME-spoofed non-image → `UNSUPPORTED_IMAGE_FORMAT` and no file;
2. truncated JPEG → `INVALID_IMAGE_CONTENT`;
3. GIF → rejected;
4. generated valid JPEG/PNG/WebP → canonical extension and decodable metadata-free output;
5. invalid two-file batch → no batch files;
6. marked settings/product/payment/content references → `ASSET_IN_USE` with bounded summaries;
7. unreferenced marked file → deletion success;
8. missing managed URL cannot be saved by representative active writers;
9. folder permissions remain unchanged.

Run RED before implementation wiring is considered complete:

```bash
npx playwright test --config tools/dev-verification/playwright.integration.config.ts uploadSecurity.test.ts --project=chromium-desktop --workers=1
```

Expected initial failure before final fixture/writer wiring; then GREEN after fixes.

- [ ] **Step 4: Write and run identifier integration RED/GREEN**

`identifierIntegrity.test.ts` must:

1. capture document/index counts;
2. run readiness dry-run and prove no changes;
3. run disposable `--apply` and verify exact indexes;
4. prove protected database-name variants refuse apply;
5. log in the real `identifier-member`, create at least 50 parallel mock browser/member balance transactions, and assert unique ordered `referenceId` values and distinct provider IDs;
6. issue a real signed OpenAPI create for the same synthetic member and prove it receives the next internal `referenceId` while preserving its separate caller `customerRefId`;
7. store marked `refIdDateFormat: "NONE"` directly as historical fixture data, prove admin/effective reads and both member/OpenAPI allocation use `DDMMYYYY` without rewriting the setting, prove an unrelated changed-only save still leaves raw `NONE`, and prove readiness dry-run reports a blocking unsafe-format finding;
8. prove versioned Site Config rejects a new Ref ID `NONE` save while a versioned invoice `NONE` save remains valid; then explicitly save another allowed date-bearing Ref ID format, prove storage normalization, and restore the fixture through normal versioned mutation;
9. change prefix mid-date and prove sequence does not reset;
10. force sequence width exhaustion and prove no counter/transaction partial write;
11. force four exact invoice collisions then success and prove one guest transaction/one domain effect;
12. force five collisions and expect `INVOICE_IDENTIFIER_EXHAUSTED`;
13. remove/drift an index in marked disposable scope, wait at least 5,500 ms (strictly beyond the five-second successful-readiness cache) without issuing a protected creation request, then expect the next and only assertion request to return `IDENTIFIER_INDEX_UNAVAILABLE`; restore the exact index in `finally` and restart Rust before later checks rather than relying on test-only cache reset.

Never call a real provider. Reset every changed setting/counter/index/fixture in `finally` or rely on the isolated profile database reset plus explicit index restoration before process teardown.

- [ ] **Step 5: Write and run Site Config integration RED/GREEN**

`siteConfigFoundation.test.ts` must prove all 14 scenarios:

1. denied fixture GET/PUT → 403;
2. inactive manager GET/PUT → 403;
3. active manager reads normalized settings plus revision;
4. non-sensitive brand/description save succeeds without a grant;
5. effective sensitive change returns `AUTH_STEP_UP_REQUIRED` with `settings.sensitive` and creates no claim;
6. real password+TOTP step-up then same key succeeds;
7. identical replay returns same revision/body with no second domain audit;
8. changed body/revision/operator under same key → `IDEMPOTENCY_CONFLICT`;
9. stale revision → frozen `SETTINGS_VERSION_CONFLICT` with complete current snapshot and unchanged settings;
10. port 19012 PUT → `SETTINGS_TRANSACTIONS_UNAVAILABLE` with no claim/write;
11. guarded probe/start capability failure with flag true → `SETTINGS_TRANSACTIONS_UNAVAILABLE` and byte-for-byte unchanged claims/settings/revision/audit; separately prove mismatched undo remains `SETTINGS_COMMIT_UNKNOWN` and fenced;
12. gateway response loss after committed update → same-key replay and one revision/audit;
13. guarded unresolved commit → `SETTINGS_COMMIT_UNKNOWN`, permanent fenced claim, and no second mutation on retry;
14. public GET returns `no-cache`, ETag, top-level revision, exact 304/no body, and malformed validator 200.

Use a synthetic reason/marker in changed text. Restore marked Site Config keys to their original values through a new versioned transaction intent, not direct Mongo writes during the behavior assertions. Cleanup direct fixture artifacts only in `finally` after assertions.

- [ ] **Step 6: Run focused integration GREEN and teardown**

With disposable infrastructure and the existing extracted Chromium libraries only:

```bash
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session
npx playwright test --config tools/dev-verification/playwright.integration.config.ts uploadSecurity.test.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session-device-policy
node --import tsx --test tools/dev-verification/integration/identifierIntegrity.test.ts
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- db-seed
npm run dev-verify -- host-up-session-fault
npx playwright test --config tools/dev-verification/playwright.integration.config.ts siteConfigFoundation.test.ts --project=chromium-desktop --workers=1
npm run dev-verify -- host-down
npm run dev-verify -- db-reset
npm run dev-verify -- infra-down
npm run dev-verify -- infra-status
```

Expected final status: `serviceCount: 0`. Use the approved Chromium wrapper/font environment if required; do not install OS packages.

- [ ] **Step 7: Commit Task 13**

```bash
git add tools/dev-verification/integration/uploadSecurity.test.ts tools/dev-verification/integration/identifierIntegrity.test.ts tools/dev-verification/integration/siteConfigFoundation.test.ts tools/dev-verification/seed.ts tools/dev-verification/unit/seed.test.ts tools/dev-verification/e2e/fixtures.ts tools/dev-verification/faults.ts tools/dev-verification/faultProxy.ts tools/dev-verification/processes.ts tools/dev-verification/unit/faultProxy.test.ts tools/dev-verification/unit/processes.test.ts tools/dev-verification/integration/mongo.test.ts
git commit -m "test: verify site config foundation"
```

---

### Task 14: Add browser gates, matrix registration, smoke correction, and final verification

**Files:**
- Create: `tools/dev-verification/e2e/site-config-foundation.spec.ts`
- Modify: `tools/dev-verification/verificationMatrix.ts`
- Modify: `tools/dev-verification/unit/verificationMatrix.test.ts`
- Modify: `scripts/smoke/api-v2-mutation-smoke.js`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-08-12-site-config-security-correctness.md` only to tick completed steps during execution

**Interfaces:**
- Produces mandatory checks:
  - `upload-security` on isolated `session-cs`;
  - `identifier-integrity` on isolated `session-device-policy`;
  - `site-config-foundation` on isolated `session-cs-fault`;
  - `site-config-foundation-desktop` on isolated `session-cs-fault`;
  - `site-config-foundation-mobile` on isolated `session-cs-fault`.
- Preserves matrix stopped-state last and all existing audit/team/catalog/finance checks.

- [ ] **Step 1: Write browser tests RED before matrix registration**

Create `site-config-foundation.spec.ts`. For desktop and mobile, use the real `site-config-manager` fixture and assert:

1. current revision is loaded but no editable `revision` control exists;
2. non-sensitive save emits exactly one PUT, succeeds without dialog, and increments revision once;
3. sensitive save emits one initial PUT, opens **Verifikasi ulang diperlukan**, and after real OTP retry uses the same `Idempotency-Key` exactly once;
4. simulated response loss displays resolution/replay success and never increments revision twice;
5. a competing marked API save causes conflict; page preserves draft and displays current server values;
6. **Tinjau ulang draft** does not send a request;
7. **Muat versi terbaru** replaces draft and revision without sending a PUT;
8. unresolved commit copy contains “belum dapat dipastikan” and not “gagal disimpan”;
9. Ref ID date-format selector has no **Tanpa Tanggal**/`NONE` option, while invoice date-format selector retains it;
10. alphanumeric invoice input has min 8; numeric has min 10;
11. GIF/spoof upload produces a visible alert;
12. public settings navigation/revalidation observes the saved revision;
13. no save action creates duplicate concurrent PUTs.

Use marked fixture values and restore via versioned API in `finally`. Do not assert or print credentials, OTP, cookies, grants, raw idempotency keys, Mongo URIs, or response bodies containing private data.

Run RED:

```bash
npx playwright test --config tools/dev-verification/playwright.config.ts site-config-foundation.spec.ts --project=chromium-desktop --workers=1
npx playwright test --config tools/dev-verification/playwright.config.ts site-config-foundation.spec.ts --project=chromium-mobile --workers=1
```

- [ ] **Step 2: Make browser checks GREEN without broad UX redesign**

Fix only contract defects exposed by these flows. New conflict buttons and alerts must have accessible names, persistent text, and keyboard-operable native buttons. Do not expand into unsaved-navigation guards, full tab semantics, or modal focus redesign.

- [ ] **Step 3: Register failing matrix contracts**

Extend `verificationMatrix.test.ts` first to require the five exact checks and profiles above, require `isolated: true`, and preserve stopped state last. Run:

```bash
node --import tsx --test tools/dev-verification/unit/verificationMatrix.test.ts
```

Expected RED: checks absent.

- [ ] **Step 4: Register matrix checks and update pure unit command**

Add exact commands:

```ts
check('upload-security', 'session-cs', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'uploadSecurity.test.ts', '--project=chromium-desktop', '--workers=1'], true),
check('identifier-integrity', 'session-device-policy', 'node', ['--import', 'tsx', '--test', 'tools/dev-verification/integration/identifierIntegrity.test.ts'], true),
check('site-config-foundation', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.integration.config.ts', 'siteConfigFoundation.test.ts', '--project=chromium-desktop', '--workers=1'], true),
check('site-config-foundation-desktop', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-desktop', '--workers=1'], true),
check('site-config-foundation-mobile', 'session-cs-fault', 'npx', ['playwright', 'test', '--config', 'tools/dev-verification/playwright.config.ts', 'site-config-foundation.spec.ts', '--project=chromium-mobile', '--workers=1'], true),
```

Ensure `client/src/lib/siteConfigMutation.test.ts` remains in `test:dev-verify:unit`.

- [ ] **Step 5: Correct smoke expectations for the new contract**

Update only the Site Config smoke boundary in `scripts/smoke/api-v2-mutation-smoke.js`:

- GET admin all expects top-level revision;
- PUT includes a bounded `Idempotency-Key` and `{ expectedRevision, changes }`;
- sensitive smoke remains disabled unless explicit mutation capability and real step-up are present;
- single-setting PUT expects closure;
- public GET checks ETag/no-cache and may send `If-None-Match`;
- never make the smoke run production mutations by default.

- [ ] **Step 6: Run the complete non-disposable regression suite**

Run exactly:

```bash
npm run test:dev-verify:unit
npm run build
node --test server/dist/routes/apiV2ProxyRoutes.test.js server/dist/middlewares/authMiddleware.test.js server/dist/services/adminAuditService.test.js
(cd rust-api && cargo test --bin webtopup-rust-api --no-fail-fast)
(cd rust-api && cargo test --lib --no-fail-fast)
(cd rust-api && cargo test --bin site_config_identifier_readiness --no-fail-fast)
(cd server && npm run test:security)
npm run test:provider-sandbox
git diff --check
```

Also run `cargo build --bin webtopup-rust-api --bin site_config_identifier_readiness`. Do not run `cargo fmt --check`; record that rustfmt is unavailable.

- [ ] **Step 7: Run focused disposable checks and full matrix**

Set only the existing approved Chromium environment when needed:

```bash
export LD_LIBRARY_PATH="/tmp/webtopup-playwright-libs/usr/lib/x86_64-linux-gnu:/tmp/webtopup-playwright-libs/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE=/tmp/webtopup-playwright-fonts/fonts.conf
export FONTCONFIG_PATH=/tmp/webtopup-playwright-fonts/etc/fonts
export DEV_VERIFICATION_CHROME_EXECUTABLE=/tmp/webtopup-playwright-chrome-wrapper
```

Then run from a clean disposable lifecycle:

```bash
npm run dev-verify -- host-down || true
npm run dev-verify -- infra-down || true
npm run dev-verify -- infra-up
npm run dev-verify -- db-bootstrap
npm run dev-verify -- db-seed
npm run dev-verify -- test
```

Expected terminal marker:

```text
LOCAL DEV VERIFIED
```

Do not bypass any failed required check.

- [ ] **Step 8: Teardown and prove zero residual services**

```bash
npm run dev-verify -- host-down
npm run dev-verify -- infra-down
npm run dev-verify -- status
npm run dev-verify -- infra-status
```

Required evidence:

```text
processes: []
composeServices: []
serviceCount: 0
```

Also verify no tracked dirty generated files and no staged files:

```bash
git status --short
git diff --check
git diff --cached --check
```

- [ ] **Step 9: Request independent read-only review**

Use fresh-context reviewers with distinct lanes and no edit authority:

1. upload decoder/resource-limit/temp-file/reference-race security;
2. identifier index/readiness/counter/invoice/financial compensation correctness;
3. settings revision/idempotency/transaction/step-up/commit-unknown security;
4. client conflict/replay/uncertain-result/request-count behavior;
5. disposable secrecy, marker isolation, index restoration, and teardown.

Resolve every confirmed Critical/Important finding by adding a failing regression test before a fix. Rerun affected focused checks and the full matrix if production or verification behavior changed.

- [ ] **Step 10: Commit final verification gates**

```bash
git add tools/dev-verification/e2e/site-config-foundation.spec.ts tools/dev-verification/verificationMatrix.ts tools/dev-verification/unit/verificationMatrix.test.ts scripts/smoke/api-v2-mutation-smoke.js package.json docs/superpowers/plans/2026-08-12-site-config-security-correctness.md
git commit -m "test: gate site config foundation"
```

- [ ] **Step 11: Prepare the final report without production action**

Report:

- commits and changed-file groups;
- focused and full verification command outcomes;
- `LOCAL DEV VERIFIED` matrix count and the five new checks;
- exact teardown evidence;
- rustfmt limitation;
- identifier production readiness/backfill remains a blocked release decision;
- existing GIF files were not migrated;
- no production scan/index/data mutation, deployment, restart, push, or PR occurred.

---

## Task dependency summary

```text
Task 1 image policy
  → Task 2 staging/publication
    → Task 3 reference-safe deletion
      → Task 4 reference existence on writers

Task 5 identifier index/readiness
  → Task 6 invoice integrity
  → Task 7 immutable transaction reference

Task 8 revisioned reads/ETag
  → Task 9 bulk policy/gateway trust
    → Task 10 permanent claims
      → Task 11 transactional mutation
        → Task 12 client orchestration

Tasks 1–12
  → Task 13 real-session disposable integration
    → Task 14 browser/matrix/full verification/review
```

Parallel implementation is not authorized in one shared checkout. Tasks 6 and 7 are conceptually independent after Task 5 but both modify identifier services and transaction-adjacent code; execute them sequentially. Tasks 1–4 and 5–7 may be reviewed independently, but Task 13 integrates all foundations and must run only after Tasks 1–12 are green.

## Plan completion criteria

The implementation is complete only when:

- every checkbox above is either completed with evidence or explicitly blocked by a user-owned production decision;
- every source change was introduced through a failing test;
- all 14 task checkpoints exist locally;
- full non-disposable regression passes;
- exact disposable identifier indexes are created only in `webtopup_task14_dev`;
- upload, identifier, Site Config integration, and desktop/mobile browser checks pass;
- the complete matrix prints `LOCAL DEV VERIFIED`;
- teardown reports zero processes/services;
- fresh reviewers have no unresolved Critical/Important findings;
- production readiness/backfill/deploy/push remains untouched pending separate approval.
