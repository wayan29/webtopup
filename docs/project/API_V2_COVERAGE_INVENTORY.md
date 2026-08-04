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
| `npm run api-v2:gateway-order:check` | Static check for Node gateway route ordering hazards |
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
| Public provider callbacks | `/api/v2/webhook/digiflazz`, `/tokovoucher` | handled by Node | public provider callback validation | read smoke negative payload checks |
| Uploads | `/api/v2/upload*` | `/v2/upload*` | folder-specific admin permissions | read smoke, mutation boundary smoke, direct Rust write guards |
| Audit logs | `/api/v2/audit-logs*` | `/v2/audit-logs*` | team permission | read smoke, CSV smoke, mutation boundary smoke, direct Rust read guard |

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
