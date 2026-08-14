# Task 8 report: permanent slider claims

## Scope

Task 8 was completed inline on the existing `main` checkout. The preserved claim implementation in `rust-api/src/routes/content/slider_idempotency.rs` was audited against the brief. The only code change made in this continuation was the focused test-fixture correction: `completed_claim_cannot_be_overwritten_by_commit_unknown` now builds the claim from the same `SliderClaimBinding` used to build the conditional filter. No production fence or filter was weakened.

## RED evidence

Command (from `rust-api`):

```text
cargo test slider_idempotency -- --nocapture
```

Before the fixture correction, the focused suite ran 8 claim tests with 7 passing and 1 failing. The failure was the positive-precondition assertion in `completed_claim_cannot_be_overwritten_by_commit_unknown`: the fixture and filter each called `binding()` independently, producing different random operator/target IDs. The completed-claim negative assertion itself remained protected by the state/response fence.

## GREEN evidence

Final focused claim suite:

```text
cargo test slider_idempotency -- --nocapture
```

Result: 8 passed, 0 failed.

Additional required checks:

```text
cargo test managed_asset_registry -- --nocapture
```

Result: 9 passed, 0 failed.

```text
cargo check --bin webtopup-rust-api
```

Result: passed.

```text
git diff --check
```

Result: passed.

## Contract audit

- Permanent unique `{ key: 1 }` claim index plus non-TTL state/lease and commit-unknown investigation indexes are preserved.
- Binding keeps key, contract version, operator, action, target, expected revision, and payload digest as separate durable fields; canonical policy input/digest binds the action dimensions.
- Begin/replay/conflict/in-progress/commit-unknown outcomes, token and lease-generation fences, and five-minute pre-transaction reclaim are implemented.
- Recovery IDs are preallocated and immutably stored before the transaction-start fence; create candidate ID, audit ID, and candidate result revision are retained.
- Fenced claims with `transactionStartedAt` are not reclaimable. `commitUnknown` remains terminal and does not re-execute.
- Frozen responses enforce the 256 KiB bound; replay changes only the derived `replayed` flag.
- Completion and conditional commit-unknown updates match the exact token/binding/generation/start fence and require an incomplete claim without a frozen response, so completed results cannot be overwritten.
- Recovery reads are bounded and conservative, never invoke mutation closures, and return `CommitUnknown` unless a completed frozen result is proven.
- No mutation route or capability marker was exposed; the read-only capability gate remains disabled.

## Residual risks

Mongo-backed claim races and ambiguous-commit behavior were not exercised against a live database because services were not started. Task 9 must wire these pure/session primitives into the transaction orchestration and preserve their conservative recovery semantics. `cargo fmt --check` remains unavailable because `rustfmt` is not installed, per the brief.
