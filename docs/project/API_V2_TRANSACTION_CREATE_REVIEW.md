# API v2 Transaction Create Review

Last updated: 2026-05-02

## Scope

- Candidate endpoint: `POST /transactions`.
- Current public v1 route: `POST /v1/transactions` with `authenticate`.
- Current frontend balance checkout path: `client/src/pages/Order.tsx` calls `/v1/transactions` directly for saldo payments.
- Public v2 route: `POST /api/v2/transactions` through the Node gateway.
- Internal Rust route: `POST /v2/transactions`; requires proxy context.
- This review covers authenticated saldo-paid transaction creation only. It does not cover guest payment gateway transactions, manual status update, refund, recheck, webhooks, or provider callback handling.

## Current v1 Behavior

- Requires authentication.
- Rejects team accounts with `403 Team accounts cannot create transactions` for roles `owner`, `admin`, and `cs`.
- Reads site settings `maintenanceMode` and `maintenanceMessage`.
- Returns `503` with the configured maintenance message when maintenance mode is active.
- Trims `target` and returns `400 Target wajib diisi` when empty.
- Trims optional `serverId`.
- Looks up product by `productId` if present; otherwise by `productCode`.
- Returns `404 Product not found` when no product matches.
- Returns `400 Product is unavailable` when product `status` is false.
- Runs taxonomy availability checks through `getProductPurchaseIssues`.
- Returns `400 Produk tidak tersedia untuk dibeli: ...` for inactive category/operator/product type issues.
- Loads the authenticated user and returns `404 User not found` when missing.
- Computes base price from `product.price[user.level]` where level is `basic`, `gold`, or `platinum`.
- If `useFlashSale` is true, checks active flash sale by product and current time.
- If flash sale stock remains, computes discounted flash price and increments flash sale sold count by `1`.
- Returns `400 Insufficient balance` when user balance is less than the selected price.
- Generates a vendor reference id with `generateRefId()`.
- Debits user balance by the selected price.
- Creates a transaction with:
  - `user`.
  - `product`.
  - `target`.
  - optional `serverId`.
  - `amount`: selected price.
  - `status: 'pending'`.
  - `vendorTrxId`: generated ref id.
- Calls `vendorService.topUp` after creating the transaction and debiting balance.
- Updates transaction status with vendor response status.
- Updates `vendorTrxId` only if vendor response includes one.
- Updates `sn` only if vendor response includes one.
- If vendor returns `failed` immediately:
  - credits user balance back by price.
  - sets `transaction.refunded = true`.
  - sets `transaction.refundedAt = now`.
  - sets `transaction.refundReason = 'Vendor returned failed during initial processing'`.
- If vendor returns `success` immediately:
  - awards points with `awardPoints(userId, price, transaction._id.toString())`.
- If the provider call throws, v1 logs the error and leaves the transaction pending for later reconciliation.
- Success response is `201`:
  - `message: 'Transaction created'`.
  - `transaction`: mongoose transaction document.
  - `remainingBalance`: current in-memory user balance after any immediate vendor-failed refund.

## Write Set

- `flashsales`:
  - `$inc products.$.soldCount` by `1` when `useFlashSale` is true and an active flash sale has remaining stock.
- `users`:
  - debits `balance` by transaction price before provider call.
  - credits `balance` back when provider returns immediate failed status.
  - may increment `points` if provider returns immediate success.
- `transactions`:
  - inserts a pending transaction before provider call.
  - updates status/vendorTrxId/SN after provider response.
  - sets refund metadata when provider immediately fails.
- `pointtransactions`:
  - inserts an `earn` row when provider immediately succeeds and point calculation is positive.

No `userbalanceadjustments` row is inserted for the initial debit or immediate provider-failed refund in v1.

## Related Helper Behavior

- `generateRefId` reads settings:
  - `refIdPrefix`, default `REF`.
  - `refIdDateFormat`, default `DDMMYYYY`.
  - `refIdSeparator`, default empty string.
  - `refIdSequenceDigits`, default `4`.
- `generateRefId` counts today's `transactions` and uses `todayCount + 1` as the sequence.
- `generateRefId` does not reserve a sequence atomically and does not enforce uniqueness at the transaction schema level.
- Flash sale price selection checks active date window and remaining stock as `stock - soldCount`.
- Flash sale stock reservation is a plain positional `$inc` and does not include an atomic `soldCount < stock` guard.
- Taxonomy purchase issues check inactive category/operator/product type by direct ids and legacy category/brand fallbacks.

## Current Atomicity Model

- v1 transaction creation does not use Mongo transactions.
- User balance is debited before transaction creation and provider call.
- Flash sale sold count can be incremented before balance validation completes.
- If transaction insert fails after balance debit, the outer catch returns `500` without explicit balance rollback.
- If provider call throws, the transaction remains pending and balance remains debited.
- If provider returns failed, balance refund and transaction refund metadata are best-effort sequential writes.
- If point award fails after immediate provider success, `awardPoints` logs and returns `0` by default, so transaction success is not rolled back.

## Risks

- This is one of the highest-risk remaining endpoints because it combines balance debit, flash sale stock mutation, transaction insert, provider top-up, optional refund, and optional point award.
- Provider top-up is an external side effect. A client retry after timeout can create duplicate vendor orders unless idempotency is deliberately controlled by `refId` and provider semantics.
- `generateRefId` based on count can race under concurrent orders and produce duplicate reference ids.
- Flash sale stock reservation can oversell under concurrent purchases because reservation is not guarded by remaining stock in the update filter.
- Flash sale stock is not rolled back if user balance is insufficient after reservation, transaction insert fails, or provider call fails/returns failed.
- Balance debit is not guarded with atomic `balance >= price`; concurrent purchases can overspend if multiple requests read the same balance.
- Transaction insert failure after balance debit can leave user balance reduced without a transaction record.
- Provider failed refund has no audit row and can fail independently of transaction refund metadata.
- Immediate success point award failure is tolerated in v1, which preserves transaction success but may miss points.
- Migrating to Rust would require duplicating provider top-up adapters, signing, credential lookup, timeout/error normalization, product/taxonomy purchase checks, ref-id generation, flash sale pricing, and points logic.

## API v2 Design Requirements

- Node gateway route must stay authenticated-only and Rust must reject direct calls without proxy context.
- Rust must reject team roles using the forwarded proxy role and preserve `403 Team accounts cannot create transactions`.
- Rust must preserve validation messages and response shape listed above.
- Rust must preserve site maintenance behavior and configured maintenance message.
- Rust must preserve product lookup by `productId` or `productCode`.
- Rust must preserve taxonomy inactive checks and legacy fallbacks.
- Rust must preserve user-level pricing and flash sale price calculation.
- Rust must either exactly preserve v1's non-atomic behavior or deliberately improve it behind a reviewed compatibility decision.
- Provider top-up parity must include Digiflazz and Tokovoucher request signing, base URL/config lookup, status mapping, and error normalization.
- UI should remain on v1 direct until provider sandbox and atomicity decisions are ready.

## Implemented API v2 Behavior

- Node gateway exposes `POST /api/v2/transactions` through the authenticated `/transactions` proxy route.
- Rust rejects direct calls without proxy context and rejects team roles using forwarded proxy role.
- Rust preserves maintenance checks, target validation, product lookup by id/code, product disabled checks, taxonomy inactive checks, user lookup, user-level pricing, flash sale price calculation, ref-id generation, transaction insert shape, response shape, and provider outcome handling.
- Rust deliberately improves several v1 atomicity gaps:
  - user balance debit uses an atomic `balance >= price` update guard.
  - flash sale sold count is rolled back if debit, ref-id generation, or transaction insert fails.
  - transaction insert failure after debit rolls balance back.
- Provider error behavior remains v1-compatible: created transaction remains pending for later reconciliation.
- Immediate provider `failed` refunds user balance and sets refund metadata.
- Immediate provider `success` awards points; point award failure remains tolerated through existing award helper behavior.
- `PROVIDER_MODE=mock` supports deterministic top-up outcomes through `PROVIDER_MOCK_TOPUP_STATUS` and smoke scenario markers in target text.
- Digiflazz and Tokovoucher live/sandbox-compatible top-up calls are implemented in Rust with the same signing/status mapping and error normalization as the Node adapters.
- Order UI uses v2 first and falls back to v1 by default. Set `VITE_TRANSACTION_CREATE_V2_ONLY=true` in a staging/frontend build to force saldo checkout to API v2 only for dry-run validation.

## Migration Strategy Used

This endpoint was migrated after the provider mock prerequisite and recheck/status/refund compensation paths were in place. The implemented migration followed these prerequisites:

1. Add provider sandbox/mock mode for top-up and status-check flows.
2. Add a transaction creation idempotency strategy or document existing provider idempotency guarantees.
3. Replace count-based ref-id generation with an atomic sequence or uniqueness guard if behavioral change is approved.
4. Make balance debit atomic with `balance >= price` and define rollback behavior for transaction insert/provider failures.
5. Make flash sale stock reservation atomic with `soldCount < stock` and define rollback behavior.
6. Decide whether initial balance debit/refund should create `userbalanceadjustments` audit rows in a future behavior change.
7. Keep v1 fallback until staging validation passes; provider mock and sandbox-stub member create e2e have passed locally for pending/success/failed outcomes.

## Smoke Strategy

- Default portable smoke does not call this endpoint because it can debit real balance and call live providers.
- Boundary smoke covers cases that return before provider call:
  - unauthenticated returns `401`.
  - team account returns `403 Team accounts cannot create transactions`.
  - missing target returns `400 Target wajib diisi`.
  - missing product returns `404 Product not found`.
- Provider-backed e2e is opt-in with `RUN_PROVIDER_SMOKE=1`, `PROVIDER_MODE=mock|sandbox`, backend provider-mode confirmation, member smoke credentials, and Mongo fixture access. Set `REQUIRE_TRANSACTION_CREATE_READINESS=1` to make provider smoke fail unless member transaction create pending/success/failed coverage actually runs.
- Mongo-backed e2e without provider calls would need an adapter mock or controlled provider stub; direct DB fixture cleanup alone is not enough because the endpoint calls external provider after DB writes.
- Any e2e must snapshot and restore member balance, points, flash sale sold counts, transactions, and point transaction history.

## Outcome

`POST /transactions` has been migrated to API v2 after provider mock mode, provider smoke, and compensation semantics were added. Member-credential provider smoke create e2e has passed locally for pending/success/failed outcomes in mock mode and sandbox-stub mode. Keep v1 fallback by default; use `VITE_TRANSACTION_CREATE_V2_ONLY=true` only for controlled staging dry runs until live/provider validation is accepted.
