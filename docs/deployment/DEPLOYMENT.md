# Deployment Guide (Production)

This guide assumes you are deploying to a Linux VPS (Ubuntu/Debian) with Node.js, MongoDB, and Nginx installed.

Production configuration must use **safe placeholders only** until real secrets are generated offline and stored in ignored local env files. Example values below are **not** deployable credentials.

**Replace every `.invalid` host and every `replace-with-*` / `<same-as-*>` placeholder with your real values before running Certbot, curl, Nginx enablement, or any live deploy command.**

## 1. Prerequisites

- **Node.js** `^20.19.0` or `>=22.12.0` (required by Vite 7). Recommend current supported LTS that satisfies this range (Node 22 LTS, or Node 20.19+)
- **MongoDB** (replica set or sharded cluster recommended for API v2 financial mutations)
- **Rust toolchain** (for API v2): `rustup`, `cargo`
- **PM2** (Process Manager): `npm install -g pm2`
- **Nginx** (Web Server)

Canonical non-secret templates:

- `server/.env.example`
- `rust-api/.env.example`
- `client/.env.example`

Related operator docs:

- [SESSION_LIFECYCLE_ROLLOUT.md](SESSION_LIFECYCLE_ROLLOUT.md)
- [OPENTELEMETRY_JAEGER.md](OPENTELEMETRY_JAEGER.md)
- [API_V2_STAGING_VERIFICATION.md](API_V2_STAGING_VERIFICATION.md)

## 2. Environment Setup

Copy templates into ignored real env files on the host; never commit them.

```bash
cp server/.env.example server/.env
cp rust-api/.env.example rust-api/.env
cp client/.env.example client/.env.production
```

### Required shared security settings

These must match across Node and Rust unless noted:

| Setting | Services | Notes |
| --- | --- | --- |
| `JWT_SECRET` | Node + Rust | ≥32 chars; access token signing |
| `API_V2_PROXY_SECRET` | Node + Rust | ≥32 chars; rejects direct protected Rust access |
| Session rollout flags | Node + Rust | `SESSION_REFRESH_ENABLED`, cohort percents, `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL` |
| `MONGO_URI` | Node + Rust | canonical Mongo connection variable |
| `MONGO_DB` | Rust required; same logical DB as Node | do not treat `MONGODB_URI` as preferred runtime name |
| `UPLOAD_DIR` | Node + Rust | shared absolute upload path |
| `PUBLIC_APP_URL` / `API_V2_ALLOWED_ORIGIN` | Node / Rust | exact frontend origin (scheme + host + non-default port) |
| `API_V2_UPSTREAM_URL` | Node | private Rust base URL |

### Rust-only session/security settings

Current source reads these in **Rust only**. Generate them independently for `rust-api/.env`; do **not** duplicate them into Node:

| Setting | Owner | Notes |
| --- | --- | --- |
| `SESSION_TOKEN_HASH_SECRET` | Rust | required; generate independently; never reuse `JWT_SECRET` |
| `SESSION_ROTATION_ACTIVE_KEY_ID` / `SESSION_ROTATION_KEYS` | Rust | rotation key ring (base64url no-pad, 32-byte keys) |
| `SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID` / `SESSION_RECOVERY_ENCRYPTION_KEYS` | Rust | separate AEAD ring; retain retired keys through recovery windows |

### Mongo transactions

| Setting | Owner / scope | Notes |
| --- | --- | --- |
| `MONGO_TRANSACTIONS_ENABLED` | **Rust required** for API v2 financial mutations (defaults to `true` when unset) | keep `true` in production on a transaction-capable Mongo deployment |
| `MONGO_TRANSACTIONS_ENABLED` | **Node feature-specific** | consulted only for legacy webhook behavior, not as a general shared stack-wide financial switch |

### Feature-dependent and optional settings

- **Provider credentials / mode:** Digiflazz and Tokovoucher credentials, `PROVIDER_MODE`, sandbox base URLs. Live providers require explicit approval and real credentials; template placeholders are not deployable.
- **Preferred Tokovoucher names:** `TOKOVOUCHER_MEMBER_CODE`, `TOKOVOUCHER_SECRET` (use these cross-service).
- **Node compatibility aliases only:** `TOKOVOUCHER_USERNAME`, `TOKOVOUCHER_API_KEY` may still be documented for Node where supported; this guide does not change runtime credential resolution.
- **Scheduler:** `DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN` for the external callback-retry scheduler.
- **Telemetry:** OpenTelemetry/Jaeger variables are optional; see [OPENTELEMETRY_JAEGER.md](OPENTELEMETRY_JAEGER.md).
- **Session lifecycle rollout:** detailed gates and rollback in [SESSION_LIFECYCLE_ROLLOUT.md](SESSION_LIFECYCLE_ROLLOUT.md).

### Backend (`server/.env`)

Safe production-shaped placeholders (replace every `replace-with-*` value offline):

```dotenv
HOST=127.0.0.1
PORT=9005
NODE_ENV=production
PUBLIC_APP_URL=https://app.example.invalid
MONGO_URI=mongodb://db.example.invalid:27017/replace_database
JWT_SECRET=replace-with-generated-secret-at-least-32-characters
API_V2_UPSTREAM_URL=http://127.0.0.1:9010
API_V2_PROXY_SECRET=replace-with-generated-proxy-secret-at-least-32-characters
SESSION_REFRESH_ENABLED=false
SESSION_REFRESH_MEMBER_COHORT_PERCENT=0
SESSION_REFRESH_CS_COHORT_PERCENT=0
SESSION_REFRESH_ADMIN_COHORT_PERCENT=0
SESSION_REFRESH_OWNER_COHORT_PERCENT=0
LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL=replace-with-approved-iso-8601-cutoff
UPLOAD_DIR=/srv/webtopup/uploads
PROVIDER_MODE=live
```

Optional Node-only / feature-specific (not shared session crypto):

- `MONGO_TRANSACTIONS_ENABLED` for legacy webhook transaction behavior only (see Mongo transactions table above).
- Scheduler token: `DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN`.
- Optional provider credentials and telemetry variables listed in `server/.env.example`.

Do **not** put `SESSION_TOKEN_HASH_SECRET`, `SESSION_ROTATION_*`, or `SESSION_RECOVERY_ENCRYPTION_*` in Node env; those are Rust-only today.

Production providers require explicit approval and real credentials stored only in ignored env files.

### API v2 (`rust-api/.env`)

API v2 is a Rust service that runs beside the Node backend. Node remains the public gateway for `/api/v2/*`.

```dotenv
API_V2_HOST=127.0.0.1
API_V2_PORT=9010
API_V2_ALLOWED_ORIGIN=https://app.example.invalid
API_V2_PROXY_SECRET=<same-as-node>
JWT_SECRET=<same-as-node>
SESSION_TOKEN_HASH_SECRET=replace-with-independent-generated-secret
MONGO_URI=<same-logical-database-as-node>
MONGO_DB=replace_database
MONGO_TRANSACTIONS_ENABLED=true
UPLOAD_DIR=/srv/webtopup/uploads
```

Include the same session rollout values as Node:

```dotenv
SESSION_REFRESH_ENABLED=false
SESSION_REFRESH_MEMBER_COHORT_PERCENT=0
SESSION_REFRESH_CS_COHORT_PERCENT=0
SESSION_REFRESH_ADMIN_COHORT_PERCENT=0
SESSION_REFRESH_OWNER_COHORT_PERCENT=0
LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL=replace-with-approved-iso-8601-cutoff
```

Rust-only rotation and recovery key rings (base64url without padding; exactly 32 decoded bytes per key material). Do not copy these into Node:

```dotenv
SESSION_ROTATION_ACTIVE_KEY_ID=rotation-v1
SESSION_ROTATION_KEYS=rotation-v1:replace-with-base64url-no-pad-32-byte-key
SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID=recovery-aead-v1
SESSION_RECOVERY_ENCRYPTION_KEYS=recovery-aead-v1:replace-with-base64url-no-pad-32-byte-key
```

`SESSION_TOKEN_HASH_SECRET`, `SESSION_ROTATION_KEYS`, and `SESSION_RECOVERY_ENCRYPTION_KEYS` are **Rust-only**. The two key rings are distinct from each other and must not reuse JWT or session-hash material.

Preferred Tokovoucher names on Rust (and preferred cross-service names overall):

```dotenv
TOKOVOUCHER_MEMBER_CODE=replace-with-approved-member-code
TOKOVOUCHER_SECRET=replace-with-approved-secret
```

Node may still accept compatibility aliases `TOKOVOUCHER_USERNAME` / `TOKOVOUCHER_API_KEY` where supported; document aliases only—do not change runtime resolution in this hygiene pass.

Optional Digiflazz credentials and OpenTelemetry settings come from `rust-api/.env.example`.

Keep API v2 bound to `127.0.0.1:9010` unless there is a specific isolation design that still keeps it private.

### Frontend (`client/.env.production`)

**Preferred default: same-origin frontend API.** Use `client/.env.example` as the source of truth:

```dotenv
VITE_API_V2_URL=/api/v2
VITE_ASSET_BASE_URL=
```

With Nginx proxying `/api/v2` and `/uploads` from the frontend origin to the Node gateway, leave `VITE_ASSET_BASE_URL` empty so uploaded assets stay same-origin.

`VITE_API_URL` is legacy-only and should not be the preferred production setting.

#### Optional alternative: separate API host

Only if you intentionally serve the API on another public host, set absolute URLs and adjust CORS/origin settings accordingly:

```dotenv
VITE_API_V2_URL=https://api.example.invalid/api/v2
VITE_ASSET_BASE_URL=https://api.example.invalid
```

## 3. Build and ordered deployment steps

Do **not** run staging mutation/provider smoke automatically as part of production deploy instructions.

1. Install dependencies:

```bash
npm run install:all
```

2. Run static checks and JS builds from repo root:

```bash
npm run api-v2:check
npm run build
```

3. Build Rust release binary:

```bash
cd rust-api && cargo build --release
```

4. Ensure the shared upload directory exists with least-required ownership/permissions (example path):

```bash
mkdir -p /srv/webtopup/uploads
# chown/chmod to the service user only as required by your host policy
```

5. Start order:

   1. Dependencies / MongoDB (and any approved provider stubs only in non-prod)
   2. Private Rust API v2
   3. Node gateway
   4. Frontend static assets / Nginx public edge

6. Use **stable PM2 process names** so update and rollback target the same units, for example:

```bash
cd rust-api
pm2 start ./target/release/webtopup-rust-api --name "pobb-api-v2"
pm2 save

cd ../server
pm2 start dist/index.js --name "pobb-api"
pm2 save
pm2 startup
```

Public clients should use Node gateway paths under `/api/v2/*`.

## 4. Configure Nginx

**Default topology: same-origin frontend.** The browser talks only to the app origin; Nginx proxies API and uploads to the private Node gateway.

Create a new Nginx configuration file: `/etc/nginx/sites-available/pobb`

```nginx
# Frontend origin (app.example.invalid) — preferred same-origin layout
server {
    server_name app.example.invalid;
    root /path/to/your/project/client/dist;
    index index.html;

    location /api/v2/ {
        proxy_pass http://127.0.0.1:9005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:9005;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Optional alternative: a separate public API host. Use only when you also set absolute `VITE_API_V2_URL` / `VITE_ASSET_BASE_URL` and matching CORS origins:

```nginx
# Optional API host (api.example.invalid)
server {
    server_name api.example.invalid;

    location / {
        proxy_pass http://127.0.0.1:9005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable the site and restart Nginx (after replacing `.invalid` hosts):

```bash
ln -s /etc/nginx/sites-available/pobb /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

## 5. SSL (HTTPS)

Install Certbot and obtain certificates **only after replacing `.invalid` placeholders with real hostnames**:

```bash
apt install certbot python3-certbot-nginx
# Same-origin default: frontend origin only
certbot --nginx -d app.example.invalid
# Optional if you also expose a separate API host:
# certbot --nginx -d app.example.invalid -d api.example.invalid
```

## 6. Health and security verification

Replace every `.invalid` host before running public curl examples.

Run private and public health checks (same-origin default):

```bash
curl -fsS http://127.0.0.1:9010/health
curl -fsS http://127.0.0.1:9005/api/v2/health
curl -fsS https://app.example.invalid/api/v2/health
curl -i http://127.0.0.1:9010/v2/system/status
```

If you opted into a separate API host, also check `https://api.example.invalid/api/v2/health`.

The final direct protected request should reject missing proxy context when `API_V2_PROXY_SECRET` protection is configured (typically `403` with `API v2 proxy access required`).

Also verify in a browser:

1. Visit the public frontend origin.
2. Confirm API calls use same-origin `/api/v2` (preferred) or the configured `VITE_API_V2_URL`.
3. Confirm uploaded-asset requests stay same-origin via `/uploads` (empty `VITE_ASSET_BASE_URL`) or the optional absolute asset base.
4. Login/register against a non-production fixture first when validating a new host.

Optional authenticated gateway check after operator JWT is available:

```bash
curl -fsS https://app.example.invalid/api/v2/system/status \
  -H "Authorization: Bearer replace-with-operator-jwt"
```

## 7. Update procedure

```text
record current revision
  -> back up env/process config and database as appropriate
  -> fetch/checkout approved revision
  -> install/build/check
  -> restart Rust then Node
  -> verify health and critical read-only flow
```

Example command sequence (adjust remote/branch names to your release process):

```bash
git rev-parse HEAD > /var/backups/webtopup/last-good-revision.txt
# backup ignored env files and PM2 ecosystem/process dump out of band
git fetch origin
git checkout <approved-revision>
npm run install:all
npm run api-v2:check
npm run build
(cd rust-api && cargo build --release)
pm2 restart pobb-api-v2
pm2 restart pobb-api
curl -fsS http://127.0.0.1:9010/health
curl -fsS http://127.0.0.1:9005/api/v2/health
```

**Never** overwrite ignored `.env` files or the shared uploads directory while updating source trees.

## 8. Rollback procedure

```text
checkout recorded known-good revision
  -> restore compatible process/env configuration if changed
  -> rebuild
  -> restart Rust then Node
  -> verify health
  -> restore database only when an explicitly reviewed migration requires it
```

```bash
git checkout "$(cat /var/backups/webtopup/last-good-revision.txt)"
# restore env/process config only if the failed revision changed them
npm run install:all
npm run build
(cd rust-api && cargo build --release)
pm2 restart pobb-api-v2
pm2 restart pobb-api
curl -fsS http://127.0.0.1:9010/health
curl -fsS http://127.0.0.1:9005/api/v2/health
```

Database restore is **not** automatic. Restore dumps only after an explicit review that a migration or data rewrite requires it.

## 9. API v2 Gateway Notes

- Public API v1 remains under `/v1/*` on the Node backend.
- API v1 is deprecated and should be treated as a legacy compatibility layer.
- Public API v2 is served by Node under `/api/v2/*`.
- Internal Rust API v2 routes use `/v2/*` on port `9010`.
- Public health checks:
  - `GET /api/v2/health`
  - `GET /api/v2/ping`
- Public read-only API v2 routes currently include:
  - `GET /api/v2/articles`
  - `GET /api/v2/articles/{slug}`
  - `GET /api/v2/categories`
  - `GET /api/v2/categories/{id}`
  - `GET /api/v2/flash-sales/active`
  - `GET /api/v2/flash-sales/price/{productId}`
  - `GET /api/v2/guest-transactions/check/{invoiceNumber}`
  - `GET /api/v2/leaderboard`
  - `GET /api/v2/operators`
  - `GET /api/v2/operators/{id}`
  - `GET /api/v2/payment-categories`
  - `GET /api/v2/payment-methods`
  - `GET /api/v2/products`
  - `GET /api/v2/products/{id}`
  - `GET /api/v2/product-types`
  - `GET /api/v2/product-types/{id}`
  - `GET /api/v2/rewards`
  - `GET /api/v2/rewards/{id}`
  - `GET /api/v2/settings/public`
  - `GET /api/v2/sliders`
- Protected API v2 routes currently include:
  - `POST /api/v2/auth/login`
  - `POST /api/v2/auth/register`
  - `GET /api/v2/auth/me`
  - `GET /api/v2/auth/2fa/status`
  - `GET /api/v2/api/key`
  - `GET /api/v2/api/profile`
  - `GET /api/v2/api/products`
  - `GET /api/v2/api/transaction/check`
  - `GET /api/v2/api/transactions`
  - `GET /api/v2/system/status`
  - `GET /api/v2/audit-logs`
  - `GET /api/v2/dashboard/ops-snapshot`
  - `GET /api/v2/categories/admin/all`
  - `GET /api/v2/deposits/admin/list`
  - `GET /api/v2/deposits/admin/all`
  - `GET /api/v2/deposits/queue-snapshot`
  - `GET /api/v2/deposits`
  - `GET /api/v2/digiflazz-seller/logs`
  - `GET /api/v2/digiflazz-seller/mappings`
  - `GET /api/v2/digiflazz-seller/orders`
  - `GET /api/v2/digiflazz-seller/orders/process-callback-retries/scheduler/config`
  - `GET /api/v2/digiflazz-seller/settings`
  - `GET /api/v2/flash-sales/admin/all`
  - `GET /api/v2/flash-sales/admin/{id}`
  - `GET /api/v2/margins`
  - `GET /api/v2/notifications/admin`
  - `GET /api/v2/notifications/admin/summary`
  - `GET /api/v2/operators/admin/all`
  - `GET /api/v2/operators/admin/{id}`
  - `GET /api/v2/payment-categories/active`
  - `GET /api/v2/payment-categories/admin/all`
  - `GET /api/v2/payment-methods/active`
  - `GET /api/v2/payment-methods/admin/all`
  - `GET /api/v2/products/admin/all`
  - `GET /api/v2/products/admin/catalog-audit`
  - `GET /api/v2/products/admin/sorting`
  - `GET /api/v2/product-types/admin/all`
  - `GET /api/v2/product-types/admin/{id}`
  - `GET /api/v2/points/settings`
  - `GET /api/v2/points/stats`
  - `GET /api/v2/points/history`
  - `GET /api/v2/points/transactions`
  - `GET /api/v2/reports/sales`
  - `GET /api/v2/reports/sales/summary`
  - `GET /api/v2/reports/dashboard`
  - `GET /api/v2/rewards`
  - `GET /api/v2/rewards/{id}`
  - `GET /api/v2/rewards/admin/all`
  - `GET /api/v2/settings/admin/all`
  - `GET /api/v2/settings/admin/{key}`
  - `GET /api/v2/sliders/admin/all`
  - `GET /api/v2/teams`
  - `GET /api/v2/teams/admin/audit-logs`
  - `GET /api/v2/teams/admin/list`
  - `GET /api/v2/teams/audit-logs`
  - `GET /api/v2/teams/login-logs/all`
  - `GET /api/v2/teams/{id}`
  - `GET /api/v2/teams/{id}/login-logs`
  - `GET /api/v2/guest-transactions`
  - `GET /api/v2/transactions/admin`
  - `GET /api/v2/transactions/admin/stuck`
  - `GET /api/v2/transactions/manual`
  - `GET /api/v2/transactions/stuck`
  - `GET /api/v2/transactions`
  - `GET /api/v2/upload/list`
  - `GET /api/v2/users`
  - `GET /api/v2/users/admin/list`
  - `GET /api/v2/users/me/balance-history`
  - `GET /api/v2/users/me/login-activity`
  - `GET /api/v2/users/me/preferences`
  - `GET /api/v2/users/me/profile`
  - `GET /api/v2/users/{id}`
  - `GET /api/v2/users/{id}/balance-adjustments`
  - `GET /api/v2/vendors`
  - `GET /api/v2/vendors/admin/all`
  - `GET /api/v2/vendors/{id}`
  - `GET /api/v2/vendors/digiflazz/balance`
  - `GET /api/v2/vendors/digiflazz/pricelist`
  - `GET /api/v2/vendors/digiflazz/settings`
  - `GET /api/v2/vendors/health-snapshot`
  - `GET /api/v2/vendors/{id}/stats`
  - `GET /api/v2/vendors/tokovoucher/balance`
  - `GET /api/v2/vendors/tokovoucher/settings`
  - `GET /api/v2/vouchers`
  - `GET /api/v2/webhook/digiflazz/config`
  - `GET /api/v2/webhook/digiflazz/logs`
  - `GET /api/v2/webhook/tokovoucher/config`
  - `GET /api/v2/webhook/tokovoucher/logs`

## 10. API v1 Deprecation Notes

API v1 remains available for legacy consumers during the migration window. Responses under `/v1/*` include deprecation headers:

```text
Deprecation: true
Sunset: <configured sunset date>
Link: </api/v2>; rel="successor-version"
```

Monitor backend logs for `/v1` usage before removing legacy routes or external callback URLs.

## 11. Digiflazz Seller Callback Retry Scheduler

The Digiflazz Seller callback retry queue is processed by an external scheduler. Configure `DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN` in `server/.env`, then call the scheduler endpoint every 1-5 minutes.

Prefer on-host loopback to the Node gateway (legacy `/v1` path is not part of the same-origin `/api/v2` frontend proxy):

```bash
curl -X POST "http://127.0.0.1:9005/v1/digiflazz-seller/orders/process-callback-retries/scheduler" \
  -H "Content-Type: application/json" \
  -H "X-Scheduler-Token: replace-with-scheduler-token" \
  -d '{"limit":20}'
```

Example crontab entry:

```cron
*/2 * * * * curl -fsS -X POST "http://127.0.0.1:9005/v1/digiflazz-seller/orders/process-callback-retries/scheduler" -H "Content-Type: application/json" -H "X-Scheduler-Token: replace-with-scheduler-token" -d '{"limit":20}' >/dev/null
```

If you intentionally expose a separate API host, you may point the scheduler at that public Node URL instead—after replacing every `.invalid` placeholder.

The admin UI endpoint remains available for manual processing and still requires an authenticated admin with `manageVendors` permission.
