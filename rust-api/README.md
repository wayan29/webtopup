# WebTopup API v2

Rust API v2 service that runs behind the Node/Fastify gateway.

## Purpose

- Serve the business API v2 routes used by the frontend through Node's public `/api/v2/*` gateway.
- Keep Node as the public gateway for auth, proxy context, compatibility, static frontend, and public webhook aliases.
- Keep API v1 available only as a deprecated legacy compatibility layer while API v2 usage is verified.
- Reject protected direct Rust requests unless they include the trusted proxy context and `API_V2_PROXY_SECRET` sent by Node.

## Local Ports

- Node gateway: `9005`
- Frontend: `9006`
- Internal Rust API v2: `9010`

## Run

Install Rust first if `cargo` is not available:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then run:

```bash
cd rust-api
cp .env.example .env
cargo run
```

From the repository root, the helper scripts are:

```bash
npm run api-v2:dev
npm run api-v2:fmt
npm run api-v2:check
npm run api-v2:build
```

For local gateway testing, Node and API v2 must share the same `API_V2_PROXY_SECRET`, `JWT_SECRET`, and Mongo configuration.

## Endpoints

Login is split into two audience-bound channels. The route decides the audience; nothing in the
JSON body, query string, or request headers can select it. A credential presented on the wrong
channel is rejected after password verification with the same generic message as a bad password,
so the response never discloses whether the account exists or which role it holds.

| Route | Accepted roles | Remember me |
| --- | --- | --- |
| `POST /v2/auth/member/login` | `member` | honored |
| `POST /v2/auth/staff/login` | `owner`, `admin`, `cs` | forced off |

The former role-agnostic `POST /v2/auth/login` no longer exists. Legacy API v1 keeps its own
`/auth/login` and is unaffected.

```text
GET /health
POST /v2/auth/member/login
POST /v2/auth/staff/login
GET /v2/auth/me
GET /v2/auth/2fa/status
POST /v2/auth/register
GET /v2/api/key
GET /v2/api/profile
GET /v2/api/products
GET /v2/api/transaction/check
GET /v2/api/transactions
GET /v2/ping
GET /v2/system/status
GET /v2/vendors
GET /v2/vendors/admin/all
GET /v2/vendors/{id}
GET /v2/vendors/digiflazz/balance
GET /v2/vendors/digiflazz/pricelist
GET /v2/vendors/digiflazz/settings
GET /v2/vendors/health-snapshot
GET /v2/vendors/{id}/stats
GET /v2/vendors/tokovoucher/balance
GET /v2/vendors/tokovoucher/settings
GET /v2/vouchers
GET /v2/webhook/digiflazz/config
GET /v2/webhook/digiflazz/logs
GET /v2/webhook/tokovoucher/config
GET /v2/webhook/tokovoucher/logs
GET /v2/articles
GET /v2/articles/{slug}
GET /v2/audit-logs
GET /v2/dashboard/ops-snapshot
GET /v2/categories/admin/all
GET /v2/categories
GET /v2/categories/{id}
GET /v2/deposits
GET /v2/deposits/admin/all
GET /v2/deposits/admin/list
GET /v2/deposits/queue-snapshot
GET /v2/digiflazz-seller/logs
GET /v2/digiflazz-seller/mappings
GET /v2/digiflazz-seller/orders
GET /v2/digiflazz-seller/orders/process-callback-retries/scheduler/config
GET /v2/digiflazz-seller/settings
GET /v2/flash-sales/admin/all
GET /v2/flash-sales/admin/{id}
GET /v2/flash-sales/active
GET /v2/flash-sales/price/{productId}
GET /v2/guest-transactions/check/{invoiceNumber}
GET /v2/leaderboard
GET /v2/margins
GET /v2/notifications/admin
GET /v2/notifications/admin/summary
GET /v2/operators/admin/all
GET /v2/operators/admin/{id}
GET /v2/operators
GET /v2/operators/{id}
GET /v2/payment-categories
GET /v2/payment-categories/active
GET /v2/payment-categories/admin/all
GET /v2/payment-methods
GET /v2/payment-methods/active
GET /v2/payment-methods/admin/all
GET /v2/products/admin/all
GET /v2/products/admin/catalog-audit
GET /v2/products/admin/sorting
GET /v2/products
GET /v2/products/{id}
GET /v2/product-types/admin/all
GET /v2/product-types/admin/{id}
GET /v2/product-types
GET /v2/product-types/{id}
GET /v2/points/settings
GET /v2/points/stats
GET /v2/points/history
GET /v2/points/transactions
GET /v2/reports/sales
GET /v2/reports/sales/summary
GET /v2/reports/dashboard
GET /v2/rewards
GET /v2/rewards/{id}
GET /v2/rewards/admin/all
GET /v2/settings/admin/all
GET /v2/settings/admin/{key}
GET /v2/settings/public
GET /v2/sliders
GET /v2/sliders/admin/all
GET /v2/teams
GET /v2/teams/admin/audit-logs
GET /v2/teams/admin/list
GET /v2/teams/audit-logs
GET /v2/teams/login-logs/all
GET /v2/teams/{id}
GET /v2/teams/{id}/login-logs
GET /v2/guest-transactions
GET /v2/transactions/admin
GET /v2/transactions/admin/stuck
GET /v2/transactions/manual
GET /v2/transactions/stuck
GET /v2/transactions
GET /v2/upload/list
GET /v2/users
GET /v2/users/admin/list
GET /v2/users/me/balance-history
GET /v2/users/me/login-activity
GET /v2/users/me/preferences
GET /v2/users/me/profile
GET /v2/users/{id}
GET /v2/users/{id}/balance-adjustments
```

Expected checks:

```bash
curl http://localhost:9010/health
curl http://localhost:9010/v2/ping
```

Public gateway checks through Node:

```bash
curl http://localhost:9005/api/v2/health
curl http://localhost:9005/api/v2/ping
```

Frontend and public gateway routes use Node's `/api/v2/*` prefix. Public read-only routes do not require a JWT:

```text
GET /api/v2/articles
GET /api/v2/articles/{slug}
GET /api/v2/categories
GET /api/v2/flash-sales/active
GET /api/v2/flash-sales/price/{productId}
GET /api/v2/guest-transactions/check/{invoiceNumber}
GET /api/v2/leaderboard
GET /api/v2/operators
GET /api/v2/operators/{id}
GET /api/v2/payment-categories
GET /api/v2/payment-methods
GET /api/v2/products
GET /api/v2/products/{id}
GET /api/v2/product-types
GET /api/v2/product-types/{id}
GET /api/v2/rewards
GET /api/v2/rewards/{id}
GET /api/v2/settings/public
GET /api/v2/sliders
```

Protected gateway routes must be called through Node gateway with a valid JWT:

```text
POST /api/v2/auth/member/login
POST /api/v2/auth/staff/login
POST /api/v2/auth/register
GET /api/v2/auth/me
GET /api/v2/auth/2fa/status
GET /api/v2/api/key
GET /api/v2/api/profile
GET /api/v2/api/products
GET /api/v2/api/transaction/check
GET /api/v2/api/transactions
GET /api/v2/system/status
GET /api/v2/vendors
GET /api/v2/vendors/admin/all
GET /api/v2/vendors/{id}
GET /api/v2/vendors/digiflazz/balance
GET /api/v2/vendors/digiflazz/pricelist
GET /api/v2/vendors/digiflazz/settings
GET /api/v2/vendors/health-snapshot
GET /api/v2/vendors/{id}/stats
GET /api/v2/vendors/tokovoucher/balance
GET /api/v2/vendors/tokovoucher/settings
GET /api/v2/vouchers
GET /api/v2/webhook/digiflazz/config
GET /api/v2/webhook/digiflazz/logs
GET /api/v2/webhook/tokovoucher/config
GET /api/v2/webhook/tokovoucher/logs
GET /api/v2/audit-logs
GET /api/v2/dashboard/ops-snapshot
GET /api/v2/categories/admin/all
GET /api/v2/categories/{id}
GET /api/v2/deposits
GET /api/v2/deposits/admin/all
GET /api/v2/deposits/admin/list
GET /api/v2/deposits/queue-snapshot
GET /api/v2/digiflazz-seller/logs
GET /api/v2/digiflazz-seller/mappings
GET /api/v2/digiflazz-seller/orders
GET /api/v2/digiflazz-seller/orders/process-callback-retries/scheduler/config
GET /api/v2/digiflazz-seller/settings
GET /api/v2/flash-sales/admin/all
GET /api/v2/flash-sales/admin/{id}
GET /api/v2/margins
GET /api/v2/notifications/admin
GET /api/v2/notifications/admin/summary
GET /api/v2/operators/admin/all
GET /api/v2/operators/admin/{id}
GET /api/v2/payment-categories/active
GET /api/v2/payment-categories/admin/all
GET /api/v2/payment-methods/active
GET /api/v2/payment-methods/admin/all
GET /api/v2/products/admin/all
GET /api/v2/products/admin/catalog-audit
GET /api/v2/products/admin/sorting
GET /api/v2/product-types/admin/all
GET /api/v2/product-types/admin/{id}
GET /api/v2/points/settings
GET /api/v2/points/stats
GET /api/v2/points/history
GET /api/v2/points/transactions
GET /api/v2/reports/sales
GET /api/v2/reports/sales/summary
GET /api/v2/reports/dashboard
GET /api/v2/rewards
GET /api/v2/rewards/{id}
GET /api/v2/rewards/admin/all
GET /api/v2/settings/admin/all
GET /api/v2/settings/admin/{key}
GET /api/v2/sliders/admin/all
GET /api/v2/teams
GET /api/v2/teams/admin/audit-logs
GET /api/v2/teams/admin/list
GET /api/v2/teams/audit-logs
GET /api/v2/teams/login-logs/all
GET /api/v2/teams/{id}
GET /api/v2/teams/{id}/login-logs
GET /api/v2/guest-transactions
GET /api/v2/transactions/admin
GET /api/v2/transactions/admin/stuck
GET /api/v2/transactions/manual
GET /api/v2/transactions/stuck
GET /api/v2/transactions
GET /api/v2/upload/list
GET /api/v2/users
GET /api/v2/users/admin/list
GET /api/v2/users/me/balance-history
GET /api/v2/users/me/login-activity
GET /api/v2/users/me/preferences
GET /api/v2/users/me/profile
GET /api/v2/users/{id}
GET /api/v2/users/{id}/balance-adjustments
```

## Migration Notes

- Do not expose Rust API v2 directly to public clients; use Node `/api/v2/*`.
- Preserve existing JSON response shapes when mirroring Node routes.
- Keep API v1 available only for observed legacy consumers until its usage window is clear.
- Use smoke tests before enabling write-heavy or provider-backed flows outside local sandbox.
- Use `/v2/system/status` to verify API v2 and database connectivity.
- Use `/v2/vendors/health-snapshot` as a read-only MongoDB snapshot before moving realtime vendor checks.
