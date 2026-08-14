# Task 10 lifecycle completion report

## Status
GREEN for the scoped Rust implementation; no live Mongo services were started.

## RED evidence
- Initial `cargo check --bin webtopup-rust-api` failed only because `build_slider_domain_audit_document_with_order` was missing at `slider_mutation.rs:1333`.
- The focused reorder behavior test initially exposed duplicate-ID acceptance in the exact-set helper; the helper now rejects duplicate IDs.

## GREEN implementation
- Added the minimal order-aware audit helper by extending the existing sanitized audit builder. It records complete old/new order arrays, old/new digests, transition digest, lifecycle/order/reference classification, and re-sanitizes the final document. Raw idempotency keys remain excluded.
- Archive marks the session-loaded current slider archived/inactive, records archive actor/time, releases exact managed references, fail-closes registry/reference inconsistencies, preserves legacy images/classification, and compacts remaining current orders.
- Restore validates archived state, canonical cover path, final file, available registry asset, reacquires the exact reference, restores an inactive active-lifecycle draft, and appends within the total limit.
- Reorder validates the authoritative full current set, unique IDs, contiguous orders, writes every current slider in-session, and uses public-relative-order sensitivity plus full order audit evidence.
- Legacy DELETE and sort-order routes remain structured 405 closures with exact codes.

## Required validation
- `cd rust-api && cargo test slider_archive -- --nocapture`: PASS (2 focused tests).
- `cargo test slider_restore -- --nocapture`: PASS (2 focused tests).
- `cargo test slider_reorder -- --nocapture`: PASS (1 focused test).
- `cargo test slider_concurrency -- --nocapture`: PASS (1 focused test).
- `cargo test slider_idempotency -- --nocapture`: PASS (16 tests).
- `cargo test managed_asset_registry -- --nocapture`: PASS (9 tests).
- `cargo check --bin webtopup-rust-api`: PASS (warnings only).
- `cd .. && git diff --check`: PASS.

## Residual live Mongo risks
Replica-set transaction behavior, same-session claim/revision races, registry transitions under failover, ambiguous commit recovery, and response-loss behavior remain unexercised because services were not started. No production data or indexes were touched.

## Task 10 review fix round 1
### Finding
The order-aware slider audit helper added `ordering.oldDigest`, `ordering.newDigest`, and `ordering.digest`, but the shared sanitizer redacted every normalized key containing `digest`, removing required nonsecret full-order integrity evidence. Digest-like authorization and payload fields must remain redacted.

### RED
Added `services::audit_sanitize::tests::slider_audit_sanitizer_preserves_ordering_evidence_without_widening_redaction`, covering all three approved ordering evidence keys, `result.evidence`, arbitrary digest fields, authorization digest fields, and payload digests. The focused test initially failed to compile because the scoped slider sanitizer did not exist.

### GREEN
Added a context-scoped `sanitize_slider_audit_document` policy. Only exact keys under the top-level `ordering` object (`oldDigest`, `newDigest`, `digest`) bypass digest redaction; the shared sanitizer remains strict for all other documents and fields. The order-aware slider audit helper now uses this policy. Raw idempotency keys continue to be represented only by their hash.

### Validation
- `cd rust-api && cargo test audit_sanitize -- --nocapture`: PASS (3 tests).
- `cd rust-api && cargo test slider_archive -- --nocapture`: PASS (2 tests).
- `cargo check --bin webtopup-rust-api`: PASS (warnings only).
- `cd .. && git diff --check`: PASS.
