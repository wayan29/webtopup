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
