# API v2 Balance Adjustment Review

Date: 2026-05-01

## Scope

This review covers the admin member balance adjustment endpoint:

- `POST /users/:id/balance`

It does not cover user-facing deposits, transaction payment/refund flows, provider calls, or direct database repair scripts.

## Current v1 Behavior

Route source: `server/src/routes/userRoutes.ts`.

- Route: `POST /users/:id/balance`.
- Middleware: `authenticate`, `hasPermission('manageUsers')`.
- Controller: `adjustUserBalance` in `server/src/controllers/userController.ts`.

Validation and request semantics:

- `id` must identify a member user.
- `amount` is converted with `Number(payload.amount)` and must be finite and greater than `0`.
- `type` must be `add` or `subtract`.
- `reason` is trimmed and must be `5-300` characters.
- authenticated operator id is required.

Write behavior:

- Computes `delta = amount` for `add`, `-amount` for `subtract`.
- Only updates users with `role: 'member'`.
- Subtract must not make balance negative.
- Creates `userbalanceadjustments` audit record with:
  - `user`
  - `adjustedBy`
  - `type`
  - `amount`
  - `balanceBefore`
  - `balanceAfter`
  - `reason`
  - timestamps

v1 attempts a Mongo transaction first and falls back to update-plus-compensation when transactions are unsupported. In fallback mode, if audit insert fails after balance update, it rolls back the balance delta.

Response shape:

```json
{
  "message": "Saldo user berhasil ditambahkan",
  "user": {
    "_id": "...",
    "name": "...",
    "email": "...",
    "level": "basic",
    "balance": 1000,
    "points": 0,
    "active": true,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "audit": {
    "amount": 1000,
    "type": "add",
    "reason": "...",
    "balanceBefore": 0,
    "balanceAfter": 1000
  }
}
```

For subtract, the success message is `Saldo user berhasil dikurangi`.

Important errors:

- no operator id: `401 Unauthorized`
- invalid amount: `400 Nominal penyesuaian harus lebih besar dari 0`
- invalid type: `400 Tipe penyesuaian saldo tidak valid`
- invalid reason: `400 Alasan penyesuaian saldo wajib 5-300 karakter`
- invalid object id while checking non-adjustable subtract: `400 ID user tidak valid`
- member missing: `404 User member tidak ditemukan`
- insufficient balance: `400 Saldo user tidak mencukupi untuk pengurangan ini`

## Collections Written

- `users`: `$inc` balance and should update `updatedAt` in v2 for consistency with other Rust mutations.
- `userbalanceadjustments`: insert audit record.

No deposits, transactions, vouchers, points, rewards, providers, or payment gateway collections are written by this endpoint.

## Risk Notes

- This endpoint directly mutates member balance, so it is financial and must remain behind the Node gateway permission gate.
- Duplicate admin submits are not inherently idempotent in v1. v2 should preserve behavior and rely on UI/operator discipline unless an idempotency key is explicitly introduced later.
- Subtract must use an atomic filter with `balance >= amount` to prevent race-driven negative balances.
- If audit insert fails after user balance update, v2 needs a compensation rollback with clear logging if rollback fails.
- If compensation rollback fails, user balance may be inconsistent with audit history.

## Rust v2 Implementation Status

Implemented on 2026-05-01.

- Rust handler: `rust-api/src/routes/users.rs` `adjust_balance`.
- Rust route: `POST /v2/users/{id}/balance`.
- Gateway route: `POST /api/v2/users/:id/balance` with `manageUsers`.
- Frontend route: `client/src/pages/admin/Users.tsx` uses API v2 first with v1 fallback.
- Smoke coverage: mutation smoke includes direct Rust proxy-boundary, invalid id/amount/type, missing member checks, and optional Mongo-backed add/subtract e2e with balance restore and audit cleanup.

## Implemented Rust v2 Flow

1. Add `adjust_balance` handler in `rust-api/src/routes/users.rs`.
2. Require proxy context and authenticated operator id.
3. Parse path user id as ObjectId; invalid id returns `400 ID user tidak valid`.
4. Deserialize `{ amount, type, reason }` using flexible numeric/string payload handling where needed.
5. Validate amount, type, and trimmed reason with v1 messages.
6. Build atomic user update filter `{ _id, role: 'member' }`, plus `balance: { $gte: amount }` for subtract.
7. Use `find_one_and_update` with `$inc` balance and `$set updatedAt`, returning the updated user.
8. If update misses on subtract, look up the member balance and return v1-specific insufficient/missing error.
9. Insert `userbalanceadjustments` audit document.
10. If audit insert fails, roll back the balance delta and return `500 Internal Server Error`.
11. Return the v1 response shape and success messages.
12. Add route `POST /v2/users/:id/balance` and explicit Node gateway route with `manageUsers` if the existing wildcard does not already cover it.
13. Update admin Users UI to use API v2 first with v1 fallback.

## Smoke Strategy

Default mutation smoke can include safe boundary tests:

- direct Rust without proxy context returns `403`.
- gateway invalid id returns `400`.
- gateway invalid amount/type/reason returns `400`.
- gateway missing member returns `404`.

Mongo-backed optional e2e should:

- snapshot the smoke user's balance.
- add a small disposable amount through `/api/v2/users/:id/balance`.
- subtract the same amount.
- verify returned `balanceBefore`/`balanceAfter` values.
- restore the original balance in `finally`.
- delete marked `userbalanceadjustments` rows by reason prefix.

## Recommendation

This migration is complete. Keep the v1 fallback in the admin users UI until the endpoint has production-like runtime confidence, then consider removing the fallback in a separate cleanup.
