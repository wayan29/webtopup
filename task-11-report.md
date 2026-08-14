# Task 11 report

## RED
- Rust capability-marker command initially failed because the marker helper/tests were absent (and the requested filtered test had zero matches).
- Node route/HMAC tests initially failed for missing slider gates, handshake headers/signing, public slider forwarding, and route closures.

## GREEN
- Rust `cargo test slider_capability_marker -- --nocapture`: 2 passed.
- Rust `cargo check --bin webtopup-rust-api`: passed.
- Node gateway/audit tests: 13 passed.
- Node auth middleware tests: 2 passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Split-deploy matrix evidence
- Both `/v2/sliders/admin/all` and `/v2/sliders/admin/archived` use exact GET/path/timestamp/correlation/HMAC validation and readiness gating.
- Static browser/old-generic capability headers are stripped; Node overwrites them only for new admin-read routes; response filtering denies capability headers.
- Expired timestamp, wrong method, wrong path, query-derived path, forged MAC, and cross-path assertions are rejected by Rust tests.
- New Rust + new Node + readiness false omits `mutationContract`; only valid new/new/ready assertions can emit it.
- Public sliders forward `If-None-Match`, preserve ETag/304/no-cache, and do not body-cache.
