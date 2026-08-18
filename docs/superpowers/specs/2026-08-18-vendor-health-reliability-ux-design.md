# Vendor Health Reliability and UX Design

**Date:** 2026-08-18
**Status:** Approved from read-only `/admin/vendor-health` audit

## Goal

Make `/admin/vendor-health` an honest operational screen: provider and database failures must never masquerade as zero/healthy data, realtime health is authoritative, refresh behavior is predictable, and desktop/mobile users receive concise Indonesian diagnostics without weakening permission or step-up boundaries.

## Scope

### Authoritative data model

- `GET /api/v2/vendors/health` remains the authoritative operational health response because it includes live balance probes, transaction statistics, webhook state, and Digiflazz Seller callback state.
- `GET /api/v2/vendors/health-snapshot` becomes a compact MongoDB diagnostics response. It must not render a second competing set of authoritative vendor-health cards.
- Both responses expose explicit honesty metadata:
  - `ok: boolean`
  - `partial: boolean`
  - `issues: Array<{ code: string; source: string }>` using stable, non-secret codes
- The realtime response also exposes `snapshotPersisted: boolean`, reporting whether the latest payload was successfully persisted for notification builders.
- Missing Mongo client or inability to query the vendor collection is a core failure and returns `503` with structured non-secret diagnostics.
- Failure of an auxiliary query (transactions, webhook aggregate, last webhook, or seller summary) returns a usable `200` partial response with an issue code. Failed sources are labelled unavailable; they are not silently represented as healthy zeroes.
- Provider balance failure is represented per vendor as `balanceOk: false`, no usable numeric balance, a sanitized `balanceMessage`, and non-healthy vendor status. It also contributes a stable top-level issue code.

### Provider probes

- Digiflazz and Tokovoucher balance probes return `Result<Value, String>`.
- Both use one bounded request timeout of **8 seconds** in production.
- Tests can supply a shorter timeout through an internal helper; no new dependency is introduced.
- A non-success HTTP status, transport error, malformed JSON, missing balance field, or non-numeric balance is an error—not balance zero.
- Existing callers are updated consistently:
  - test connection reports `success: false`;
  - save settings rejects unverifiable credentials;
  - balance endpoints return an explicit upstream error rather than a fake zero;
  - Vendor Health marks the probe unavailable.

### Health semantics

- Realtime health uses these operator-facing states:
  - `healthy`: configured, active, balance available, no warning signals;
  - `warning`: low balance, pending threshold exceeded, or nonzero failed transactions;
  - `critical`: credentials missing, balance unavailable, more than five failures, or a rejected webhook;
  - `disabled`: vendor was intentionally disabled;
  - `unknown`: client fallback for malformed/unknown input.
- An intentionally disabled vendor is neutral `disabled`, not `critical`.
- When transaction total is zero, the UI shows **Belum ada transaksi** instead of `0%` success.
- Unavailable balance is shown as **Tidak tersedia**, never `Rp0`.

### Persistence and notifications

- `persist_vendor_health_snapshot` returns its MongoDB result instead of discarding it.
- Persistence failure is logged as structured warning/error without including credentials, raw provider bodies, headers, or URLs containing secrets.
- Persistence failure does not discard successfully fetched metrics, but makes the response partial and sets `snapshotPersisted: false`.
- The persisted document keeps the existing `vendors` shape consumed by notification builders so low-balance and balance-check alerts remain compatible.

### Client architecture

- Add a pure `client/src/lib/vendorHealth.ts` module for API types, fail-closed parsers, localized health metadata, freshness classification, and zero-transaction presentation.
- `VendorHealth.tsx` owns React data orchestration and rendering only.
- API contract normalization is explicit:
  - realtime fields are camelCase;
  - snapshot API keeps its current snake_case outer keys, but the parser normalizes them to one camelCase client model;
  - snapshot transaction fields from Rust are correctly read as `successRate` and `amountTotal`.
- Unknown/malformed responses remain renderable only as degraded diagnostics; the client never invents `ok: true`.

### Refresh and freshness

- The global AdminLayout action **Segarkan Kesehatan Vendor** is the only refresh control.
- `VendorHealth.tsx` listens to `admin:refresh-current-page` and refreshes realtime + snapshot together.
- The page-local **Refresh** and **Refresh Snapshot** buttons are removed; **Ekspor CSV** remains.
- Initial load and global refresh use latest-request-wins guards so an older response cannot overwrite newer data.
- No automatic polling is added in this release.
- Freshness uses the server `generatedAt/generated_at` value:
  - `fresh`: age <= 2 minutes;
  - `stale`: age > 2 minutes;
  - `unknown`: missing or invalid timestamp.
- The UI displays relative freshness and the absolute Indonesian timestamp. Stale data remains visible with an explicit warning.

### Page hierarchy

1. One operational summary row: vendor requiring attention, pending, failed, low balance.
2. One compact diagnostics panel for API/Mongo source status, generation time, issue codes, and snapshot persistence.
3. One authoritative card per realtime vendor.
4. One Digiflazz Seller Callback panel.
5. One low-balance action panel when applicable.

The Mongo snapshot does not duplicate vendor cards. Summary grids use responsive counts that do not leave a fifth card orphaned in a four-column layout.

### Language and accessibility

- Operational copy is Indonesian: **Sehat, Perlu perhatian, Kritis, Dinonaktifkan, Tidak diketahui, Terhubung, Terganggu, Ekspor CSV, Pengaturan, Diperbarui**.
- Internal API identifiers and stable issue codes remain English machine identifiers.
- The root exposes `aria-busy`.
- Loading and successful refresh feedback use `role="status"`; errors and stale/partial warnings use `role="alert"` where immediate announcement is appropriate.
- Decorative icons use `aria-hidden="true"`.
- Every button has `type="button"` and an explicit accessible name.
- Existing step-up dialog remains mounted and focus behavior is preserved.

### Security boundaries

- Reads remain `authenticate + manageVendors` at the gateway.
- CSV export remains `authenticate + manageVendors + requireStepUp('exports.sensitive')` at the gateway and `require_trusted_step_up_group(..., "exports.sensitive")` in Rust.
- No new mutation, permission, action group, cookie, CSRF, trusted-proxy, or idempotency behavior is introduced.
- No credentials, provider signatures, raw provider responses, Mongo errors, or internal URLs are returned to clients, CSV, logs, or retained test reports.

## Testing

- Rust unit tests cover provider probe success/error/timeout, health classification, snapshot partial/core failure, persistence-result mapping, and CSV issue fields/formula escaping.
- Gateway source-contract tests pin the permission and export step-up route ordering.
- Disposable integration tests use exact database `webtopup_task14_dev` to prove manager/denied access, structured health contracts, and export step-up.
- Playwright desktop/mobile tests cover global refresh, no local duplicate refresh, authoritative cards, compact diagnostics, freshness/stale/partial states, zero-transaction and unavailable-balance copy, and accessible status/error semantics.
- Add Vendor Health checks to the required verification matrix.

## Non-goals

- No automatic polling.
- No package installation or new dependency.
- No changes to provider transaction execution or product synchronization beyond adapting balance-probe callers to explicit errors.
- No removal of legacy Node vendor files in this release.
- No dashboard redesign, notification-system redesign, provider credential UI redesign, or new monitoring backend.
- No production migration, provider call, deployment, restart, or GitHub push without a later explicit approval.

## Acceptance Criteria

1. Digiflazz transport/schema failure cannot produce `balanceOk: true`, `Rp0`, or healthy status.
2. Snapshot/query failure cannot produce `ok: true` with empty healthy-looking totals.
3. Auxiliary-source and persistence failures are explicit partial states with stable issue codes and no secrets.
4. Realtime health is the only authoritative vendor-card set; snapshot is compact diagnostics.
5. Global refresh reloads both datasets, stale responses cannot overwrite newer results, and no local refresh buttons remain.
6. Freshness, unavailable balance, zero-transaction, disabled-vendor, and localized health states render correctly.
7. `manageVendors` and `exports.sensitive` boundaries remain enforced end to end.
8. Focused Rust/client/gateway/integration/browser tests and the full disposable matrix pass before any production release.
