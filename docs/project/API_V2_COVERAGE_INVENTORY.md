# API v2 Coverage Inventory

API v2 public traffic enters through the Node gateway at `/api/v2/*`. Protected Rust routes must only accept trusted proxy context from Node and reject direct access with `403` when the proxy secret/context is absent.

## Verification Commands

| Command | Coverage |
| --- | --- |
| `npm run api-v2:check` | Rust formatting and compile check |
| `npm run build` | Client and Node server build |
| `npm run api-v2:smoke` | Gateway read smoke; direct Rust guards skipped unless `API_V2_DIRECT_URL` is set |
| `npm run api-v2:smoke:guards` | Gateway read smoke plus direct Rust protected read guard checks |
| `npm run api-v2:verify:local:read:guarded` | Check/build/read smoke plus direct Rust read guards |
| `npm run api-v2:verify:local:mutations` | Guarded mutation e2e smoke with Mongo fixture restore |
| `npm run api-v2:verify:local:full` | Read verify plus guarded mutation smoke |
| `npm run api-v2:smoke:sql-owner` | Create-only owner, duplicate refusal, disabled-account preservation on a disposable PostgreSQL database |
| `npm run api-v2:smoke:sql-profile` | Gateway registration/login and SQL profile read/update/collision/validation on a disposable PostgreSQL database |
| `npm run api-v1:usage-report -- <log-path>` | Summarize deprecated `/v1` usage observed in Node logs |

Release checklist lengkap ada di [API_V2_RELEASE_GATE.md](API_V2_RELEASE_GATE.md).

## Route Groups

| Group | Public Gateway | Internal Rust | Auth Boundary | Smoke Coverage |
| --- | --- | --- | --- | --- |
| Health | `/api/v2/health`, `/api/v2/ping` | `/health`, `/v2/ping` | public | read smoke |
| Auth | `/api/v2/auth/*` | `/v2/auth/*` | public login/register; token for profile/2FA/session | read smoke, mutation smoke, direct write guards |
| Open API | `/api/v2/api/*` | `/v2/api/*` | JWT for key management; API key for partner reads | read smoke with generated fixture key, API-key negative checks |
| Products and taxonomy | `/api/v2/products`, `/categories`, `/operators`, `/product-types` | matching `/v2/*` | public reads; `manageProducts` admin writes | read smoke, mutation smoke |
| Payments | `/api/v2/payment-methods`, `/payment-categories` | matching `/v2/*` | public/active reads; payment permissions for admin writes | read smoke, mutation smoke |
| Transactions | `/api/v2/transactions*` | `/v2/transactions*` | member reads; transaction permissions for admin/manual actions | read smoke, mutation smoke, direct read/write guards |
| Deposits | `/api/v2/deposits*` | `/v2/deposits*` | member reads; deposit permissions for admin actions | read smoke, mutation smoke, direct read/write guards |
| Guest transactions | `/api/v2/guest-transactions*` | `/v2/guest-transactions*` | public create/check; admin actions require manual transaction permission | read smoke, mutation smoke |
| Reports and dashboard | `/api/v2/reports/*`, `/dashboard/*`, `/system/status` | matching `/v2/*` | dashboard/report/team permissions | read smoke, direct Rust read guards |
| Users and teams | `/api/v2/users*`, `/teams*` | matching `/v2/*` | self routes for authenticated users; admin/team permissions for admin reads/writes | read smoke, mutation smoke, direct Rust read/write guards |
| Rewards and vouchers | `/api/v2/rewards*`, `/vouchers*` | matching `/v2/*` | public reward reads; voucher/member/admin boundaries | read smoke, mutation smoke |
| Content | `/api/v2/sliders*`, `/flash-sales*`, `/articles*` | matching `/v2/*` | public reads; product/settings permissions for admin writes | read smoke, mutation smoke |
| Vendors | `/api/v2/vendors*`, `/digiflazz-seller*` | matching `/v2/*` | vendor permissions | read smoke, provider smoke, mutation smoke, direct Rust guards |
| Notifications | `/api/v2/notifications/*` | `/v2/notifications/*` | dashboard permission | read smoke, mutation smoke, direct Rust read/write guards |
| Webhook admin config/logs | `/api/v2/webhook/*/config`, `/logs` | `/v2/webhook/*` | vendor permission | read smoke, mutation smoke, direct Rust write guard |
| Public provider callbacks | `POST /api/v2/webhook/digiflazz`, `/api/v2/webhook/tokovoucher` | Node rate-limits and proxies the raw body to `/v2/webhook/{provider}`; Rust validates signature/IP allowlist and applies SQL transaction, ledger, webhook-event, status-event, and log writes | public provider signature and configured allowlist | read smoke negative payload checks; SQL financial smoke |
| Uploads | `/api/v2/upload*` | `/v2/upload*` | folder-specific admin permissions | read smoke, mutation boundary smoke, direct Rust write guards |
| Audit logs | `/api/v2/audit-logs*` | `/v2/audit-logs*` | team permission | read smoke, CSV smoke, mutation boundary smoke, direct Rust read guard |

### Active webhook and response lifecycle details

- Active callbacks are the two `/api/v2/webhook/*` routes in `server/src/routes/apiV2ProxyRoutes.ts`; `rust-api/src/routes/webhooks/receive.rs` validates and mutates PostgreSQL atomically. These are not Node-local business handlers.
- `server/src/routes/webhookRoutes.ts` contains legacy Mongo handlers but has no import/registration from the active server entry point. Treat that module as unmounted, not as a live fallback or a migrated route.
- `server/src/app.ts` installs an `onResponse` hook for every Fastify response. It invokes `recordAdminAuditLog(request, statusCode)` and `logApiV1Usage`; admin audit is filtered, sanitized, persisted through the internal Rust audit endpoint, and failures are logged without replacing the original response.
### Route ownership and migration contract

| Active route family | Gateway boundary | Current Rust/domain owner | IDs and observable outcomes | Durable effects / asynchronous work |
| --- | --- | --- | --- | --- |
| `/auth/*` | Public login/register plus authenticated session routes; trusted mutation guard, rate limits, and refresh/logout cookie handling in `apiV2ProxyRoutes.ts` | `sql_auth` and `routes/auth` | SQL UUID users/session IDs; structured auth errors; cookies `wb_refresh`, `wb_rotation_recovery`, `wb_csrf` are gateway-owned | PostgreSQL `users`, `auth_sessions`, challenges, audit/security changes; T05/T06/T07–T11 |
| `/api/*` partner API | HMAC/API-key verification or authenticated key management | `routes/open_api` | Numeric product business IDs and opaque UUID account/session IDs; API-specific JSON errors | PostgreSQL credentials/session-admitted users and financial transactions; T18/T27 |
| Products, categories, operators, product types, validation products | Public reads; `viewProducts` reads; `manageProducts` writes; validation-product admin uses `manageSettings` | `routes/products`, `taxonomy`, `validation_products` | Product IDs are numeric business IDs; taxonomy entity IDs are UUID; JSON status/error responses | PostgreSQL catalog, ID integrity and audit; validation uses provider/network calls; T12/T13/T18 |
| Payment methods/categories | Public/active reads; payment permissions on admin surfaces; credential mutations require step-up | `routes/payment` | UUID records; HTTP validation/not-found/conflict errors | PostgreSQL configuration and payment references; T14/T21 |
| Transactions, deposits, guest transactions | Member auth; staff permission gates; finance mutations require idempotency/step-up where defined; public guest create/check is rate-limited | `routes/transactions`, `deposits`, `guest_transactions` | UUID database IDs, provider reference/invoice identifiers; status transitions return conflict/validation errors | PostgreSQL wallet ledger, financial transactions, deposits, idempotency, outbox/webhook state; T14–T21 |
| Users, teams, sessions, profile and avatar | Self-service authentication; team/user permissions; selected credential/team/export writes require step-up | `routes/users`, `teams`, `sql_auth` | SQL UUID identity; legacy Mongo-only callers are called out in task status until migrated | PostgreSQL identity/session/audit; upload storage and managed-asset registry for avatar; T05–T11/T23 |
| Rewards, points, vouchers, giveaway | Public reward reads; authenticated member claims; admin permission plus idempotency/step-up for sensitive mutations | `routes/rewards`, `vouchers` | UUID SQL identities; campaign/voucher codes remain business identifiers | PostgreSQL rewards, claims, points, ledger/idempotency and managed-asset references; T26 and follow-ups |
| Articles, sliders, flash sales | Public reads; settings/product permissions for admin operations; slider writes use idempotency and optional step-up | `routes/articles`, `content`, `services/flash_sales` | Slugs/product IDs are business keys; slider/SQL entity IDs are UUID; HTTP 404/409 for missing/conflicting state | PostgreSQL content/snapshots/asset references; flash-sale checkout mutations must remain atomic; T25 and follow-ups |
| Vendors, seller integrations, callbacks | Vendor permissions for admin; public provider callbacks are rate-limited; externally invoked retry endpoint requires `X-Scheduler-Token` with configured secret | `routes/vendors`, `digiflazz_seller`, `irs_seller`, `webhooks` | UUID configuration/order identifiers; provider transaction references remain external IDs; 401/403/409/503 errors at trust/state boundaries | Provider configuration and financial webhook ledger transitions use PostgreSQL; active seller retry handler still prefers Mongo when configured, with a SQL fallback and separate SQL callback routes; external provider API calls; T22 remains open |
| Reports, dashboard, notifications, audit | Dashboard/report/team permissions; sensitive export step-up | `routes/reports`, `dashboard`, `notifications`, `audit_logs` | UUID actor/record IDs, date/range filters; CSV or JSON status/error responses | PostgreSQL reports/snapshots/audit/notifications; gateway onResponse audit is separate from route audit; T28/T29 |
| Uploads | Authenticated, folder-to-permission policy in gateway | `routes/uploads`, `services/managed_assets` | UUID asset IDs and managed references; multipart validation and size errors | Filesystem/object-store plus PostgreSQL managed references; T23 |

- Gateway route registrations are authoritative for reachability; Rust `.route(...)` mounts are the upstream contract. Unmounted Node route modules are not active routes.
- Route groups above identify migration owners and durable stores; they do not claim each individual handler has completed SQL cutover. Check the linked task status for each incomplete domain slice.
- Financial callbacks in `rust-api/src/routes/webhooks/receive.rs` accept `success`/`failed`, return `200` for applied/replay, `400` for invalid payload, `401` for invalid signature, `403` for allowlist rejection, `409` for rejected transition, and `503` if configuration/store is unavailable.
- Seller retry processing is externally invoked, not an in-process timer. The public gateway callback-retry route is rate-limited and requires `X-Scheduler-Token` in Rust, but currently dispatches to `process_due_callback_retries_inner`, which uses Mongo whenever `mongo_client` exists; do not count it as SQL-cutover complete. The direct SQL `process_sql_seller_callbacks` route uses the same token but is a distinct mount.
### Baseline caveat

- T01’s required pre-cutover read-only baseline against the legacy disposable Mongo stack has not been rerun. The checked-in `api-v2:smoke` includes authenticated requests that update session activity; do not run it against a shared/live database under the label “read-only.” Run it only with a disposable fixture stack and document its writes before using it as baseline evidence.
- Current SQL profile and owner smoke results are documented in the migration checklist; they are post-migration evidence, not a substitute for that baseline.


## Direct Rust Guard Set

Read smoke currently verifies direct Rust rejection for representative protected reads:

| Internal Path | Expected |
| --- | --- |
| `/v2/transactions` | `403` |
| `/v2/transactions/admin?limit=1` | `403` |
| `/v2/deposits/admin/list?limit=1` | `403` |
| `/v2/users/admin/list?limit=1` | `403` |
| `/v2/teams/admin/list` | `403` |
| `/v2/settings/admin/all` | `403` |
| `/v2/reports/sales/export` | `403` |
| `/v2/audit-logs/export` | `403` |
| `/v2/system/status` | `403` |
| `/v2/dashboard/ops-snapshot` | `403` |
| `/v2/notifications/admin/summary` | `403` |
| `/v2/vendors/digiflazz/balance` | `403` |
| `/v2/vendors/tokovoucher/balance` | `403` |

Mutation smoke separately verifies direct Rust rejection for representative protected write paths, including deposits, transactions, 2FA/session, teams, vendors, margins, uploads, notifications, and webhook config.

## V1 Removal Readiness

Do not remove `/v1` until the deprecation logs show no external usage for the agreed observation window. Before removal, run `npm run api-v1:removal-readiness` and keep this inventory updated with each `/v1` successor path and smoke coverage status.
