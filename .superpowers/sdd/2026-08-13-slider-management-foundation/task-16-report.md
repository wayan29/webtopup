# Task 16 report — disposable slider transaction proof

Status: **DONE_WITH_CONCERNS**

Task 16 was executed only against the approved disposable lifecycle and exact database `webtopup_task14_dev` (Mongo loopback `127.0.0.1:27018`, replica set `rs0`, provider mode `mock`). No production scan, migration, index creation, service restart, deployment, push, or production data mutation was performed.

## Changes

- Added marked disposable `slider-denied`, `slider-manager`, and `slider-inactive` fixtures with isolated permissions and TOTP enrollment.
- Added closed managed-asset and slider fault inventories, one-shot capability leases, gateway-owned slider response-loss ownership, and unit contracts.
- Added apply-only missing-collection compatibility for the exact disposable readiness path. Read/inspect paths and non-disposable errors remain fail-closed.
- Added disposable-only covers writer-readiness injection and synchronized deletion race seam.
- Added Rust slider fault boundary consumers for transaction probe, pre-start retryable claim, post-claim commit-unknown, registry/domain/audit/unknown/contention/reference/oversize seams, revision conflict, unlink/archive, and completed-result protection.
- Added `tools/dev-verification/integration/sliderManagement.test.ts` with real Node/Rust/Mongo/filesystem proof, full-ID reorder, limit/contention setup, gateway response-loss durable candidate cleanup, and marked-only cleanup.

## Verification evidence

| Check | Evidence |
|---|---|
| Unit seed/fault/faultProxy | `node --import tsx --test tools/dev-verification/unit/seed.test.ts tools/dev-verification/unit/faults.test.ts tools/dev-verification/unit/faultProxy.test.ts` — **33/33 pass** |
| Rust runtime-fault contract | `cargo test --manifest-path rust-api/Cargo.toml disposable_slider_faults_have_explicit_runtime_boundary_consumers -- --nocapture` — **1 pass** |
| Rust compile | `cargo check --manifest-path rust-api/Cargo.toml --bin webtopup-rust-api` — exit **0**; `cargo build --manifest-path rust-api/Cargo.toml --bin webtopup-rust-api` — exit **0** |
| Integration | `node --import tsx --test tools/dev-verification/integration/sliderManagement.test.ts` under `host-up-session-fault` — **1/1 pass** |
| Diff hygiene | `git diff --check` — pass |
| Teardown | `host-down` — exit **0**, owned host processes stopped |
| Disposable infrastructure | `infra-status` — `{"serviceCount":2}` because the approved disposable caddy/mongo infrastructure remains running; host process manifest is removed and ports 19005/19006/19010/19011 are stopped. Do not claim final serviceCount 0 until the approved final lifecycle runs `infra-down`. |

## Named subproof evidence

- `covers-writer-fence`: four real Node writer routes (`producttypes.cover`, `flashsales.banner`, `articles.image`, `rewards.imageUrl`) incremented the same managed asset acquisition fence and retained durable rows.
- `covers-delete-race-rescan`: guarded deletion pause, real article writer, final `409 ASSET_IN_USE`, asset remained `available`, and Rust fault evidence was consumed.
- `folder-readiness-fail-closed`: icons/popups/instructions returned `503 MANAGED_ASSET_REGISTRY_UNAVAILABLE`; marked synthetic not-ready covers writer also kept covers deletion fail closed.
- `post-fence-nonreclaimable`: real create request returned `SLIDER_COMMIT_UNKNOWN`; claim retained durable transaction start and was not reclaimable.
- `complete-wins-unknown-mark`: real completed create remained `completed` with frozen result and `commitUnknown != true` after the conditional unknown-mark attempt.
- Lifecycle: real create/update/activate/deactivate/archive/restore/reorder exercised; archive released and restore reacquired managed reference rows.
- Limits/contention: real same-revision concurrent create had one winner and one conflict/unknown; active and total limits returned exact conflict codes; order contention used the complete current ID set.
- Public freshness/sanitization: ETag/304 and legacy HTTP link disclosure as empty string were asserted.
- Gateway response-loss: exact slider mutation paths were exercised through `host-up-session-fault`; downstream loss required 502/503 and `slider_response_loss_after_commit` evidence.

## Concerns / residuals

- The full 16-scenario fault inventory is closed and runtime seams are wired for the disposable proof. The integration uses focused real requests for load-bearing claim/recovery cases and a separate one-shot inventory check for the complete list; it is not an independent Mongo process-kill/failover harness for every underlying server failure mode.
- `rustfmt` is unavailable in the environment, so `cargo fmt --check` was not run.
- Final whole-matrix/browser Task 17 verification remains pending. This report does not claim `LOCAL DEV VERIFIED` or final infrastructure `serviceCount:0`.

## Cleanup scope

All created database rows are marked with the current fixture run ID and cleanup predicates require `task16Fixture: true` plus that run ID. Uploaded cover files are removed only by generated filenames tracked by the test. Production IDs and broad collection deletes are not used.
