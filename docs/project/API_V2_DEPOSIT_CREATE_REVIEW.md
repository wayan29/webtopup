# API v2 Deposit Create Review

Date: 2026-05-01

## Scope

This review covers the authenticated member deposit request endpoint:

- `POST /deposits`

It does not cover admin claim/release/reject/approve, which already have API v2 coverage, and does not cover payment gateway callbacks or provider calls.

## Current v1 Behavior

Route source: `server/src/routes/depositRoutes.ts`.

- Route: `POST /deposits`.
- Middleware: `authenticate`.
- Controller: `requestDeposit` in `server/src/controllers/depositController.ts`.

Validation and request semantics:

- Team accounts (`owner`, `admin`, `cs`) cannot request deposits: `403 Team accounts cannot request deposit`.
- `amount` is converted with `Number(amount)` and must be finite and greater than `0`.
- `paymentMethodId` is required.
- Site settings are loaded for `maintenanceMode`, `maintenanceMessage`, `minDeposit`, `maxDeposit`, `depositFee`, and `depositFeeType`.
- Maintenance mode returns `503` with the configured maintenance message.
- Amount must be within global min/max deposit limits.
- Payment method must exist.
- Payment method must be `active`.
- Payment method category must exist and be `active`.
- Payment method must currently be operational according to `operationalStart` and `operationalEnd`.
- Amount must be within payment method min/max limits.

Fee and transfer calculation:

- fixed payment method fee: `paymentMethod.adminFee || 0`.
- percent payment method fee: `Math.round(amount * adminPercent / 100)`.
- global fee:
  - fixed: `depositFee`.
  - percent: `Math.round(amount * depositFee / 100)`.
- total admin fee is the sum of payment method fee and global fee.
- net amount must stay positive: `amount - totalAdminFee > 0`.
- unique code is `Math.floor(Math.random() * 999) + 1` when `useUniqueCode !== false`, otherwise `0`.
- total transfer is `amount + uniqueCode`.

Write behavior:

- Inserts a pending deposit with:
  - `user`
  - `amount`
  - `uniqueCode`
  - `totalAmount`
  - `adminFee`
  - `paymentMethod`
  - `status: 'pending'`
  - timestamps

Response shape:

```json
{
  "message": "Deposit requested",
  "deposit": { "...": "populated deposit with paymentMethod" },
  "paymentInfo": {
    "bankName": "...",
    "accountNumber": "...",
    "accountName": "...",
    "amount": 50000,
    "uniqueCode": 123,
    "totalAmount": 50123,
    "adminFee": 0,
    "netAmount": 50000,
    "adminFeeBreakdown": {
      "paymentMethodFee": 0,
      "globalFee": 0
    }
  }
}
```

## Collections Written

- `deposits`: insert pending deposit.

Collections read:

- `settings`.
- `paymentmethods`.
- `paymentcategories`.

No user balance, transactions, points, vouchers, rewards, providers, or payment gateway collections are written by deposit create.

## Risk Notes

- This endpoint creates user payment instructions. It is financial but does not mutate user balance until admin approval.
- v1 does not guarantee uniqueness of the random unique code across pending deposits. API v2 should preserve behavior unless a separate product decision introduces stricter uniqueness.
- Retry/double-submit creates multiple pending deposit requests in v1. API v2 should preserve this behavior unless idempotency is introduced later.
- Operational window parity depends on server local time in v1. Rust should use the same operational check semantics where possible.
- Settings fallback/defaults must match v1 defaults.

## Rust v2 Implementation Status

Implemented on 2026-05-01.

- Rust handler: `rust-api/src/routes/deposits.rs` `request_deposit`.
- Rust route: `POST /v2/deposits`.
- Gateway route: existing `app.all('/deposits', { preHandler: [authenticate] }, proxyRequest)` forwards user create requests.
- Frontend route: `client/src/pages/Deposit.tsx` uses API v2 first with v1 fallback.
- Smoke coverage: mutation smoke includes direct Rust proxy-boundary and team-account rejection checks. Optional deposit-create e2e is gated by `SMOKE_MEMBER_EMAIL`/`SMOKE_MEMBER_PASSWORD` so team/admin smoke credentials never create user-facing payment instructions.

## Implemented Rust v2 Flow

1. Add `request_deposit` handler in `rust-api/src/routes/deposits.rs`.
2. Require proxy context and authenticated user id.
3. Reject `owner`, `admin`, and `cs` proxy roles with `403 Team accounts cannot request deposit`.
4. Deserialize `{ amount, paymentMethodId }`.
5. Validate amount and payment method id with v1 messages.
6. Load relevant settings with v1 defaults.
7. Enforce maintenance mode, global min/max deposit limits, payment method existence/status, active category, operational window, payment method min/max, and positive net amount.
8. Calculate admin fees, unique code, total amount, and net amount with v1 formulas.
9. Insert pending deposit.
10. Return v1-compatible response shape with deposit and paymentInfo.
11. Add route `POST /v2/deposits`.
12. Add explicit Node gateway route `POST /deposits` with `authenticate` if route ordering requires it.
13. Update user deposit page to use API v2 first with v1 fallback.

## Smoke Strategy

Default mutation smoke can include safe boundary tests:

- direct Rust without proxy context returns `403`.
- gateway invalid amount returns `400`.
- gateway missing payment method returns `400`.
- gateway unknown payment method returns `404`.

Mongo-backed optional e2e should:

- find an active payment method with an active category and operational window.
- create a deposit with a disposable amount within all limits.
- verify response payment info and pending deposit status.
- delete the created deposit in cleanup.

## Recommendation

This migration is complete. Keep the v1 fallback in the deposit UI until the endpoint has production-like runtime confidence, then consider removing the fallback in a separate cleanup.
