# API v2 Staging Verification

This runbook verifies a staging deployment after moving the frontend to API v2-only paths.

## Required Runtime

- Node gateway is deployed and reachable through `API_BASE_URL`.
- Rust API is deployed and reachable by Node through `API_V2_UPSTREAM_URL`.
- Node and Rust share the same `API_V2_PROXY_SECRET`.
- Node and Rust share compatible `JWT_SECRET` and Mongo settings.
- Staging Mongo is isolated from production or explicitly approved for mutation smoke.

## Accounts

- `SMOKE_EMAIL` must be an owner/admin/team account with the permissions used by smoke tests.
- `SMOKE_MEMBER_EMAIL` must be a disposable member account for provider and transaction-create checks.
- The dry-run member must have enough balance for the approved low-value product.

## Local Runner

Create a private env file outside git from `.env.staging.example`, then run:

```bash
set -a
. /secure/path/webtopup-staging.env
set +a
npm run staging:smoke
```

Optional mutation smoke:

```bash
npm run staging:smoke:mutations
```

Optional provider readiness smoke against sandbox provider endpoints:

```bash
npm run staging:smoke:providers
```

Guarded transaction-create dry run:

```bash
npm run staging:dry-run:transaction-create
```

The dry run refuses to start unless all required `DRY_RUN_*` values and balance-change confirmation are set.

## GitHub Actions

Use workflow `API v2 staging verification` from the Actions tab.

Required repository secrets:

- `STAGING_API_BASE_URL`
- `STAGING_API_V2_DIRECT_URL` if direct Rust is reachable from GitHub Actions. Leave unset for internal-only Rust.
- `STAGING_SMOKE_EMAIL`
- `STAGING_SMOKE_PASSWORD`
- `STAGING_SMOKE_MEMBER_EMAIL`
- `STAGING_SMOKE_MEMBER_PASSWORD`
- `STAGING_MONGO_URI`
- `STAGING_MONGO_DB`

If Rust is internal-only, GitHub Actions will skip direct Rust proxy-guard checks. Run the same smoke commands from a staging host or VPN runner with `API_V2_DIRECT_URL` set to cover those guards.

Provider smoke secrets:

- `STAGING_PROVIDER_SANDBOX_DIGIFLAZZ_BASE_URL`
- `STAGING_PROVIDER_SANDBOX_TOKOVOUCHER_BASE_URL`
- `STAGING_GAME_VALIDATION_CODASHOP_BASE_URL`
- `STAGING_GAME_VALIDATION_GOPAY_BASE_URL`

Transaction dry-run secrets:

- `STAGING_DRY_RUN_MEMBER_EMAIL`
- `STAGING_DRY_RUN_MEMBER_PASSWORD`
- `STAGING_DRY_RUN_ADMIN_EMAIL`
- `STAGING_DRY_RUN_ADMIN_PASSWORD`
- `STAGING_DRY_RUN_PRODUCT_CODE`
- `STAGING_DRY_RUN_TARGET`
- `STAGING_DRY_RUN_SERVER_ID` if the product requires server id.

## Stop Conditions

- Any smoke check fails with 5xx.
- `API v2 upstream unavailable` appears in Node responses.
- Direct Rust protected mutations do not return `403` without proxy context.
- Provider smoke hits live provider unintentionally.
- Transaction dry run changes a non-disposable account or unexpected balance amount.

## After Success

- Save the transaction dry-run artifact if executed.
- Monitor staging logs for `502`, `403 API v2 proxy access required`, transaction provider errors, and balance audit anomalies.
- Promote to production only after manual QA of 2FA, password change, checkout saldo, guest checkout, deposits, manual transactions, uploads, and Digiflazz Seller callback actions.
