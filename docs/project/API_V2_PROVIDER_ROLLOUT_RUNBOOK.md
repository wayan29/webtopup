# API v2 Provider Rollout Runbook

Last updated: 2026-05-03

## Purpose

This runbook validates the API v2 transaction create/recheck migration before removing v1 fallbacks or relying on live provider flows.

For the focused saldo checkout v2-only dry run, use `API_V2_TRANSACTION_CREATE_DRY_RUN_CHECKLIST.md`.

## Scope

- `POST /api/v2/transactions` for authenticated saldo checkout.
- `POST /api/v2/transactions/:id/recheck` for admin provider recheck.
- Related v2 admin actions that already migrated:
  - `PUT /api/v2/transactions/:id/status`.
  - `POST /api/v2/transactions/:id/refund`.
- Node gateway auth/permission behavior.
- Rust direct-call proxy rejection.

This runbook does not cover guest payment gateway transactions, provider webhooks, seller callbacks, or live product sync.

## Preconditions

- `origin/main` includes the latest migration commits.
- Node backend and Rust API are deployed from the same commit.
- Frontend is built from the same commit.
- `API_V2_PROXY_SECRET` is set to the same non-empty value in Node and Rust.
- Node public API is available at the expected backend URL.
- Rust API is reachable by Node through `API_V2_UPSTREAM_URL`.
- A disposable member account is available for staging validation.
- A team/admin account with `processManualTransaction` is available.
- The member account balance and points can be restored after testing.

## Environment Modes

### Default Mode

Use default mode after validation or for normal operation:

```bash
PROVIDER_MODE=live
```

Do not run provider smoke in live mode during normal validation.

### Sandbox Stub Mode

Use sandbox stub mode for provider HTTP adapter validation without live provider calls:

```bash
npm run provider:sandbox-stub
```

Start Node and Rust with:

```bash
PROVIDER_MODE=sandbox
PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL=http://127.0.0.1:9020
PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL=http://127.0.0.1:9020
```

### Mock Mode

Use mock mode only for deterministic in-process provider validation:

```bash
PROVIDER_MODE=mock
PROVIDER_MOCK_TOPUP_STATUS=pending
PROVIDER_MOCK_RECHECK_STATUS=pending
```

## Automated Validation

Run these from the workspace root unless noted otherwise.

Run read, mutation, and provider smoke sequentially. The scripts share `/tmp/webtopup-api-v2-smoke-suite.lock` and intentionally refuse parallel execution because they inspect or mutate shared Mongo fixtures.

### Build Checks

```bash
cd rust-api && . "$HOME/.cargo/env" && cargo fmt --check && cargo check && cargo build
cd ../server && npm run build
cd ../client && npm run build
npm run build:client:transaction-create-v2
```

Expected result:

- Rust checks pass.
- Server TypeScript build passes.
- Client default build and transaction-create v2-only build pass. Existing Vite chunk-size warning is non-blocking.

### Read Smoke

```bash
npm run api-v2:smoke
```

Expected result:

- Read smoke passes.
- Direct Rust protected endpoint rejection remains `403`.

### Mutation Smoke

```bash
RUN_API_V2_MUTATION_SMOKE=1 npm run api-v2:smoke:mutations
```

Expected result:

- Portable mutation smoke passes.
- Direct Rust mutation proxy rejection remains `403`.

### Mongo-Backed Mutation Smoke

```bash
RUN_API_V2_MUTATION_SMOKE=1 \
MONGO_URI="<staging mongo uri>" \
MONGO_DB="<staging db>" \
npm run api-v2:smoke:mutations
```

Expected result:

- Disposable deposit, points, voucher, balance adjustment, refund, and status e2e checks pass.
- Smoke restores member balance/points and deletes marked fixtures.

### Provider Smoke With Sandbox Stub

Start provider sandbox stub first:

```bash
npm run provider:sandbox-stub
```

Start Node and Rust with sandbox envs, including game validation sandbox URLs, then run:

```bash
RUN_PROVIDER_SMOKE=1 \
PROVIDER_MODE=sandbox \
CONFIRM_PROVIDER_BACKEND_SANDBOX=1 \
CONFIRM_GAME_VALIDATION_SANDBOX=1 \
REQUIRE_TRANSACTION_CREATE_READINESS=1 \
SMOKE_MEMBER_EMAIL="<member email>" \
SMOKE_MEMBER_PASSWORD="<member password>" \
MONGO_URI="<staging mongo uri>" \
MONGO_DB="<staging db>" \
PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL="http://127.0.0.1:9020" \
PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL="http://127.0.0.1:9020" \
GAME_VALIDATION_CODASHOP_BASE_URL="http://127.0.0.1:9020" \
GAME_VALIDATION_GOPAY_BASE_URL="http://127.0.0.1:9020" \
npm run api-v2:smoke:providers
```

Equivalent helper:

```bash
RUN_PROVIDER_SMOKE=1 \
PROVIDER_MODE=sandbox \
CONFIRM_PROVIDER_BACKEND_SANDBOX=1 \
CONFIRM_GAME_VALIDATION_SANDBOX=1 \
SMOKE_MEMBER_EMAIL="<member email>" \
SMOKE_MEMBER_PASSWORD="<member password>" \
MONGO_URI="<staging mongo uri>" \
MONGO_DB="<staging db>" \
PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL="http://127.0.0.1:9020" \
PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL="http://127.0.0.1:9020" \
GAME_VALIDATION_CODASHOP_BASE_URL="http://127.0.0.1:9020" \
GAME_VALIDATION_GOPAY_BASE_URL="http://127.0.0.1:9020" \
npm run api-v2:smoke:transaction-create-readiness
```

Expected result:

- Provider smoke passes the full sandbox suite when member credentials are configured.
- Transaction create covers pending, success, and failed outcomes.
- Transaction recheck covers pending, success, and failed outcomes.
- Guest confirm and game validation success paths use the local sandbox stub, not live providers.
- Smoke restores member balance/points and deletes marked products, transactions, and point transactions.

## Manual UI Validation

Run these against staging after automated sandbox validation passes.

### Member Saldo Checkout

Build the staging frontend with `VITE_TRANSACTION_CREATE_V2_ONLY=true` only for this dry run. Use `npm run build:client:transaction-create-v2` for the local build check. Leave the flag unset in normal builds so v1 fallback stays available.

Use `API_V2_TRANSACTION_CREATE_DRY_RUN_CHECKLIST.md` as the source of truth for preconditions, acceptance criteria, stop conditions, and rollback.

1. Login as disposable member.
2. Confirm starting balance and points.
3. Open a product order page.
4. Select `Saldo` payment.
5. Submit transaction.
6. Confirm success message and redirect to transaction history.
7. Confirm transaction appears in member transaction history.
8. Confirm member balance is debited by the expected amount.

Expected result:

- Frontend uses API v2 directly when `VITE_TRANSACTION_CREATE_V2_ONLY=true`.
- No duplicate transactions are created from one submit.
- Roll back by rebuilding without `VITE_TRANSACTION_CREATE_V2_ONLY=true`; the default frontend path keeps v1 fallback.

### Admin Transaction Review

1. Login as admin/team account with `processManualTransaction`.
2. Open admin transactions page.
3. Find the staging transaction.
4. Confirm product, target, amount, status, `vendorTrxId`, and source fields.
5. Click provider recheck.

Expected result:

- Recheck returns a clear success/no-op message.
- Pending provider result does not mutate status.
- Terminal provider result updates status and side effects according to provider outcome.

### Manual Status Update

1. Use a disposable pending/processing transaction.
2. Change status to failed.
3. Confirm balance refund and `refunded=true`.
4. Change failed transaction back to processing if needed.
5. Change processing transaction to success.
6. Confirm points award when amount qualifies.

Expected result:

- Balance and points transitions match v1 parity.
- No duplicate point awards after repeated success update.

### Refund Edge Case

1. Use a disposable non-success transaction that is not already refunded.
2. Trigger refund with a valid reason.
3. Confirm user balance credit.
4. Retry refund.

Expected result:

- First refund succeeds.
- Duplicate refund is rejected.
- Success-status transaction refund remains blocked.

### Guest Checkout Create

1. Open a guest product order page without logging in.
2. Select a bank-transfer payment method.
3. Submit a disposable target and WhatsApp number.
4. Confirm payment modal shows invoice number, transfer amount, account details, and expiry.
5. Check the invoice by invoice number and WhatsApp.
6. If a flash-sale product is used, confirm stock behavior matches expectation.

Expected result:

- Frontend uses API v2 directly for guest create.
- Exactly one guest transaction is created.
- Payment instructions match configured method and total amount.
- Legacy `/v1/guest-transactions` remains available only as rollback until live dry run is accepted.

## Live Provider Dry Run

Only run this after sandbox validation passes and a low-risk product/target is available.

Rules:

- Use a small nominal product.
- Use a disposable member account.
- Do not run default smoke against live providers.
- Do not enable live provider smoke unless an explicit live smoke plan is approved.
- Keep frontend v1 fallback enabled.

Manual live steps:

1. Start Node and Rust with `PROVIDER_MODE=live`.
2. Create exactly one low-value saldo transaction from the member UI.
3. Record transaction id, `vendorTrxId`, target, amount, and provider name.
4. Recheck from admin once.
5. Verify final local state against provider dashboard/status.
6. Restore or compensate the member account if needed.

Stop immediately if:

- A duplicate provider order is created.
- Balance is debited without a transaction record.
- Provider success fails to persist locally.
- Provider failed does not refund locally.
- Recheck mutates a terminal transaction unexpectedly.

## Rollback Plan

Frontend fallback means rollback can usually be done without reverting backend immediately.

Immediate mitigations:

- Restart frontend/backend with existing build if v2 calls fail and v1 fallback works.
- If provider v2 create/recheck misbehaves, deploy a frontend change to call `/v1` directly for affected actions.
- Keep Node `/v1` routes unchanged and available.

Backend rollback:

- Revert or disable explicit v2 transaction routes in Node gateway only if proxying itself causes issues.
- Keep Rust direct protected endpoints inaccessible from public traffic.

Data repair:

- Use transaction id and member id to inspect `transactions`, `users`, `pointtransactions`, and `flashsales`.
- Restore member balance/points only after confirming provider outcome.
- Do not delete real provider-backed transaction records unless an operational owner approves.

## Acceptance Criteria

- Read smoke passes.
- Mutation smoke passes.
- Mongo-backed mutation smoke passes.
- Provider smoke passes in sandbox mode with member credentials.
- Manual member saldo checkout works in staging.
- Manual admin recheck works in staging.
- Manual status/refund edge cases work in staging.
- No unhandled errors appear in Node/Rust logs during validation.
- v1 fallback remains available until live/staging confidence is established.

## Notes

- Keep live provider smoke disabled by default.
- Keep `SMOKE_MEMBER_EMAIL` and `SMOKE_MEMBER_PASSWORD` out of committed files.
- Use marked fixture product codes and targets for smoke-created records.
- Re-run this runbook after provider adapter changes, transaction status changes, or balance/points logic changes.
