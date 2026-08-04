# API v2 Transaction Status Review

Last updated: 2026-05-02

## Scope

- Candidate endpoint: `PUT /transactions/:id/status`.
- Current public v1 route: `PUT /v1/transactions/:id/status` with `authenticate` and `processManualTransaction` permission.
- Intended public v2 route: `PUT /api/v2/transactions/:id/status` through the Node gateway.
- Internal Rust route would be `PUT /v2/transactions/{id}/status` and must require proxy context.
- This review covers manual/admin status transitions and the shared transition function used by vendor recheck. It does not migrate transaction creation, provider recheck, provider callbacks, or direct provider calls.

## Current v1 Behavior

- Validates `id` as Mongo ObjectId and returns `400 ID transaksi tidak valid` for invalid ids.
- Requires authenticated operator context; the Node route enforces `processManualTransaction`.
- Validates body `status` as one of `pending`, `processing`, `success`, or `failed`.
- Returns `400 Status transaksi tidak valid` for invalid status.
- Accepts optional `note` or `message`, trimmed to at most 500 characters.
- Returns `400 Catatan status maksimal 500 karakter` when the note is too long.
- Accepts optional `vendorTrxId`, trimmed to at most 120 characters.
- Returns `400 Vendor Trx ID maksimal 120 karakter` when too long.
- Accepts optional `sn`, trimmed to at most 300 characters.
- Returns `400 SN / Token maksimal 300 karakter` when too long.
- Loads the transaction by id and returns `404 Transaction not found` when missing.
- Computes an audit note as the provided note, or `Manual status update: ${previousStatus} -> ${nextStatus}`.
- Returns `{ message: 'Transaction updated', transaction }` where transaction is populated with product, user, and statusUpdatedBy.

## Transition Rules

The v1 `applyTransitionPlan` is intentionally simple and status-driven:

- If next status is `failed` and `refunded` is false:
  - credit user balance by transaction amount.
  - set `refunded = true`.
- If next status is not `failed` and `refunded` is true:
  - debit user balance by transaction amount.
  - set `refunded = false`.
- If previous status is not `success` and next status is `success`:
  - award points for the transaction amount.
- If previous status is `success` and next status is not `success`:
  - revoke net awarded points for the transaction.

Important consequence: moving `failed -> pending`, `failed -> processing`, or `failed -> success` recharges the user's balance by debiting the previously refunded amount. If the user no longer has enough balance, v1 returns:

- `400 Saldo user tidak cukup untuk memproses ulang transaksi. Dibutuhkan Rp{amount}.`

## v1 Write Set

- `transactions`:
  - `$set status` to the requested status.
  - `$set refunded` to the transition result.
  - `$set statusUpdatedBy` to the processor ObjectId.
  - `$set statusUpdatedAt` to the current time.
  - `$set statusUpdateNote` to the supplied note when non-empty; otherwise `$unset statusUpdateNote`.
  - `$set vendorTrxId` when a non-empty `vendorTrxId` is provided.
  - `$unset vendorTrxId` when `vendorTrxId` is explicitly provided as an empty string.
  - `$set sn` when a non-empty `sn` is provided.
  - `$unset sn` when `sn` is explicitly provided as an empty string.
- `users`:
  - `$inc balance` by the transition balance delta.
  - negative deltas are guarded by `balance >= amount`.
- `users` points field:
  - `$inc points` by awarded points or revoked points.
  - revocation is guarded by `points >= netPoints`.
- `pointtransactions`:
  - insert positive `earn` records when awarding points.
  - insert negative `admin_adjustment` records when revoking points.
  - `relatedTransaction` is set to the transaction id.

No `userbalanceadjustments` row is inserted by manual status update in v1. Balance movement is represented only by the transaction state and `refunded` flag.

## Points Parity

- Awarding uses `Settings.findOne({ key: 'points_per_transaction' })`; missing or non-numeric setting falls back to `100`.
- Award formula is `Math.floor(transaction.amount / 10000) * pointsPerUnit`.
- Awarding is skipped when the computed points are `<= 0`.
- Awarding is skipped when the related transaction already has positive net points.
- Revocation sums existing `pointtransactions` by `{ user, relatedTransaction }` and revokes the positive net total.
- Revocation inserts an `admin_adjustment` row with negative points and the same related transaction.
- If point revocation fails because the user lacks enough points, v1 throws and rolls back earlier mutations where possible.

## Current Atomicity Model

- v1 first tries Mongo sessions/transactions.
- If Mongo transactions are unsupported, v1 falls back to a compensation path.
- Transaction-session order:
  - load transaction in session.
  - compute transition plan.
  - apply balance delta if needed.
  - revoke points before saving the new transaction status when leaving `success`.
  - save transaction status/refund/vendor/SN/admin metadata.
  - award points after saving the transaction when entering `success`.
- Compensation order:
  - load transaction and snapshot `status`, `refunded`, `vendorTrxId`, `sn`, `statusUpdatedBy`, `statusUpdatedAt`, `statusUpdateNote`, and `updatedAt`.
  - apply balance delta if needed.
  - revoke points if needed.
  - claim the transaction with `_id`, previous `status`, previous `refunded`, and previous `updatedAt`.
  - save transaction status/refund/vendor/SN/admin metadata.
  - award points if needed.
- Compensation rollback:
  - if the transaction was claimed, restore the transaction snapshot.
  - if points were awarded, revoke them.
  - if points were revoked, award them again.
  - if a balance delta was applied, apply the inverse balance delta.

## Risks

- This endpoint can credit or debit real user balance without a `userbalanceadjustments` audit row.
- This endpoint can award or revoke points and insert point history.
- Reprocessing a failed/refunded transaction can debit balance; insufficient balance must block the transition.
- `PUT /transactions/:id/status` currently would be caught by the generic API v2 `/transactions/*` gateway rule if implemented only in Rust. That generic rule uses `viewTransactions`, so a dedicated Node route with `processManualTransaction` must be registered before the wildcard.
- Recheck uses the same status update helper after calling the vendor. Any Rust v2 implementation must not change recheck semantics unless `POST /transactions/:id/recheck` is migrated at the same time.
- Concurrent provider callbacks, rechecks, refunds, and manual admin updates can race on `transactions.updatedAt`, `status`, `refunded`, user balance, and point transactions.
- v1 compensation can still leave inconsistencies if rollback fails after a balance or points mutation. Rust must keep rollback logs clear and smoke fixtures disposable.
- `refundedBy`, `refundedAt`, and `refundReason` are not managed by manual status update. The Rust implementation should not opportunistically add or remove them.

## API v2 Design Requirements

- Add an explicit Node gateway route before the generic `/transactions/*` rule:
  - `app.put('/transactions/:id/status', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, proxyRequest);`
- Keep `app.all('/transactions/*', hasPermission('viewTransactions'))` for read endpoints and non-migrated routes.
- Add Rust route:
  - `put(transactions::update_status)` at `/v2/transactions/{id}/status`.
- Rust handler must reject direct Rust calls without proxy context with `403 API v2 proxy access required`.
- Rust must use `x-webtopup-user-id` from proxy context as `processorId`.
- Validation/error parity must match v1 messages listed above.
- Return populated transaction parity with product, user, and statusUpdatedBy.
- Keep admin UI fallback to `/v1` until smoke and one production-like dry run pass.

## Proposed Rust Compensation Algorithm

Use compensation first unless Mongo transaction/session support is implemented in Rust for this codebase.

1. Validate proxy context, transaction id, processor id, and payload fields.
2. Load transaction by id.
3. Return `404 Transaction not found` when missing.
4. Snapshot transaction fields required for rollback:
   - `status`, `refunded`, `vendorTrxId`, `sn`, `statusUpdatedBy`, `statusUpdatedAt`, `statusUpdateNote`, and `updatedAt`.
5. Compute transition plan from current status, current refunded flag, amount, and requested next status.
6. Apply balance delta with atomic user update:
   - positive delta: `$inc balance` and require user exists.
   - negative delta: `$inc balance` with filter `balance >= amount`; if user exists but balance is insufficient, return the v1 insufficient-balance message.
7. Revoke points before claiming the transaction when leaving `success`.
8. Claim the transaction with a guarded `find_one_and_update` using:
   - `_id = transaction id`.
   - `status = snapshot.status`.
   - `refunded = snapshot.refunded`.
   - `updatedAt = snapshot.updatedAt`.
9. Update transaction status/refunded/vendorTrxId/SN/statusUpdatedBy/statusUpdatedAt/statusUpdateNote in the claim update.
10. Award points after the transaction claim when entering `success`.
11. On failure after any side effect:
    - restore transaction snapshot if claimed.
    - revoke points if awarded.
    - re-award points if revoked.
    - reverse balance delta if applied.
12. Return populated transaction with the same shape used by admin transaction pages.

## Idempotency And Race Behavior

- Repeating the exact same status update is not idempotent in the strict sense because it still refreshes `statusUpdatedBy`, `statusUpdatedAt`, and note metadata.
- Repeating a `failed` transition after the first refund should not credit balance again because `refunded` is already true.
- Repeating a `success` transition after points were already awarded should not award duplicate points because `awardPoints` checks positive net points for the related transaction.
- Concurrent status changes should allow one guarded claim only; the loser should return `409 Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.`.
- Concurrent balance or points changes must not produce negative balances or negative point balances.
- If user balance or points rollback fails, log the rollback failure and return `500 Internal Server Error`; smoke fixtures must be restored out-of-band in `finally` blocks.

## Response Parity

- Success status: `200`.
- Success body:
  - `message: 'Transaction updated'`.
  - `transaction`: populated transaction.
- Populated transaction should include at least:
  - `_id`, `user`, `product`, `target`, `amount`, `status`, `vendorTrxId`, `customerRefId`, `sn`, `message`, `refunded`, `refundedBy`, `refundedAt`, `refundReason`, `source`, `statusUpdatedBy`, `statusUpdatedAt`, `statusUpdateNote`, `createdAt`, `updatedAt`.
- `product` projection parity: `name code category brand vendor`.
- `user` projection parity: `name email`.
- `statusUpdatedBy` projection parity: `name email role`.

## Smoke Strategy

- Portable mutation smoke:
  - Direct Rust `PUT /v2/transactions/not-a-valid-id/status` without proxy context returns `403`.
  - Gateway invalid id returns `400 ID transaksi tidak valid` when the smoke user has `processManualTransaction`.
  - Invalid status returns `400 Status transaksi tidak valid`.
  - Overlong note/vendorTrxId/SN return their v1 validation messages.
  - Missing transaction returns `404 Transaction not found` for a syntactically valid ObjectId.
- Mongo-backed e2e smoke:
  - Insert disposable member, product, and transaction directly in Mongo.
  - Snapshot member balance and points.
  - Drive `pending -> failed` and assert balance credit plus `refunded = true`.
  - Drive `failed -> processing` and assert balance debit plus `refunded = false`.
  - Drive `processing -> success` and assert point award with related transaction.
  - Drive `success -> failed` and assert point revocation plus balance credit.
  - Verify explicit empty `vendorTrxId` and `sn` unset those fields.
  - Restore balance/points, delete matching point transactions, and delete disposable transaction/product/user in `finally`.
  - Do not call providers and do not use real customer transactions.

## Recommendation

## Implementation Status

- Implemented in Rust API v2 with compensation rollback.
- Node gateway uses explicit `processManualTransaction` permission for `PUT /api/v2/transactions/:id/status` before the generic `/transactions/*` rule.
- Admin transaction status UI uses v2-first with v1 fallback.
- Mutation smoke covers direct Rust proxy rejection, validation boundaries, missing transaction, and Mongo-backed status transitions using disposable records.
- Mongo-backed smoke verifies balance credit/debit, point award/revoke, `refunded` transitions, and explicit `vendorTrxId`/`sn` unset behavior.
- `POST /transactions`, `POST /transactions/:id/recheck`, and provider callbacks remain on v1.

## Recommendation

This migration is complete. Keep the v1 fallback in the admin transaction UI until the endpoint has production-like runtime confidence, then consider removing the fallback in a separate cleanup.
