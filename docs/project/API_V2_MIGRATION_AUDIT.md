# API v2 Migration Audit

Last updated: 2026-05-03

## Architecture Rules

- Public v2 traffic goes through the Node gateway at `/api/v2/*`.
- Rust serves internal v2 routes at `/v2/*` on port `9010`.
- Protected Rust endpoints must require the API v2 proxy context and reject direct calls.
- Node remains the auth and permission authority.
- Frontend migration pattern is v2-first with v1 fallback: `apiV2.*(...).catch(() => api.*(...))`.
- Provider realtime calls and financial state mutations remain on `/v1` until a dedicated risk review is completed. Deposit claim/release/reject/approve, points adjustment, voucher redeem, transaction refund/status/recheck, transaction creation, and guest transaction create/confirm/cancel/status update are reviewed financial/provider workflow exceptions.

## Completed Safe Areas

- Auth reads and profile/preferences reads.
- Open API profile/product/transaction reads are available through API-key authentication; smoke coverage only exercises them when the smoke user already has an API key.
- Admin/member dashboard reads and operational snapshots.
- Public/catalog reads for products, categories, operators, product types, sliders, flash sales, articles, rewards, leaderboard, settings, and payment methods.
- Admin list/read endpoints for reports, audit logs, users, teams, deposits, transactions, guest transactions, vendors, rewards, vouchers, notifications, catalog taxonomy, payments, content, uploads, and Digiflazz Seller configuration/order views.
- Non-financial admin mutations for catalog, taxonomy, payment setup, content, settings, rewards/vouchers administration, notifications state, users, teams, vendors, uploads, webhook config, and Digiflazz Seller settings/mappings.
- CSV exports for audit logs, sales reports, deposits, Digiflazz Seller admin orders, and admin transactions.
- Legacy member read pages now use v2-first for transaction and deposit reads.
- Reviewed deposit admin mutations are available in API v2 and wired v2-first in the admin deposit UI: claim, release claim, reject, and approve.
- Reviewed points adjustment is available in API v2 with atomic points updates, point transaction history, and compensation rollback.
- Reviewed voucher redeem is available in API v2 and wired v2-first in the user redeem UI, with atomic voucher claim, user balance credit, duplicate redeem guard, and compensation rollback.
- Reviewed admin member balance adjustment is available in API v2 and wired v2-first in the admin users UI, with atomic insufficient-balance guard, audit history insert, and compensation rollback.
- Reviewed user deposit creation is available in API v2 and wired v2-first in the deposit UI, with maintenance/settings checks, payment method/category validation, fee calculation, and pending deposit creation parity.
- Reviewed transaction refund is available in API v2 and wired v2-first in the admin transaction UI, with double-refund guard, success-status block, balance credit audit, and compensation rollback.
- Reviewed transaction status update is available in API v2 and wired v2-first in the admin transaction UI, with balance refund/recharge, point award/revoke, `refunded` transitions, guarded concurrency, and compensation rollback.
- Reviewed transaction recheck is available in API v2 and wired v2-first in the admin transaction UI, with mock/live provider status checks, pending no-op handling, terminal transition semantics, guarded concurrency, and compensation rollback.
- Reviewed authenticated saldo transaction creation is available in API v2 and wired v2-first in the order UI, with team/maintenance/product/taxonomy/balance checks, atomic debit guard, flash-sale rollback, provider top-up, immediate refund/points behavior, and v1 fallback. `VITE_TRANSACTION_CREATE_V2_ONLY=true` is available for controlled staging dry runs that force saldo checkout to v2 only.
- Reviewed guest transaction create, confirm, cancel, and manual status update are available in API v2. Public create is now v2-only in the order UI with optional bearer JWT parity and invalid-token-as-guest behavior; admin mutations are wired v2-first in the admin guest transaction UI with proxy protection, guarded transitions, provider mock/sandbox coverage for confirm, and Mongo-backed disposable smoke coverage.
- Tokovoucher cascading read/search endpoints are available in API v2 and admin UI call sites now use v2 directly without v1 fallback. Sandbox provider smoke covers success paths through the local provider stub; live provider verification remains explicit before disabling legacy API routes.
- Digiflazz and Tokovoucher balance endpoints are available in API v2 and provider settings pages now call v2 directly without v1 fallback. The routes call provider realtime balance and honor vendor `apiBaseUrl`; sandbox provider smoke covers both success paths through the local provider stub.
- Vendor connection test is available in API v2 and the admin vendor UI now calls v2 directly without v1 fallback. Sandbox provider smoke covers Digiflazz and Tokovoucher success paths through the local provider stub; live provider verification remains explicit.
- Digiflazz pricelist fetch is available in API v2 and the admin Digiflazz pricelist button now calls v2 directly without v1 fallback. The route preserves `dgcache` replace/index semantics and honors vendor `apiBaseUrl`; sandbox provider smoke covers success path with `dgcache` snapshot/restore.
- Digiflazz settings save is available in API v2 and the admin Digiflazz settings form now calls v2 directly without v1 fallback. The route validates credentials with a Digiflazz balance call before save and honors existing vendor `apiBaseUrl`; sandbox provider smoke covers success path with vendor config snapshot/restore.
- Tokovoucher settings save is available in API v2 and the admin Tokovoucher settings form now calls v2 directly without v1 fallback. The route validates credentials with a Tokovoucher balance call before save and honors existing vendor `apiBaseUrl`; sandbox provider smoke covers success path with vendor config snapshot/restore.
- Vendor product sync is available in API v2 and the admin vendor sync action now calls v2 directly without v1 fallback. The route preserves current v1 behavior: Digiflazz sync fetches provider pricelist and upserts local products; Tokovoucher legacy sync returns zero products because v1 `getPriceList()` is empty. Sandbox provider smoke covers Digiflazz sync with product fixture restore and Tokovoucher zero-count parity. Digiflazz sync allocates new numeric `productId` values from existing numeric product IDs only.
- Vendor health realtime and CSV export are available in API v2 and the admin vendor health page now calls v2 directly without v1 fallback. The full health route preserves v1 realtime balance checks plus transaction, webhook, and seller summaries; sandbox provider smoke covers JSON and CSV success paths through the local provider stub.
- Free Fire and Mobile Legends validation are available in API v2 and order/admin validation UIs now call v2 directly without v1 fallback. The routes preserve v1 input validation, short cache, Codashop primary lookup, and GoPay fallback; sandbox provider smoke covers success paths through the local provider stub while default smoke only covers invalid input boundaries.

## Smoke Coverage

- Rollout and staging validation steps are documented in `API_V2_PROVIDER_ROLLOUT_RUNBOOK.md`.
- Read smoke: `npm run api-v2:smoke` currently covers 106 passing checks, with 6 dynamic checks skipped on the local fixture set.
- Read smoke includes public reads, admin reads, CSV exports, gateway/direct-Rust proxy boundaries, API-key rejection boundaries, and dynamic detail/sorting checks that use existing fixtures.
- Dynamic read smoke skips public reward/article detail checks when no public fixture exists, and skips Open API read checks when the smoke user has no API key.
- Mutation smoke without Mongo fixture access: `RUN_API_V2_MUTATION_SMOKE=1 npm run api-v2:smoke:mutations` currently covers 87 passing checks.
- Mutation smoke with `SMOKE_MONGO_URI`/`MONGO_URI` also runs disposable deposit claim/release/reject/approve, points adjust, voucher redeem, balance adjustment, transaction refund/status update, and guest transaction create/cancel/status update e2e coverage, and currently covers 112 passing checks without member deposit-create credentials.
- Mutation smoke is opt-in only and uses disposable inactive/draft records with cleanup. The optional deposit e2e fixture inserts marked pending deposits directly in Mongo, verifies approval balance credit, restores the smoke user's balance, and deletes fixture deposits. The optional points e2e fixture snapshots/restores the smoke user's points and deletes marked point transaction rows. The optional voucher e2e fixture inserts a disposable voucher, verifies balance credit and duplicate redeem rejection, restores the smoke user's balance, and deletes the voucher. The optional balance adjustment e2e snapshots/restores a member balance and deletes marked balance adjustment audit rows. The optional transaction refund e2e inserts a disposable non-success transaction, verifies refund metadata, balance credit, audit insertion, duplicate refund rejection, then restores balance and deletes fixtures. The optional transaction status e2e inserts a disposable manual transaction, verifies pending/processing/success/failed transitions, balance refund/recharge, point award/revoke, field unset behavior, then restores balance/points and deletes fixtures. The optional guest transaction e2e inserts disposable guest product/payment fixtures, creates a waiting-payment invoice through API v2 with an intentionally invalid bearer token, verifies persistence, verifies cancel/status transitions and `vendorTrxId`/`sn` clear behavior, then deletes fixtures.
- Mutation smoke still does not call provider realtime, transaction creation/recheck, or guest payment confirmation success paths; provider-backed flows are isolated in `npm run api-v2:smoke:providers`.
- Read, mutation, and provider smoke share `/tmp/webtopup-api-v2-smoke-suite.lock`; run them sequentially because they inspect or mutate shared Mongo fixtures.
- Provider smoke is opt-in only, requires `RUN_PROVIDER_SMOKE=1`, `PROVIDER_MODE=mock|sandbox`, backend provider-mode confirmation, and Mongo fixture access. Latest local dry runs cover 11 passing checks in mock mode without member credentials and 31 passing checks in sandbox mode with member credentials. Sandbox mode includes v2 transaction create pending/success/failed, recheck pending/success/failed, guest confirm pending/success/failed, Digiflazz/Tokovoucher settings save, provider balances, vendor connection tests, vendor health JSON/CSV, Digiflazz pricelist fetch/sync, Tokovoucher sync, Tokovoucher cascading read/search, and Free Fire/Mobile Legends validation success paths through the local provider stub. Sandbox game validation requires `CONFIRM_GAME_VALIDATION_SANDBOX=1` plus `GAME_VALIDATION_CODASHOP_BASE_URL` and `GAME_VALIDATION_GOPAY_BASE_URL` pointing at the stub. Set `REQUIRE_TRANSACTION_CREATE_READINESS=1` to make provider smoke fail unless member transaction create pending/success/failed coverage runs.

## Fallback And Deferlist

These endpoint groups either remain on `/v1` or have been migrated to v2 but must keep v1 fallback until the listed verification is complete. Do not remove fallback or migrate remaining endpoints opportunistically without a focused review.

| Area | Endpoint pattern | Reason |
| --- | --- | --- |
| Transactions | `POST /transactions` | Migrated to v2 after provider mock strategy and focused review; default frontend still keeps v1 fallback. Use `VITE_TRANSACTION_CREATE_V2_ONLY=true` only for controlled dry run until live/provider validation is accepted. |
| Transactions | `PUT /transactions/:id/status` | Migrated to v2 after focused review; still keep v1 fallback until production-like dry run. |
| Transactions | `POST /transactions/:id/refund` | Migrated to v2 after focused review; still keep v1 fallback until production-like dry run. |
| Transactions | `POST /transactions/:id/recheck` | Migrated to v2 after provider mock strategy and focused review; keep v1 fallback until production-like dry run. |
| Guest transactions | `POST /guest-transactions` | Frontend fallback removed after disposable invoice smoke and sandbox provider coverage; keep legacy route available until production-like dry run. |
| Vendors | `GET /vendors/digiflazz/balance`, `GET /vendors/tokovoucher/balance` | Frontend fallback removed after local sandbox smoke; live provider verification remains explicit before disabling legacy API routes. |
| Vendors | `POST /vendors/:id/test` | Frontend fallback removed after local sandbox smoke; live provider verification remains explicit before disabling legacy API routes. |
| Vendors | `POST /vendors/:id/sync` | Frontend fallback removed after local sandbox smoke; production-like sync verification remains explicit before disabling legacy API routes. |
| Digiflazz | `POST /vendors/digiflazz/pricelist/fetch` | Frontend fallback removed after local sandbox smoke; production-like provider fetch verification remains explicit before disabling legacy API routes. |
| Digiflazz | `POST /vendors/digiflazz/settings` | Frontend fallback removed after local sandbox smoke; live credential verification remains explicit before disabling legacy API routes. |
| Tokovoucher | `GET /vendors/tokovoucher/categories`, `/operators`, `/jenis`, `/products`, `/search` | Frontend fallback/direct v1 usage removed after local sandbox smoke; live provider verification remains explicit before disabling legacy API routes. |
| Tokovoucher | `POST /vendors/tokovoucher/settings` | Frontend fallback removed after local sandbox smoke; live credential verification remains explicit before disabling legacy API routes. |
| Digiflazz Seller | mapping sync, callback retry, retry queue processing | External callback/retry side effects. |
| Validation | `POST /validate/freefire`, `POST /validate/mobilelegends` | Frontend fallback removed after local sandbox smoke; live validation-provider verification remains explicit before disabling legacy API routes. |
| Security | 2FA setup/confirm/disable, session revoke, team reset 2FA | Security-sensitive account operations. |
| Vendor health | `/vendors/health`, `/vendors/health/export` | Frontend fallback removed after local sandbox smoke; live/provider-data verification remains explicit before disabling legacy API routes. |

## Low-Risk Candidates Remaining

- Replace fallback-only frontend code where the v2 route is already proven and fallback is only legacy resilience.
- Add parity tests/smoke scripts for already-migrated read endpoints.
- Add lightweight Rust read endpoints only when they do not call providers and do not mutate financial/security state.

## Required Review Before Financial Migration

Before migrating deposit, transaction, balance, refund, or guest payment mutations, verify:

- Idempotency for repeated client retries and gateway retries.
- Mongo transaction/session parity where v1 uses multi-step writes.
- Balance mutation rollback behavior.
- Admin audit log parity.
- Claim/lock race behavior for deposits.
- Points/rewards side effects.
- Provider request/response parity and timeout behavior.
- Permission parity in the Node gateway.
- Smoke tests that create disposable records and restore any changed state.

## Critical Migration Checklist

Use this checklist before moving any deferlist endpoint to Rust v2. Each endpoint group needs a short design note or PR description that answers every item below.

### Global Requirements

- Keep Node as the public auth/permission authority and continue forwarding only trusted proxy context to Rust.
- Preserve existing `/v1` response shape, status codes, validation messages, and audit log fields unless a deliberate breaking change is approved.
- Identify every collection written by the v1 path and list whether the write is insert, update, upsert, unset, or delete.
- Identify every derived counter/summary/notification/log side effect and verify ordering relative to the primary write.
- Define retry behavior for duplicate client requests, duplicate gateway retries, and provider timeout retries.
- Decide whether the Rust implementation needs Mongo sessions/transactions or a compensating rollback path.
- Keep v1 fallback in frontend until v2 parity is proven by smoke and one manual production-like dry run.
- Add a direct Rust negative test for missing proxy context and a gateway negative test for missing/insufficient auth.

### Deposits

- `POST /deposits`: migrated to v2; verifies maintenance/settings checks, payment method/category active state, operational windows, min/max amount rules, fee calculation, unique code generation, and pending deposit creation. User deposit UI is v2-first with v1 fallback.
- `POST /deposits/:id/claim`: migrated to v2; preserves admin claim locking, self-claim idempotency, owner release override, and direct Rust proxy rejection.
- `POST /deposits/:id/release-claim`: migrated to v2; release does not alter deposit financial state.
- `PUT /deposits/:id/reject`: migrated to v2; preserves required rejection note validation, assignment access filter, and processed-by metadata.
- `PUT /deposits/:id/approve`: migrated to v2; preserves duplicate-process protection, net amount calculation, user balance credit, and compensation rollback if user update fails.
- Smoke strategy: implemented as optional Mongo-backed e2e using disposable marked deposits; never processes a real user payment instruction and restores the smoke user's balance after approval. Deposit create e2e is available only when `SMOKE_MEMBER_EMAIL`/`SMOKE_MEMBER_PASSWORD` are configured, creates disposable payment setup, and deletes the pending deposit afterward.

### Transactions

- `POST /transactions`: migrated to v2; preserves team rejection, maintenance checks, product lookup, taxonomy availability, user-level pricing, flash-sale pricing/reservation, atomic balance debit guard, ref-id generation, provider top-up, immediate failed refund, and immediate success point award. User order UI is v2-first with v1 fallback.
- `PUT /transactions/:id/status`: migrated to v2; preserves `processManualTransaction` gateway permission, balance refund/recharge rules, points award/revoke rules, `vendorTrxId`/`sn` set-unset semantics, guarded concurrency, and compensation rollback.
- `POST /transactions/:id/refund`: migrated to v2; preserves idempotency, balance refund before/after, double-refund protection, audit log parity, compensation rollback, and Mongo-backed e2e cleanup.
- `POST /transactions/:id/recheck`: migrated to v2; preserves provider status lookup, pending no-op behavior, terminal status transitions, point/balance side effects, and direct Rust proxy rejection. Admin transaction UI is v2-first with v1 fallback.
- Smoke strategy: default mutation smoke only covers non-provider boundaries. Provider-backed create/recheck coverage lives in opt-in provider smoke with `PROVIDER_MODE=mock`; member create e2e additionally requires member smoke credentials.

### Guest Transactions

- `POST /guest-transactions`: migrated to v2; preserves public unauthenticated access, maintenance and guest checkout settings, product/taxonomy/payment constraints, optional valid bearer JWT pricing/ownership, invalid bearer tokens as guest, flash-sale reservation with rollback on later v2 failures, invoice generation, and payment instruction response shape. Order UI is v2-first with v1 fallback.
- `POST /guest-transactions/:id/confirm`: migrated to v2; preserves `processManualTransaction` gateway permission, direct Rust proxy rejection, guarded waiting-payment claim before provider top-up, duplicate confirmation rejection, provider pending/success/failed updates, and provider error fallback to paid/processing follow-up.
- `POST /guest-transactions/:id/cancel`: migrated to v2; preserves `processManualTransaction` gateway permission, direct Rust proxy rejection, waiting-payment and paid/failed guarded updates, paid/processing and paid/success rejection messages, and populated admin response shape.
- `PUT /guest-transactions/:id/status`: migrated to v2; preserves `processManualTransaction` gateway permission, payment-status-aware transition validation, optional `vendorTrxId`/`sn` set-unset semantics, status updater metadata, and populated admin response shape.
- Smoke strategy: implemented for create/cancel/status as optional Mongo-backed e2e using isolated disposable guest product/payment/transaction records. Guest confirm provider outcomes are covered only by opt-in provider smoke with mock/sandbox mode and disposable waiting-payment guest fixtures.

### Balance, Points, And Vouchers

- `POST /users/:id/balance`: migrated to v2; verifies role/permission gate, balance before/after, reason requirements, audit log, insufficient-balance guard, and compensation rollback. Admin users UI is v2-first with v1 fallback.
- `POST /points/adjust`: migrated to v2; verifies points before/after, adjustment type, point transaction history, and compensation rollback behavior. Optional Mongo-backed smoke snapshots/restores points and deletes marked history rows.
- `POST /vouchers/redeem`: migrated to v2; verifies code normalization, redeemed/archived guard, balance before/after, redeemed metadata, duplicate redeem protection, and compensation rollback. User UI is v2-first with v1 fallback.
- Smoke strategy: implemented as optional Mongo-backed e2e using a disposable voucher and smoke user balance snapshot/restore; do not run against normal operator/admin accounts.

### Provider Realtime And Validation

- Provider balances, product sync, pricelist fetch, settings save, vendor health, and game validation must keep timeout, credential masking, and error normalization parity. Provider balance routes, vendor connection test, vendor product sync, Digiflazz pricelist fetch, Digiflazz/Tokovoucher settings save, Tokovoucher cascading read/search routes, vendor health, and Free Fire/Mobile Legends validation now have local sandbox provider smoke success coverage, but live/provider-data verification remains explicit before removing remaining fallbacks or disabling legacy API routes.
- Separate pure cache/database reads from realtime calls; migrate pure reads first and keep realtime provider calls on `/v1` until sandbox verification exists.
- Provider sandbox/mock prerequisites are documented in `API_V2_PROVIDER_SANDBOX_STRATEGY.md`.
- Smoke strategy: require explicit sandbox credentials or mock mode; never call live provider endpoints from default smoke.

### Security-Sensitive Operations

- 2FA setup/confirm/disable, session revoke, and team reset 2FA require threat-model review before migration.
- Verify token/session invalidation semantics, rate limits, recovery paths, and audit log parity.
- Smoke strategy: use a disposable staff/member account and restore 2FA/session state after the run.
