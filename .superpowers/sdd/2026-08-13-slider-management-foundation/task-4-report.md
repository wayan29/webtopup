# Task 4 Report: Register hardened uploads and make publication rollback-safe

## Status
Implemented Task 4 upload publication and managed-asset registration path.

## Changes
- Registry canonical paths now accept `icons`, `covers`, `popups`, and `instructions`; slider reference acquire/release remain covers-only.
- Canonical image format, dimensions, and canonical byte size flow through staging and publication into `PublishedAssetRegistration`.
- Added `publish_and_register_batch`, a generic async callback seam. Files publish before callback; callback errors map to `MANAGED_ASSET_REGISTRY_UNAVAILABLE`; all newly published files are unlinked on registry failure and staging Drop cleanup remains private.
- Wired single and multiple upload handlers to the Mongo transaction registration path. Uploads fail closed when Mongo or transactions are unavailable; no success is returned before registration commits.
- Preserved existing permissions, response fields, batch count/byte limits, and staging behavior.

## Validation
- `cd rust-api && cargo test uploads::publication -- --nocapture` — PASS (8 tests).
- `cd rust-api && cargo test managed_asset_registry -- --nocapture` — PASS (5 tests).
- `cd rust-api && cargo check --bin webtopup-rust-api` — PASS.
- `git diff --check` — PASS.
- `node --import tsx --test tools/dev-verification/integration/uploadSecurity.test.ts` — ENVIRONMENT-BLOCKED: `ECONNREFUSED 127.0.0.1:19005`; disposable host was down and no service was started.
- `cargo fmt -- --check` — NOT RUN successfully: `cargo-fmt` is not installed in the available toolchain.

## Residual risks
- The live Mongo transaction/integration path was not exercised because the disposable verification host was unavailable.
- Repository contains pre-existing/unrelated changes; only Task 4 paths and the approved registry correction are intended for staging.

## Review Fix — Task 4

### Findings addressed
- `rust-api/src/services/managed_asset_registry.rs`: ordinary transaction operation/commit errors now explicitly attempt an abort; published-file cleanup is allowed only when the abort succeeds. An abort failure and MongoDB `UnknownTransactionCommitResult` are represented as reconciliation-required outcomes rather than ordinary registry unavailability.
- `rust-api/src/routes/uploads/publication.rs`: reconciliation-required registry outcomes fail closed with `MANAGED_ASSET_REGISTRY_UNAVAILABLE` while retaining newly published files for reconciliation; ordinary registry errors still roll back the complete published batch. Added focused coverage for ambiguous commit retention.
- `rust-api/src/services/managed_asset_registry.rs`: slider acquire/release now reject every non-`covers` canonical folder while generic registration still accepts `icons`, `covers`, `popups`, and `instructions`. Added metadata/one-row-per-registration assertions.
- `tools/dev-verification/integration/uploadSecurity.test.ts`: the canonical upload assertion now verifies the `managedassets` row's state, folder, filename, format, dimensions, reference count, and size against the actual published bytes.

### Exact validation evidence
- `cd rust-api && cargo test uploads::publication -- --nocapture` — **PASS**; publication target: **9 passed, 0 failed**.
- `cd rust-api && cargo test managed_asset_registry -- --nocapture` — **PASS**; managed registry targets: **7 passed, 0 failed**.
- `cd rust-api && cargo check --bin webtopup-rust-api` — **PASS**; finished `dev` profile with no compile errors.
- `node --import tsx --test tools/dev-verification/integration/uploadSecurity.test.ts` — **ENVIRONMENT-BLOCKED**; test failed before application assertions because fetch received `ECONNREFUSED 127.0.0.1:19005` (disposable host unavailable).
- `git diff --check` — **PASS**.
- The final staged path set is restricted to `rust-api/src/routes/uploads/publication.rs`, `rust-api/src/services/managed_asset_registry.rs`, `tools/dev-verification/integration/uploadSecurity.test.ts`, and this report.
