# API v2 Provider Sandbox Strategy

Last updated: 2026-05-02

## Purpose

This strategy defines the prerequisite sandbox/mock layer for safely migrating provider-backed API v2 workflows such as:

- `POST /transactions`.
- `POST /transactions/:id/recheck`.
- future provider realtime checks, retries, and sync flows.

Default smoke and local development must never call live Digiflazz or Tokovoucher endpoints unless explicitly opted in.

## Current State

- Node owns provider integrations through `server/src/services/vendorService.ts`.
- `vendorService` picks an adapter from vendor DB config first, then environment defaults.
- Digiflazz adapter directly uses axios against `{baseUrl}/transaction`, `{baseUrl}/cek-saldo`, and `{baseUrl}/price-list`.
- Tokovoucher adapter directly uses axios against member, product, top-up, and status endpoints.
- Provider errors are normalized inside adapters:
  - Digiflazz top-up error returns `failed` with `Connection Error`.
  - Digiflazz status error returns `pending` with `Status check failed`.
  - Tokovoucher top-up error returns `failed` with `Connection Error`.
  - Tokovoucher status error returns `pending` with `Status check failed`.
- Node and Rust provider mock mode exists via `PROVIDER_MODE=mock`; sandbox HTTP mode can be pointed at the local stub with `npm run provider:sandbox-stub` and explicit sandbox base URL envs. Local sandbox dry run has passed for transaction create/recheck pending/success/failed outcomes.
- API v2 mutation smoke intentionally skips transaction create/recheck because they can call live providers; API v2 provider smoke covers those paths only when explicitly opted in with mock or sandbox mode.

## Goals

- Make provider-backed smoke deterministic and opt-in.
- Keep production behavior unchanged by default.
- Avoid live provider calls in default CI/local smoke.
- Allow transaction create/recheck migration tests to exercise provider outcomes without external credentials.
- Preserve existing adapter response shape: `status`, `vendorTrxId`, `message`, `sn`.
- Support both top-up and check-status provider paths.

## Non-Goals

- Do not replace production provider adapters.
- Do not change provider credential storage in this step.
- Do not introduce provider callbacks/webhook simulation yet.
- Do not replace the dedicated transaction create/recheck migration reviews; this document only defines the safe provider test contract they use.

## Proposed Modes

Provider execution should support three explicit modes:

- `live`: current behavior. Calls real provider base URLs using DB/env credentials.
- `mock`: in-process deterministic mock, no network calls.
- `sandbox`: calls explicit sandbox/stub base URL, still over HTTP, but only when opted in.

Recommended environment variables:

- `PROVIDER_MODE=live|mock|sandbox`, default `live`.
- `RUN_PROVIDER_SMOKE=1`, required for any smoke that exercises provider-backed endpoints.
- `PROVIDER_MOCK_TOPUP_STATUS=pending|success|failed`, default `pending`.
- `PROVIDER_MOCK_RECHECK_STATUS=pending|success|failed`, default `pending`.
- `PROVIDER_MOCK_MESSAGE`, optional deterministic message.
- `PROVIDER_MOCK_SN`, optional deterministic serial/token.
- `PROVIDER_MOCK_BALANCE`, optional deterministic balance for `getBalance`, default `0`.
- `PROVIDER_MOCK_VENDOR_TRX_ID`, optional deterministic top-up vendor transaction id; defaults to `trxId`.
- `PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL`, required for Digiflazz sandbox mode.
- `PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL`, required for Tokovoucher sandbox mode.

Smoke-specific aliases can be added later if needed, but the application should use the provider-mode variables above so both Node and Rust can share the same contract.

## Mock Adapter Contract

Add a provider adapter that implements `IVendorAdapter` and returns deterministic results:

- `getBalance()` returns `PROVIDER_MOCK_BALANCE`, default `0`.
- `getPriceList()` returns an empty list unless a fixture file is configured.
- `topUp(trxId, productCode, target, serverId)` returns:
  - `status`: `PROVIDER_MOCK_TOPUP_STATUS`.
  - smoke-only scenario text in `target` can override status with `mock-status-pending`, `mock-status-success`, or `mock-status-failed` while `PROVIDER_MODE=mock`.
  - `vendorTrxId`: `PROVIDER_MOCK_VENDOR_TRX_ID` or `trxId`.
  - `message`: `PROVIDER_MOCK_MESSAGE` or `Mock top-up ${status}`.
  - `sn`: `PROVIDER_MOCK_SN` when status is `success`; otherwise optional empty.
- `checkStatus(trxId, vendorTrxId, productCode, target)` returns:
  - `status`: `PROVIDER_MOCK_RECHECK_STATUS`.
  - smoke-only scenario text in `productCode` or `target` can override status with `mock-status-pending`, `mock-status-success`, or `mock-status-failed` while `PROVIDER_MODE=mock`.
  - `message`: `PROVIDER_MOCK_MESSAGE` or `Mock status ${status}`.
  - `sn`: `PROVIDER_MOCK_SN` when status is `success`; otherwise optional empty.

The mock adapter should not read real credentials and should not make network calls.

## Sandbox HTTP Contract

Sandbox mode should still use provider-specific adapters, but with explicit sandbox base URLs:

- Digiflazz sandbox uses `PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL`.
- Tokovoucher sandbox uses `PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL`.
- Sandbox mode must fail fast at startup or first use when required sandbox base URL is missing.
- Sandbox smoke must still require `RUN_PROVIDER_SMOKE=1`.

The local stub server exposes compatible endpoints:

- Digiflazz:
  - `POST /transaction` for top-up and status check.
  - `POST /cek-saldo`.
  - `POST /price-list`.
- Tokovoucher:
  - `POST /v1/transaksi`.
  - `POST /v1/transaksi/status`.
  - `GET /member`.
  - `GET /member/produk/category/list`.
  - `GET /member/produk/operator/list`.
  - `GET /member/produk/jenis/list`.
  - `GET /member/produk/list`.
  - `GET /produk/code`.

## Vendor Service Selection

Recommended selection order in `vendorService.getAdapter`:

1. If `PROVIDER_MODE=mock`, return `MockVendorAdapter` regardless of vendor name.
2. If `PROVIDER_MODE=sandbox`, require sandbox base URL for the selected vendor and instantiate the existing provider adapter with that base URL.
3. Otherwise use current live behavior: DB vendor config first, then environment defaults.

This keeps production unchanged while giving smoke a deterministic path.

## API v2 Smoke Plan

Add a separate provider smoke script rather than expanding default mutation smoke:

- Script name: `npm run api-v2:smoke:providers`.
- Required env: `RUN_PROVIDER_SMOKE=1`.
- Recommended default env for mock mode:
  - `PROVIDER_MODE=mock`.
  - `PROVIDER_MOCK_TOPUP_STATUS=pending` or scenario-specific values.
  - `PROVIDER_MOCK_RECHECK_STATUS=pending` or scenario-specific values.
  - `MONGO_URI`/`MONGO_DB` for fixture setup and cleanup.
  - `SMOKE_MEMBER_EMAIL`/`SMOKE_MEMBER_PASSWORD` for user-facing transaction creation.

Provider smoke scenarios should be sequential and isolated:

1. Transaction create with mock pending:
   - Insert disposable active product and sufficient member balance.
   - Call `POST /api/v2/transactions`.
   - Assert balance debit, pending transaction, no points, no refund.
   - Restore balance and delete transaction/product.
2. Transaction create with mock failed:
   - Assert balance debited then refunded, transaction failed/refunded metadata set.
   - Restore balance and delete fixtures.
3. Transaction create with mock success:
   - Assert transaction success, balance debit, point award when eligible.
   - Restore balance/points and delete point transactions.
4. Transaction recheck mock pending:
   - Insert pending transaction directly.
   - Assert no mutation and `changed=false`.
5. Transaction recheck mock failed/success:
   - Insert pending/processing transaction directly.
   - Assert transition delegates to v2 status semantics.
   - Restore balance/points and delete fixtures.
6. Sandbox provider admin endpoints:
   - Snapshot and restore Digiflazz/Tokovoucher vendor docs, `dgcache`, and the marked sync product code.
   - Assert Digiflazz/Tokovoucher settings save validates credentials through the stub, persists config, and is restored afterward.
   - Assert Digiflazz/Tokovoucher balance and vendor connection tests return the stubbed balance.
   - Assert vendor health JSON and CSV export return provider-backed payloads.
   - Assert Digiflazz pricelist fetch rewrites `dgcache` from the stub, then restore the original cache.
   - Assert Digiflazz sync upserts one marked product and Tokovoucher sync preserves the legacy zero-count behavior, then restore products.
   - Assert Tokovoucher cascading read/search endpoints return stubbed data through the vendor `apiBaseUrl`.

Default `npm run api-v2:smoke:mutations` must continue to skip provider-backed create/recheck.

## Safety Rules

- Provider smoke must refuse to run unless `RUN_PROVIDER_SMOKE=1`.
- Provider smoke must refuse to run with `PROVIDER_MODE=live` unless a second explicit variable is set, for example `ALLOW_LIVE_PROVIDER_SMOKE=1`.
- Provider smoke accepts `PROVIDER_MODE=sandbox` only when `CONFIRM_PROVIDER_BACKEND_SANDBOX=1` confirms the backend and Rust API were started against sandbox/stub URLs.
- Live provider smoke should not be used in normal local/CI flows.
- Smoke fixtures must use marked product codes, targets, customer refs, and notes with a unique run suffix.
- Smoke must snapshot and restore member balance and points.
- Smoke must delete created transactions, point transactions, products, flash sale fixtures, and any test vendor config rows.
- Provider smoke should use the same lock-file pattern as mutation smoke to prevent parallel runs.

## Rust Migration Impact

Rust provider-backed transaction create/recheck now uses this contract directly:

- Implement provider adapters in Rust and follow the same `PROVIDER_MODE` contract. Done for transaction create/recheck.
- Keep provider calls in Node and let Rust own only database state transitions.
- Introduce an internal provider service boundary that both Node and Rust can call.

Recommended near-term follow-up:

- Keep default smoke provider-free.
- Use provider smoke with `PROVIDER_MODE=mock` for transaction create/recheck.
- Add sandbox HTTP stub coverage before removing v1 fallback or running live-provider smoke.

## Rollout Steps

1. Add `MockVendorAdapter` in Node implementing `IVendorAdapter`. Done.
2. Add `PROVIDER_MODE` selection in `vendorService` with default `live`. Done.
3. Add provider smoke script skeleton that refuses to run without opt-in. Done.
4. Add mock-mode smoke for transaction create/recheck boundaries and recheck outcomes. Done for API v2 paths.
5. Use that same smoke contract when API v2 transaction create/recheck migration is attempted. Done.
6. Run member transaction create e2e when `SMOKE_MEMBER_EMAIL`/`SMOKE_MEMBER_PASSWORD` are available. Done in local mock smoke with pending/success/failed outcomes.
7. Add a local sandbox HTTP stub for provider adapter dry runs. Done via `npm run provider:sandbox-stub`.
8. Run sandbox stub coverage in a production-like dry run. Done locally with 9 provider smoke checks.
9. Only after additional staging validation, consider live-provider smoke.

## Recommendation

Mock mode is implemented and shared by API v2 transaction create/recheck. Member-credential provider smoke create e2e has passed locally with pending/success/failed outcomes. A local sandbox HTTP stub is available through `npm run provider:sandbox-stub`; sandbox provider smoke has passed locally with 9 checks. Use staging validation before considering removal of v1 fallbacks or live-provider smoke.
