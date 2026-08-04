# API v2 Transaction Create Dry Run Template

Use this template to record one controlled saldo checkout dry run with `VITE_TRANSACTION_CREATE_V2_ONLY=true`.

Related checklist: `API_V2_TRANSACTION_CREATE_DRY_RUN_CHECKLIST.md`.

## Run Metadata

- Date/time:
- Environment:
- Frontend commit/build id:
- Backend commit/build id:
- Rust API commit/build id:
- `VITE_TRANSACTION_CREATE_V2_ONLY=true` confirmed by:
- Operator/verifier names:
- Rollback owner:

## Accounts

- Disposable member email/user id:
- Member starting balance:
- Member starting points:
- Admin/team email/user id:
- Admin/team permissions confirmed:

## Product And Target

- Product name:
- Product code:
- Product id:
- Provider/vendor:
- Provider SKU:
- Payment method: Saldo
- Target/customer number/id:
- Server id, if any:
- Expected amount:
- Flash sale used: yes/no
- Expected points if success:

## Automated Readiness

### Build

Command:

```bash
npm run build:client:transaction-create-v2
```

Result:

- Status: pass/fail
- Notes:

### Provider Readiness Smoke

Command used:

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

Result:

- Status: pass/fail
- Checks passed:
- Notes:

### Guarded API Dry Run Helper

Command used, if run:

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

Result:

- Status: pass/fail/not run
- Result file:
- Transaction id:
- Balance delta:
- Points delta:
- Provider verification still required: yes/no

## Manual Checkout Result

- Submit timestamp:
- User-facing result:
- Redirected to transaction history: yes/no
- Local transaction id:
- Invoice/reference shown to user, if any:
- `vendorTrxId`:
- `sn`, if any:
- Initial local status:
- Amount debited:
- Member balance after submit:
- Member points after submit:
- Error message, if any:

## Provider Verification

- Provider dashboard/status checked by:
- Provider order/reference:
- Provider target:
- Provider amount/product:
- Provider status:
- Duplicate provider order found: yes/no
- Provider notes:

## Admin Verification

- Admin transaction row found: yes/no
- Product matches: yes/no
- Target matches: yes/no
- Amount matches: yes/no
- Status matches provider expectation: yes/no
- `vendorTrxId` matches provider/reference: yes/no
- `sn` matches provider, if applicable: yes/no/not applicable
- Admin recheck timestamp:
- Recheck result message:
- Status after recheck:
- Balance after recheck:
- Points after recheck:

## Acceptance Criteria

Mark each item pass/fail.

- Frontend saldo checkout used API v2 only:
- Exactly one local transaction was created:
- Exactly one provider order was created:
- Balance debit/refund matched final provider outcome:
- Points were awarded only for qualifying success outcome:
- Recheck did not mutate terminal transaction incorrectly:
- Admin transaction row included expected provider metadata:
- Node logs had no unexpected error:
- Rust logs had no unexpected error:

## Stop Conditions

If any item is yes, stop and keep fallback enabled.

- API v2 checkout failed while v1 fallback would have recovered: yes/no
- Balance debited without persisted transaction: yes/no
- Transaction persisted without expected provider reference metadata: yes/no
- Duplicate provider order from one submit: yes/no
- Immediate provider failed did not refund local balance: yes/no
- Immediate provider success did not persist local status: yes/no
- Recheck changed a terminal transaction unexpectedly: yes/no
- Unapproved live provider call observed during sandbox validation: yes/no

## Decision

- Dry run status: pass/fail
- Permanent fallback removal approved: yes/no
- Approved by:
- Approval timestamp:
- Required follow-up defects/tasks:

## Rollback Record

Fill this if rollback was required.

- Rollback triggered: yes/no
- Trigger reason:
- Frontend rebuilt without `VITE_TRANSACTION_CREATE_V2_ONLY=true`: yes/no
- Rollback deployed by:
- Rollback timestamp:
- Data repair needed: yes/no
- Data repair notes:
