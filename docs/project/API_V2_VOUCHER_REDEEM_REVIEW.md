# API v2 Voucher Redeem Review

Last updated: 2026-05-01

## Scope

This review covers the authenticated user voucher redemption endpoint:

- `POST /vouchers/redeem`

It does not cover admin voucher create/list/archive/restore, which already have API v2 coverage.

## Current v1 Behavior

Route source: `server/src/routes/voucherRoutes.ts`.

- Route: `POST /vouchers/redeem`.
- Middleware: `authenticate` only.
- Controller: `redeemVoucher` in `server/src/controllers/voucherController.ts`.
- Payload: `{ code: string }`.
- Code normalization:
  - trims input.
  - converts to uppercase.
  - validates against `^[A-Z0-9_-]{4,}$`.
  - invalid/empty values can return the existing voucher code validation message from `normalizeVoucherCode`.
- Uses authenticated `request.user?.id` as redeemer.
- Missing user context returns `401 { message: 'Unauthorized' }`.

## Redeem Flow

v1 first attempts a Mongo session transaction, then falls back to compensation if transactions are unsupported.

Primary atomic claim:

- `Voucher.findOneAndUpdate({ code, isRedeemed: false, isArchived: false }, $set: { isRedeemed: true, redeemedBy, redeemedAt }, { new: false })`
- Returns the pre-update voucher with `amount` and `code`.

When no voucher matches, v1 resolves a more specific message by looking up the voucher by code:

- no voucher: `404 Kode voucher tidak valid`
- archived: `400 Voucher sudah diarsipkan dan tidak bisa diredeem`
- already redeemed: `400 Voucher sudah pernah diredeem`
- otherwise: `400 Voucher tidak bisa diredeem`

After claim:

- Increments user balance by voucher amount.
- If user is missing: `404 User tidak ditemukan`.
- Updates voucher metadata:
  - `redeemedBalanceBefore = updatedUser.balance - amount`
  - `redeemedBalanceAfter = updatedUser.balance`
- Success response:
  - `message: 'Voucher berhasil diredeem'`
  - `code`
  - `amount`
  - `newBalance`

## Collections And Fields

Written collections:

- `vouchers`
  - `isRedeemed`
  - `redeemedBy`
  - `redeemedAt`
  - `redeemedBalanceBefore`
  - `redeemedBalanceAfter`
  - Mongoose-managed `updatedAt`
- `users`
  - `balance`
  - Mongoose-managed `updatedAt`

Read collections:

- `vouchers` for status-specific error messages.
- `users` for balance update.

No transactions, deposits, points, rewards, providers, or payment gateway collections are written by voucher redeem.

## Risk Notes

- Duplicate redeem must be guarded by the atomic voucher claim filter.
- The balance credit and voucher metadata update are multi-step writes when Mongo transactions are unavailable.
- Rust v2 should use the same compensation strategy as v1:
  - If user update fails after voucher claim, reset voucher to unredeemed and unset redeem metadata.
  - If metadata update fails after balance credit, decrement user balance and reset voucher metadata.
- Code normalization must preserve uppercase code semantics.
- Admin archived vouchers must not be redeemable.
- Already redeemed vouchers must never credit balance again.
- Frontend/user retry after a timeout should not double-credit because the voucher claim changes `isRedeemed` before balance credit.
- If compensation rollback fails, the system can be left inconsistent. Log rollback failures clearly.

## Rust v2 Implementation Status

Implemented on 2026-05-01.

- Rust handler: `rust-api/src/routes/vouchers.rs` `redeem`.
- Rust route: `POST /v2/vouchers/redeem`.
- Gateway route: `POST /api/v2/vouchers/redeem` with `authenticate`, before the admin `/vouchers*` wildcard.
- Frontend route: `client/src/pages/RedeemVoucher.tsx` uses API v2 first with v1 fallback.
- Smoke coverage: mutation smoke includes proxy-boundary, invalid/unknown code checks, and optional Mongo-backed redeem e2e with balance restore and disposable voucher cleanup.

## Implemented Rust v2 Flow

1. Add `redeem` handler in `rust-api/src/routes/vouchers.rs`.
2. Require proxy context and authenticated user id.
3. Deserialize `{ code }`, normalize to uppercase, and validate with the same code pattern.
4. Atomically claim voucher with `find_one_and_update` filter `{ code, isRedeemed: false, isArchived: false }`.
5. If no voucher was claimed, load voucher by code and return the specific v1 error message.
6. Increment user balance with `$inc: { balance: amount }` and explicit `updatedAt`.
7. If user update fails, reset voucher fields and return `404 User tidak ditemukan`.
8. Update voucher redeem balance metadata with before/after values.
9. If metadata update fails, compensate user balance and reset voucher fields.
10. Return `{ message: 'Voucher berhasil diredeem', code, amount, newBalance }`.
11. Add route `POST /v2/vouchers/redeem` before generic voucher id routes if ordering is relevant.
12. Existing Node gateway `/vouchers*` currently requires `manageProducts`; this is stricter than v1 for user redeem. Add an explicit `POST /vouchers/redeem` route with only `authenticate` before the wildcard.

## Smoke Strategy

Default mutation smoke can include safe boundary tests:

- direct Rust without proxy context returns `403`.
- gateway invalid code format returns `400`.
- gateway unknown code returns `404`.

Mongo-backed optional e2e should:

- create a disposable unarchived voucher directly in Mongo with a unique code marker.
- snapshot smoke user's balance.
- redeem through `/api/v2/vouchers/redeem`.
- verify response amount and new balance.
- verify second redeem returns `400 Voucher sudah pernah diredeem`.
- restore smoke user's original balance.
- delete the disposable voucher.

## Recommendation

This migration is complete. Keep the v1 fallback in the UI until the endpoint has production-like runtime confidence, then consider removing the fallback in a separate cleanup.
