# Task 9 report: transaction-only slider create/update

## RED evidence

The mutation module was first introduced with RED-only create/update seam tests that referenced the absent orchestrator. The focused `slider_mutation_create` compilation failed because the transaction entry point did not yet exist. This was the expected failure for Task 9 Step 2; no route or domain transaction was available at that point.

## GREEN implementation

Implemented `execute_slider_mutation` for create/update only. The route now performs permission/active-account and trusted-proxy verification, requires an idempotency key, checks startup transaction/index/registry readiness, normalizes the request, begins/resumes a permanent Task 8 claim, runs a read-only authoritative transaction preflight, applies effective `settings.sensitive` step-up policy, stores immutable recovery IDs, and durably fences the claim before the write transaction.

The write closure revalidates the revision and limits, acquires and swaps managed cover references through the Task 8/registry APIs, creates or updates the slider with a preallocated candidate ID, increments global revision exactly once, writes a sanitized domain audit, finalizes a bounded frozen claim result, and commits once. Commit-only retry uses the shared bounded protocol; ambiguous outcomes mark the claim conditionally as `commitUnknown` and never rerun the mutation. A guarded local response-loss fault seam is included. Legacy archive/restore/reorder/delete behavior and `mutationContract` remain outside this task.

## Validation

- `cd rust-api && cargo test slider_mutation_create -- --nocapture`: passed (1 focused policy test; build clean).
- `cd rust-api && cargo test slider_mutation_update -- --nocapture`: passed (1 focused policy test; build clean).
- `cd rust-api && cargo test slider_idempotency -- --nocapture`: passed (Task 8 claim suite).
- `cd rust-api && cargo test managed_asset_registry -- --nocapture`: passed (registry suite).
- `cd rust-api && cargo check --bin webtopup-rust-api`: passed.
- `git diff --check`: passed.

## Residual risks

Live Mongo transaction races, registry swaps, ambiguous commit recovery, and filesystem fault integration were not exercised because no services were started. The task preserves the existing legacy handlers in source for compatibility, while the registered create/update paths now point to the transaction orchestrator. Rust formatting remains unavailable as documented by prior tasks.

## Fix round 1

### RED evidence

Focused pure tests were added for the complete same-session write fence, unresolved recovery remaining `CommitUnknown` even when domain/audit evidence exists, and stale conflict response snapshots. The fence test initially failed to compile because `slider_claim_fence_filter_with_recovery` and `verify_slider_claim_fence_in_session` were absent; the recovery/snapshot tests likewise preceded their helpers. These were the intended RED seams before the production changes.

### GREEN implementation

- F1: added reusable `slider_claim_fence_filter_with_recovery` plus `verify_slider_claim_fence_in_session`; `write_transaction` performs this exact token/binding/generation/recovery-ID/start-time/incomplete/no-frozen-response check as its first session operation.
- F2: post-fence failures, session/start failures, operation failures, and response loss now use bounded recovery/conditional commit-unknown handling; durable fences are never converted to retryable execution or re-executed after abort.
- F3: stale revision frozen conflicts now include `expectedRevision`, `currentRevision`, and the latest current admin snapshot with sliders and limits; pure coverage asserts the shape.
- F4: ambiguous/response-loss paths perform majority recovery first; completed frozen results replay with `replayed: true`, otherwise the claim is conditionally marked commit unknown. Added completed replay and unresolved-unknown evidence tests.

### Fix-round validation

- `cd rust-api && cargo test slider_mutation_create -- --nocapture`: passed (1 test).
- `cd rust-api && cargo test slider_mutation_update -- --nocapture`: passed (1 test).
- `cd rust-api && cargo test slider_idempotency -- --nocapture`: passed (13 tests, including completed replay/unresolved unknown/fence tests).
- `cd rust-api && cargo test managed_asset_registry -- --nocapture`: passed (9 tests).
- `cd rust-api && cargo check --bin webtopup-rust-api`: passed.
- `git diff --check`: passed.

Residual live Mongo risks remain: same-session fence races, majority recovery under replica-set failover, ambiguous commit classification, registry swaps, and deliberate response-loss behavior were not exercised against live services; no services were started.

## Fix round 2

### RED evidence

Added focused pure RED seams for immediate pre-transaction step-up claim resumption and the complete sanitized domain-audit shape. Before the helpers were implemented, the claim filter and audit-shape assertions had no production seam and failed to compile; the body-limit source contract was likewise absent from the slider route definitions.

### GREEN implementation

- A: authoritative missing `settings.sensitive` proof now keeps the permanent claim and conditionally transitions it to `retryable` with an expired lease, without `transactionStartedAt`, `commitUnknown`, or a frozen response. The same key can reclaim immediately with token/binding/generation fencing; claims are never deleted.
- B: create and update slider JSON routes apply `DefaultBodyLimit::max(MAX_SLIDER_JSON_BYTES)` (`64 * 1024`) via the shared policy constant.
- C: request headers flow into `write_transaction`; effective sensitivity is recomputed there and exact trusted step-up proof is checked before registry/domain writes.
- D: same-transaction slider domain audit now includes action/target, actor id/role, revision before/after, normalized snapshots, changed fields, lifecycle/status, public impact, old/new ordering and digest, managed references acquired/released, hashed key, claim/audit identifiers, correlation source/trace, and result replay/commit-unknown evidence. Shared sanitizer is applied and raw keys/secrets are absent.

### Fix-round 2 validation

- `cd rust-api && cargo test slider_idempotency -- --nocapture`: passed (14 tests).
- `cd rust-api && cargo test slider_mutation_create -- --nocapture`: passed (1 test).
- `cd rust-api && cargo test slider_mutation_update -- --nocapture`: passed (1 test).
- `cd rust-api && cargo check --bin webtopup-rust-api`: passed.
- `git diff --check`: passed.

Residual live Mongo risks remain: claim reclaim races, transaction proof under replica-set failover, managed-reference swap behavior, and correlation values from live trusted gateway spans were not exercised; no services were started.

## Fix round 3

### RED evidence

Added focused source-contract tests for transaction-probe ordering, exact probe failure mapping, unresolved fenced-claim recovery, and step-up claim-transition handling. The first focused run failed to compile because the new probe error seam was absent (and the route contract include path was initially incorrect); these were the intended RED failures before implementation.

### GREEN implementation

- E: create/update now run a real session-bound, snapshot read-only Mongo transaction probe with majority abort before initial slider reads, normalization, claim creation, or any mutation work. Probe failures map to exact `503 SLIDER_TRANSACTIONS_UNAVAILABLE`.
- F: durable start-fence reads use majority concern; missing/ambiguous timestamps perform bounded read-only recovery and return exact `503 SLIDER_COMMIT_UNKNOWN`, conditionally marking unknown only when a start fence is proven. The unresolved path cannot retry execution or return `SLIDER_CLAIM_FENCE_LOST`.
- G: missing trusted step-up proof now checks `mark_slider_step_up_required`; failed transitions fail closed with a `503` claim/fence error, while successful transitions preserve `403 AUTH_STEP_UP_REQUIRED` and immediate same-key resume.

### Fix-round 3 validation

- `cd rust-api && cargo test slider_mutation_create -- --nocapture`: passed (focused source/policy tests; build clean).
- Remaining required focused suites and final check/commit are pending.

Residual live Mongo risks: replica-set transaction support and snapshot-read probe behavior, majority read visibility during failover, bounded recovery timing, and claim-transition races were not exercised against live services; no services were started.

## Fix round 4

### RED evidence

Added focused source/pure RED seams for ambiguous durable start-fence handling and stale preflight conflict ordering. The RED contract required recovery rather than direct `SLIDER_CLAIM_FENCE_LOST`, permanent sealing when a start outcome remains ambiguous, a pre-transaction completion helper, and proof that stale conflicts resolve before recovery IDs/start fencing and never in the write transaction.

### GREEN implementation

- H: failed or ambiguous `mark_slider_transaction_started` outcomes now enter bounded majority claim recovery. Completed frozen results replay; a proven start timestamp conditionally marks `commitUnknown`; an ambiguous timestamp is permanently sealed and returns exact `503 SLIDER_COMMIT_UNKNOWN`, preventing retryable reclamation.
- I: authoritative preflight now carries an optional frozen conflict body and latest admin snapshot. Stale expected revisions are completed with a majority conditional pre-transaction claim update requiring no `transactionStartedAt`; no domain, audit, managed-reference, metadata, or revision write occurs. Same-key retries replay the frozen conflict. The write transaction no longer fences stale conflicts.

### Fix-round 4 validation

- RED: added pure seams for permanent ambiguous-start sealing, conservative readiness classification, write-phase version-conflict freezing, latest snapshot shape, and no closure rerun. The pre-implementation contract failed because the seal update, readiness marker, and write conflict helper were absent.
- GREEN: ambiguous start-fence outcomes use bounded majority recovery, replay completed frozen claims, conditionally mark known-start claims unknown, and permanently seal ambiguous pre-start claims with `commitUnknown` plus `startFenceUnknown`; sealed claims cannot be reclaimed. A revision change after preflight now freezes a `409 SLIDER_VERSION_CONFLICT` with the latest snapshot in the fenced transaction, without rerunning mutation work.
- `cd rust-api && cargo test slider_mutation_create -- --nocapture`: passed (1 test; 0 failed).
- `cd rust-api && cargo test slider_mutation_update -- --nocapture`: passed (1 test; 0 failed).
- `cd rust-api && cargo test slider_idempotency -- --nocapture`: passed (16 tests; 0 failed).
- `cd rust-api && cargo test managed_asset_registry -- --nocapture`: passed (9 tests; 0 failed).
- `cd rust-api && cargo check --bin webtopup-rust-api`: passed (exit 0; warnings only).
- `git diff --check`: passed.

Residual live Mongo risks remain: majority conditional claim races, ambiguous start acknowledgement versus read visibility, snapshot preflight/write-phase races, registry swaps, and live same-key conflict replay were not exercised; no services were started.
