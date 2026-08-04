# API v2 Transaction Refund Review

Last updated: 2026-05-01

## Scope

- Candidate endpoint: `POST /transactions/:id/refund`.
- Current public v1 route: `POST /v1/transactions/:id/refund` with `authenticate` and `processManualTransaction` permission.
- Intended public v2 route: `POST /api/v2/transactions/:id/refund` through the Node gateway.
- Internal Rust route would be `POST /v2/transactions/{id}/refund` and must require proxy context.
- This review covers balance refund only. It does not migrate transaction creation, manual status update, provider recheck, or provider callbacks.

## Current v1 Behavior

- Validates `id` as Mongo ObjectId and returns `400 ID transaksi tidak valid` for invalid ids.
- Requires authenticated operator context; the Node route enforces `processManualTransaction`.
- Validates body `reason` with trimmed length 5-300 and returns `400 Alasan refund wajib 5-300 karakter`.
- Loads the transaction by id.
- Returns `404 Transaction not found` when missing.
- Returns `409 Transaksi ini sudah direfund` when `refunded` is already true.
- Returns `400 Transaksi sukses harus diubah ke failed dari edit status agar poin ikut direkonsiliasi` for successful transactions.
- Computes an audit reason as `Refund transaksi ${transactionId.slice(-8).toUpperCase()}: ${reason}`.
- Sets the transaction to failed and marks refund metadata.
- Credits the transaction user balance by `transaction.amount`.
- Inserts a `userbalanceadjustments` audit row with type `add`.
- Returns `{ message: 'Saldo transaksi berhasil direfund', transaction }` where transaction is populated with product, user, and statusUpdatedBy.

## v1 Write Set

- `transactions`:
  - `$set status = failed`.
  - `$set refunded = true`.
  - `$set refundedBy = processor ObjectId`.
  - `$set refundedAt = now`.
  - `$set refundReason = raw reason`.
  - `$set statusUpdatedBy = processor ObjectId`.
  - `$set statusUpdatedAt = now`.
  - `$set statusUpdateNote = built audit reason`.
- `users`:
  - increment/refund `balance` by `transaction.amount`.
- `userbalanceadjustments`:
  - insert `{ user, adjustedBy, type: 'add', amount, balanceBefore, balanceAfter, reason: built audit reason }`.

## Current Atomicity Model

- v1 first tries Mongo sessions/transactions.
- If transactions are unsupported, v1 falls back to a compensation path.
- Compensation path claim order:
  - Reads transaction and snapshots `status` and `updatedAt`.
  - `findOneAndUpdate` claims the refund with `_id`, `refunded: { $ne: true }`, and `updatedAt` equality.
  - Credits user balance.
  - Inserts `userbalanceadjustments`.
- Compensation rollback:
  - Deletes the audit adjustment if inserted.
  - Debits the user balance by `transaction.amount` if credited.
  - Rolls back transaction status/refund metadata if claimed.

## Risks

- Direct balance mutation makes this a critical financial endpoint.
- Duplicate client retries must not double-credit balance.
- Concurrent admin actions can conflict with manual status update, provider webhook status changes, or another refund attempt.
- Successful transactions are intentionally blocked because refunding success must also reconcile points through status update logic.
- Returning a populated transaction must preserve frontend shape used by admin transaction pages.
- Compensation rollback can fail after a user balance credit, so failure logs and smoke restoration are important.

## API v2 Design Requirements

- Add an explicit Node gateway route before the generic `/transactions/*` rule:
  - `app.post('/transactions/:id/refund', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, proxyRequest);`
- Keep `app.all('/transactions/*', hasPermission('viewTransactions'))` for read endpoints and non-migrated routes.
- Add Rust route:
  - `post(transactions::refund_transaction)` at `/v2/transactions/{id}/refund`.
- Rust handler must reject direct Rust calls without proxy context with `403 API v2 proxy access required`.
- Rust must use `x-webtopup-user-id` from proxy context as `processorId`.
- Validation/error parity must match v1 messages listed above.
- Keep admin UI fallback to `/v1` until smoke and one production-like dry run pass.

## Proposed Rust Compensation Algorithm

Use compensation first unless Mongo transaction/session support is implemented in Rust for this codebase.

1. Validate proxy context, transaction id, processor id, and reason.
2. Load transaction by id.
3. Reject missing, already refunded, or success status with v1 messages.
4. Snapshot previous transaction fields needed for rollback:
   - `status`, `updatedAt`, `refunded`, `refundedBy`, `refundedAt`, `refundReason`, `statusUpdatedBy`, `statusUpdatedAt`, `statusUpdateNote`.
5. Claim the refund with `find_one_and_update` using:
   - `_id = transaction id`.
   - `refunded != true`.
   - `updatedAt = snapshot.updatedAt`.
   - Optional guard `status != success`.
6. Set refund/status metadata in the same transaction update.
7. Load the user and compute `balanceBefore` and `balanceAfter`.
8. Credit user balance using an atomic `$inc` or guarded update.
9. Insert `userbalanceadjustments` audit row.
10. On any failure after claim:
    - delete inserted audit row if present.
    - decrement balance if credit was applied.
    - restore transaction snapshot and unset prior absent fields.
11. Return populated transaction with the same shape as v1.

## Idempotency And Race Behavior

- Repeated refund after a successful first refund returns `409 Transaksi ini sudah direfund`.
- Concurrent refund attempts should allow one claim only; the loser returns `409 Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.` when the claim filter misses after initial read.
- If a status update changes `updatedAt` between read and claim, refund returns the same `409` conflict message.
- If the user is missing after claim, rollback transaction metadata and return `404 User transaksi tidak ditemukan`.
- Because refund only credits balance, insufficient balance is not a normal failure mode; rollback debit must still avoid leaving a negative balance if unexpected external mutation occurs.

## Response Parity

- Success status: `200`.
- Success body:
  - `message: 'Saldo transaksi berhasil direfund'`.
  - `transaction`: populated transaction.
- Populated transaction should include at least:
  - `_id`, `user`, `product`, `target`, `amount`, `status`, `vendorTrxId`, `customerRefId`, `sn`, `message`, `refunded`, `refundedBy`, `refundedAt`, `refundReason`, `source`, `statusUpdatedBy`, `statusUpdatedAt`, `statusUpdateNote`, `createdAt`, `updatedAt`.
- `product` projection parity: `name code category brand vendor`.
- `user` projection parity: `name email`.
- `statusUpdatedBy` projection parity: `name email role`.

## Smoke Strategy

- Portable mutation smoke:
  - Direct Rust `POST /v2/transactions/not-a-valid-id/refund` without proxy context returns `403`.
  - Gateway `POST /api/v2/transactions/not-a-valid-id/refund` with authenticated smoke user returns `400 ID transaksi tidak valid` when user has permission.
  - Missing/short reason returns `400 Alasan refund wajib 5-300 karakter` when id is syntactically valid and permission allows.
- Mongo-backed e2e smoke:
  - Insert disposable member, product, and transaction directly in Mongo.
  - Transaction should be non-success, not refunded, and marked clearly with smoke-only fields such as target/customerRefId/reason prefix.
  - Snapshot user balance.
  - Call v2 refund through gateway.
  - Assert transaction `status=failed`, `refunded=true`, `refundReason=raw reason`, and `statusUpdateNote` has built audit reason.
  - Assert user balance increased by transaction amount.
  - Assert one matching `userbalanceadjustments` row exists.
  - Call duplicate refund and expect `409`.
  - Restore user balance, delete audit rows, and delete disposable transaction/product/user.
- Do not run against real successful/provider transactions.

## Implementation Status

- Implemented in Rust API v2 with compensation rollback.
- Node gateway uses explicit `processManualTransaction` permission for `POST /api/v2/transactions/:id/refund`.
- Admin transaction refund UI uses v2-first with v1 fallback.
- Mutation smoke covers direct Rust proxy rejection, validation boundaries, missing transaction, duplicate refund, balance credit, audit insert, and cleanup using a disposable Mongo-backed transaction.
- Keep `POST /transactions`, `PUT /transactions/:id/status`, and `POST /transactions/:id/recheck` on v1 until their own reviews are complete.
