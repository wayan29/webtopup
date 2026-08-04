# API v2 Transaction Recheck Review

Last updated: 2026-05-02

## Scope

- Candidate endpoint: `POST /transactions/:id/recheck`.
- Current public v1 route: `POST /v1/transactions/:id/recheck` with `authenticate` and `processManualTransaction` permission.
- Public v2 route: `POST /api/v2/transactions/:id/recheck` through the Node gateway.
- Internal Rust route: `POST /v2/transactions/{id}/recheck`; requires proxy context.
- This review covers vendor status recheck only. It does not migrate transaction creation, direct provider top-up, provider callbacks/webhooks, or guest transaction recheck flows.

## Current v1 Behavior

- Validates `id` as Mongo ObjectId and returns `400 ID transaksi tidak valid` for invalid ids.
- Requires authenticated operator context; the Node route enforces `processManualTransaction`.
- Loads the transaction by id and populates product fields `name code vendor`.
- Returns `404 Transaction not found` when missing.
- Allows recheck only for `pending` or `processing` transactions.
- Returns `400 Hanya transaksi pending/proses yang bisa dicek ulang ke vendor` for terminal transactions.
- Calls `vendorService.checkStatus` with:
  - `trxId`: `transaction.vendorTrxId || transaction._id.toString()`.
  - `vendorTrxId`: `transaction.vendorTrxId`.
  - `vendorName`: `product.vendor.name`.
  - `productCode`: `product.vendor.sku || product.code`.
  - `target`: `transaction.target`.
- If the vendor result is missing or returns `pending`, v1 does not mutate the transaction and returns:
  - `changed: false`.
  - `status`: current transaction status.
  - `message`: vendor message or `Vendor masih mengembalikan status pending`.
  - populated `transaction` in the controller response.
- If the vendor returns `success` or `failed`, v1 calls the same status transition helper used by manual status update.
- The generated status update payload is:
  - `status`: vendor status.
  - `sn`: vendor `sn`.
  - `note`: `Vendor recheck: ${vendorStatus.message || vendorStatus.status}`.
- Success response is:
  - `changed`: boolean.
  - `status`: vendor status or current status for no-op pending.
  - `message`: vendor message, `Status vendor ${status}`, or pending fallback message.
  - `transaction`: populated transaction.

## Vendor Adapter Behavior

- `vendorService.checkStatus` chooses adapter by vendor name from DB config first and falls back to environment/default values.
- Digiflazz adapter:
  - endpoint: `POST {baseUrl}/transaction`.
  - payload includes `username`, `buyer_sku_code`, `customer_no`, `ref_id`, and `sign`.
  - requires product code and target; missing values return pending with `Digiflazz status check requires product code and target number`.
  - errors are logged and normalized to `{ status: 'pending', message: 'Status check failed' }`.
- Tokovoucher adapter:
  - endpoint: `POST {baseUrl}/v1/transaksi/status`.
  - payload includes `ref_id`, `member_code`, and `signature`.
  - errors are logged and normalized to `{ status: 'pending', message: 'Status check failed' }`.
- Adapter status outputs are limited to `pending`, `success`, or `failed`.

## Write Set

- No write occurs when vendor returns missing or `pending`.
- When vendor returns `success` or `failed`, writes are identical to the reviewed transaction status update path:
  - `transactions`: status/refunded/statusUpdatedBy/statusUpdatedAt/statusUpdateNote/SN updates.
  - `users`: possible balance credit/debit depending on `refunded` and target status.
  - `users.points`: possible point award/revoke.
  - `pointtransactions`: possible point history insert.
- Recheck does not set `vendorTrxId` from the checkStatus result in current v1; only `sn` and status update note are passed to the transition helper.
- Recheck does not insert `userbalanceadjustments` audit rows.

## Current Atomicity Model

- Vendor call happens before any database mutation.
- If vendor returns pending or throws internally, v1 treats it as no-op pending and does not mutate state.
- If vendor returns a terminal status, v1 delegates to `updateTransactionStatusWithTransaction`.
- If Mongo transactions are unsupported, v1 delegates to `updateTransactionStatusWithCompensation`.
- Therefore all balance/points/refunded rollback behavior is inherited from the transaction status update implementation.

## Risks

- This endpoint performs a live provider call and must not be exercised by default smoke tests against live credentials.
- A client retry can repeat the provider status check. If the vendor returns terminal status both times, the second local transition should avoid duplicate balance/point effects through the status/refunded/points guards, but it still refreshes status metadata.
- The provider can return stale terminal data while a webhook/manual admin already updated the local transaction; local guarded update must detect races.
- If the provider returns `failed`, the status transition can credit user balance and mark `refunded = true`.
- If the provider returns `success`, the status transition can award points or debit a previously refunded transaction.
- Missing product vendor SKU/code or target silently returns pending for Digiflazz rather than an error.
- Recheck currently does not persist a vendor transaction id returned by a status check. A Rust migration should not add that behavior unless deliberately approved.
- Implementing this in Rust would duplicate provider signing, credential lookup, timeout/error normalization, and status mapping that currently live in Node adapters.

## API v2 Design Requirements

- Add an explicit Node gateway route before the generic `/transactions/*` rule if implemented in Rust:
  - `app.post('/transactions/:id/recheck', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, proxyRequest);`
- Rust handler must reject direct Rust calls without proxy context with `403 API v2 proxy access required`.
- Rust must use `x-webtopup-user-id` from proxy context as `processorId` for the downstream status transition.
- Permission must remain `processManualTransaction`, not `viewTransactions`.
- Response shape must preserve `changed`, `status`, `message`, and populated `transaction`.
- Terminal vendor statuses must reuse the same transition semantics as `PUT /transactions/:id/status`.
- Provider credentials, request signing, base URL selection, response mapping, and error normalization must match Node adapters.
- Keep admin UI on v1 direct or v2-first fallback only after sandbox/provider parity is proven.

## Implemented API v2 Behavior

- Node gateway route is explicit and protected with `authenticate` plus `processManualTransaction` before generic `/transactions/*` routing.
- Rust rejects direct calls without proxy context with `403 API v2 proxy access required`.
- Rust uses forwarded `x-webtopup-user-id` as the processor id for status update metadata.
- Rust preserves invalid id, missing transaction, and terminal-status rejection messages.
- `PROVIDER_MODE=mock` supports deterministic provider status outcomes through `PROVIDER_MOCK_RECHECK_STATUS` and smoke scenario markers `mock-status-pending`, `mock-status-success`, and `mock-status-failed`.
- Digiflazz and Tokovoucher live/sandbox-compatible status checks are implemented in Rust with the same signing/status mapping and pending-on-error normalization as the Node adapters.
- Pending provider status does not mutate the transaction and returns `changed=false`.
- Success/failed provider statuses reuse the v2 transition semantics for balance, points, `refunded`, SN, status metadata, guarded concurrency, and compensation rollback.
- Admin transaction UI calls v2 first and falls back to v1.

## Implementation Options Considered

### Option A: Keep Recheck On Node v1 For Now

- Lowest risk.
- Avoids duplicating provider adapters in Rust.
- Current API v2 can still cover manual status update, which is the local mutation side of a successful recheck.
- Recommended until provider sandbox credentials or adapter abstractions are available for automated parity tests.

### Option B: Proxy Recheck Internally To Node Logic

- Public request could be v2-shaped, but Node still performs the provider call and local status transition.
- This does not add much value because the endpoint is already Node-owned and protected.
- Avoids Rust provider duplication but complicates routing semantics.

### Option C: Full Rust Provider Recheck

- Requires Rust implementations for Digiflazz and Tokovoucher check-status signing, credential lookup, timeout handling, and status mapping.
- Requires sandbox/mock smoke to avoid live provider calls.
- Should be implemented only after a provider abstraction strategy is agreed.

## Smoke Strategy

- Default portable mutation smoke:
  - Direct Rust proxy-boundary test only if the route exists.
  - Gateway invalid id can return `400 ID transaksi tidak valid` without calling provider.
  - Missing transaction can return `404 Transaction not found` without calling provider.
  - Terminal-status local transaction can return `400 Hanya transaksi pending/proses yang bisa dicek ulang ke vendor` without calling provider.
- No default smoke should call live Digiflazz or Tokovoucher endpoints.
- Provider-backed smoke must be opt-in with explicit sandbox/mock env such as `RUN_API_V2_PROVIDER_SMOKE=1`.
- Sandbox/mock smoke should cover:
  - vendor pending no-op response.
  - vendor success transition through the status update path.
  - vendor failed transition through the status update path.
  - provider error normalized to pending no-op.
  - fixture cleanup and balance/points restoration.

## Outcome

`POST /transactions/:id/recheck` has been migrated to API v2 after provider mock strategy and smoke coverage were added. Keep v1 fallback until a production-like dry run confirms provider parity with real configured vendors.
