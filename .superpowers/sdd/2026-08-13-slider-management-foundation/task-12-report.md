# Task 12 report — slider client intents

## Status
GREEN for the scoped pure client contracts and step-up provenance regression. No services, production systems, packages, UI slider page, or Task 13/14 work were run.

## RED
- Command: `cd client && node --import tsx --test src/lib/sliderManagement.test.ts`
- Expected failure observed before production implementation: `ERR_MODULE_NOT_FOUND` for `client/src/lib/sliderManagement.ts`.
- The step-up regression test was written before implementation; it initially exposed the existing retry seam's array-header handling during the focused test run. The production retry safety helper was then corrected without changing the gateway-local/reached-Rust policy.

## GREEN implementation
- Added runtime-safe, browser-independent `sliderManagement.ts` contracts.
- Legacy arrays and malformed present marker/revision/snapshot values parse read-only and never enable writes; only exact `slider-revision-v1` plus validated revision, sliders, and limits enables mutation.
- Added injectable crypto UUID intent keys (`slider_<UUID>`), same-intent retry cloning with stable key/action/target/revision/payload, and new-key rebasing.
- Added exact revisioned create/update/archive/restore/reorder methods, URLs, envelopes, and `Idempotency-Key`; no legacy flat mutation body is generated.
- Added nested error/version-conflict parsing, explicit `SLIDER_COMMIT_UNKNOWN` investigation copy with no retry language, and four-way three-way conflict classification.
- Hardened `withStepUp` stable-key recognition so an existing slider key remains available through `AUTH_STEP_UP_REQUIRED` and auth retry; no-key/reached-Rust outcomes remain non-retryable.

## Validation
- `cd client && node --import tsx --test src/lib/sliderManagement.test.ts`: PASS (7 tests).
- `cd .. && node --import tsx --test tools/dev-verification/unit/stepUpOrchestration.test.ts`: PASS (4 tests).
- `npm --prefix client run build`: PASS.
- `git diff --check`: pending final scoped diff check.

## Residual risks
- This task adds pure contracts only; live Node↔Rust/Mongo integration, UI wiring, and production behavior were not claimed or exercised.
- Existing repository build emits unrelated Vite dynamic-import warnings.
