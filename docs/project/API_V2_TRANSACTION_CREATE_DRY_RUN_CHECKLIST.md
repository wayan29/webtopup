# API v2 Transaction Create Dry Run Checklist

Last updated: 2026-05-06

## Purpose

Validate authenticated saldo checkout with API v2 forced on before permanently removing the frontend v1 fallback for `POST /transactions`.

Use `API_V2_TRANSACTION_CREATE_DRY_RUN_TEMPLATE.md` to record the actual dry-run inputs, evidence, and sign-off.

## Scope

- Frontend saldo checkout path in `client/src/pages/Order.tsx`.
- Public Node gateway route `POST /api/v2/transactions`.
- Internal Rust route `POST /v2/transactions` through proxy context.
- Provider top-up result handling for one low-value disposable transaction.
- Admin recheck for the created transaction.

Do not use this checklist for guest checkout, deposits, provider callbacks, or seller callbacks.

## Preconditions

- Staging backend and Rust API are deployed from the same commit.
- Staging frontend is built with `VITE_TRANSACTION_CREATE_V2_ONLY=true`.
- Node and Rust share the same non-empty `API_V2_PROXY_SECRET`.
- Node reaches Rust through `API_V2_UPSTREAM_URL`.
- A disposable member account is available.
- A team/admin account with `processManualTransaction` is available.
- The disposable member's starting balance and points are recorded.
- A low-value product and safe target/provider account are approved for testing.
- Provider dashboard or status channel is available for verification.
- Rollback owner is available to rebuild frontend without `VITE_TRANSACTION_CREATE_V2_ONLY=true`.

## Automated Readiness

Run these before the manual dry run.

```bash
npm run build:client:transaction-create-v2
```

Expected result:

- Frontend builds successfully with saldo checkout forced to API v2.
- Existing Vite chunk-size warning is non-blocking.

Run provider readiness smoke against staging/sandbox provider mode:

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

- Provider smoke passes.
- Transaction create pending, success, and failed outcomes all run for the member fixture.
- Smoke restores member balance/points and deletes disposable transaction/product fixtures.

Optional guarded API dry-run helper:

```bash
RUN_TRANSACTION_CREATE_DRY_RUN=1 \
CONFIRM_TRANSACTION_CREATE_DRY_RUN_BALANCE_CHANGE=1 \
API_BASE_URL="<staging node base url>" \
DRY_RUN_MEMBER_EMAIL="<member email>" \
DRY_RUN_MEMBER_PASSWORD="<member password>" \
DRY_RUN_ADMIN_EMAIL="<admin email>" \
DRY_RUN_ADMIN_PASSWORD="<admin password>" \
DRY_RUN_PRODUCT_CODE="<approved product code>" \
DRY_RUN_TARGET="<approved target>" \
DRY_RUN_SERVER_ID="<server id if needed>" \
MONGO_URI="<staging mongo uri>" \
MONGO_DB="<staging db>" \
DRY_RUN_OUTPUT_PATH="/tmp/transaction-create-dry-run.json" \
npm run api-v2:dry-run:transaction-create
```

Expected result:

- The helper creates exactly one API v2 saldo transaction through `/api/v2/transactions`.
- The helper confirms the transaction exists in the admin API list and Mongo.
- The helper records balance/points deltas and provider metadata for manual provider-dashboard verification.
- The helper does not replace the UI dry run or provider dashboard verification.

## Manual Dry Run

1. Confirm staging frontend bundle was built with `VITE_TRANSACTION_CREATE_V2_ONLY=true`.
2. Login as the disposable member.
3. Record member balance and points.
4. Open the selected low-value product order page.
5. Select `Saldo` payment.
6. Submit exactly one transaction for the approved target.
7. Record the transaction id, invoice/reference if shown, target, amount, product code, and timestamp.
8. Confirm the user sees the success message and redirect to transaction history.
9. Confirm exactly one new transaction appears in member transaction history.
10. Confirm member balance is reduced by exactly the transaction amount unless provider returned immediate failed.
11. If provider returned immediate failed, confirm balance is restored and transaction has `refunded=true`.
12. If provider returned immediate success, confirm points are awarded according to `points_per_transaction`.
13. Login as admin/team with `processManualTransaction`.
14. Open the transaction detail/list row.
15. Confirm product, target, amount, status, `vendorTrxId`, `sn` if present, and timestamps.
16. Verify provider dashboard/status has exactly one order for the same target/reference.
17. Run admin provider recheck exactly once.
18. Confirm recheck result is either a pending no-op or a valid terminal update.
19. Confirm no duplicate local transaction was created.
20. Confirm no duplicate provider order was created.

## Acceptance Criteria

- Frontend saldo checkout succeeds using API v2 only.
- There is exactly one local transaction for one submit.
- There is exactly one provider order for one submit.
- Balance debit/refund matches final provider outcome.
- Points are awarded only for qualifying success outcome.
- Recheck does not mutate terminal transactions incorrectly.
- Admin transaction row includes expected provider metadata.
- No unexpected error appears in Node or Rust logs for the dry-run request.

## Stop Conditions

Stop the dry run and keep frontend fallback enabled if any condition occurs:

- API v2 checkout fails while v1 fallback would have recovered.
- Balance is debited without a persisted transaction.
- Transaction is persisted without expected provider reference metadata.
- Provider receives duplicate orders from one submit.
- Immediate provider failed does not refund local balance.
- Immediate provider success does not persist local status.
- Recheck changes a terminal transaction unexpectedly.
- Any unapproved live provider call is observed during sandbox validation.

## Rollback

Frontend rollback:

```bash
cd client && npm run build
```

Deploy the default frontend build without `VITE_TRANSACTION_CREATE_V2_ONLY=true`; this restores v2-first with v1 fallback for saldo checkout.

Backend rollback should only be needed if proxying itself is faulty:

- Keep Node `/v1/transactions` unchanged and available.
- Revert or disable the explicit v2 proxy path only if API v2 proxy behavior causes broad failures.
- Keep Rust direct protected endpoints inaccessible from public traffic.

Data repair should be handled manually from recorded transaction/member/provider details.

## Post-Dry-Run Decision

If all acceptance criteria pass:

- Record transaction id, provider reference, final status, and verifier names.
- Fill and store `API_V2_TRANSACTION_CREATE_DRY_RUN_TEMPLATE.md` output for the run.
- Approve permanent frontend fallback removal for `POST /transactions`.
- Run the full sequential verification suite after removing fallback.

If any acceptance criteria fail:

- Keep fallback enabled.
- File a focused defect with request/response details, logs, transaction id, and provider reference.
