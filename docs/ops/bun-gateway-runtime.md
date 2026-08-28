# Bun Gateway Runtime

The `webtopup-node` gateway (Fastify) runs on **Bun 1.4** instead of Node.js
for the live systemd unit.

## Current state

- Unit file of record: `docs/ops/systemd/webtopup-node.service` (mirror of
  `/etc/systemd/system/webtopup-node.service`).
- `ExecStart=/home/danayasa/.bun/bin/bun dist/index.js`.
- Bun 1.4 pin: `/home/danayasa/.bun/bin/bun` (`bun --version`).

## Why Bun 1.4 (not Node)

Bun 1.4 is the first Bun release with the core rewritten from Zig to Rust
(bun.com/blog/bun-in-rust): fixed memory leaks in `Bun.build`, smaller
binaries, +2–5% faster HTTP throughput including Fastify, and far better
long-term stability via Rust's borrow checker. Measured locally in this repo
before switching:

- Gateway boots against the disposable Mongo `webtopup_task14_dev`, serves
  SPA + CSP + `x-trace-id`, proxies `/api/v2/settings/public`.
- Full auth smoke against live POBB: member login (bcrypt native addon),
  staff login, authenticated profile read + mutation, multipart upload auth
  gate (401 without token, 403 2FA gate with token — no parser crash).
- `bcrypt` native N-API addon loads under Bun and cross-verifies Node-made
  hashes.
- `isolatedModules` is enabled in `server/tsconfig.json` so the value-type
  re-export pattern that Bun rejects fails at `tsc` instead of at runtime.

## Known limitations (accepted)

- `tools/dev-verification` unit/E2E tests stay on Node (`node --import tsx`)
  because `bun test` does not implement nested `node:test` suites.
- Dev scripts (`nodemon`, `ts-node` catalog/admin scripts) stay on Node.
- OTEL is disabled (`OTEL_ENABLED=false`) in prod; if it is re-enabled,
  validate `@opentelemetry/sdk-node` instrumentation under Bun first.

## Rollback to Node

1. In `/etc/systemd/system/webtopup-node.service`, replace the `ExecStart`
   line (a commented Node fallback is documented in the unit file and repo
   copy):

   ```ini
   ExecStart=/home/danayasa/.nvm/versions/node/v26.5.1/bin/node dist/index.js
   ```

2. `sudo systemctl daemon-reload && sudo systemctl restart webtopup-node`.
3. Confirm SPA + `/api/v2/health` return 200.
