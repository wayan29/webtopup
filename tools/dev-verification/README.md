# Local Development Verification Stack

Disposable, loopback-only verification for the current React/Vite, Node, and Rust sources. It uses trusted local HTTPS, mock providers, and a dedicated MongoDB replica-set database named exactly `webtopup_task14_dev`.

A successful run is local evidence only: `LOCAL DEV VERIFIED`. It is never staging or deployment evidence. Shared staging and `DEPLOYMENT VERIFIED` remain pending.

## Prerequisites

- Node 24 and npm dependencies installed for root, `client/`, and `server/`.
- Rust toolchain compatible with `rust-api/Cargo.toml`.
- Docker Engine plus Docker Compose v2.
- `mkcert` and a working NSS/browser trust store.
- Chromium installed by Playwright.

`make dev-verify-setup` installs a local development CA through `mkcert -install`. Trusting that CA affects the current workstation trust store. Generated CA material, certificates, environment files, logs, PIDs, fixture state, and reports remain under ignored `.dev-verification/`.

## Lifecycle

```bash
make dev-verify-down       # safe from partial or stopped state; keeps Mongo volume
make dev-verify-setup      # generate ignored state and trusted local certificate
make dev-verify-up         # start Mongo/Caddy and current-source host processes, rollout disabled
make dev-verify-reset      # guarded destructive reset of webtopup_task14_dev only
make dev-verify-seed       # synthetic .invalid fixtures and mock-provider data
make dev-verify-status     # sanitized source/process/container/topology status
make dev-verify-test       # full aggregate verification and redacted report
npm run dev-verify:login-return-to:list # list the seven canonical Task 4 desktop cases
npm run dev-verify:login-return-to      # fresh disposable stack + fixtures + 7 cases + guaranteed cleanup
npm run dev-verify:public-routes:list   # list canonical desktop/mobile public behavior cases
npm run dev-verify:public-routes        # disposable HTTPS stack + 16 cases + guaranteed cleanup
make dev-verify-down       # stop owned processes and containers, preserve volume
```

Use `make dev-verify-purge` only when the disposable Mongo volume must also be deleted. `down` is intentionally non-destructive.

## Fixed local identity

- Public origin: `https://webtopup.local.test:9443`
- Node: `127.0.0.1:19005`
- Vite: `127.0.0.1:19006`
- Rust: `127.0.0.1:19010`
- Fault proxy: `127.0.0.1:19011`
- Mongo: `127.0.0.1:27018`, replica set `rs0`
- Compose project: `webtopup-task14-dev`
- Database: `webtopup_task14_dev`
- Provider mode: `mock`

Lifecycle and destructive operations fail closed if these identities do not match. No command accepts a database name or Mongo URI as a positional override.

## Results and reports

Allowed aggregate vocabulary:

- `LOCAL DEV VERIFIED`
- `LOCAL DEV FAILED`
- `NOT RUN`
- `NOT APPLICABLE`

Reports are written atomically beneath `.dev-verification/reports/` only after recursive secrecy checks. They must not contain cookie values, authorization headers, passwords, JWTs, refresh/recovery/CSRF/OTP material, secrets, digests, ciphertext, nonces, private keys, grants, or Mongo credentials.

## Troubleshooting

- **Certificate warning:** rerun setup and confirm the generated certificate exists. Chromium tests pin the generated certificate's exact public-key hash with `--ignore-certificate-errors-spki-list`; they never enable a global certificate-error bypass.
- **Port conflict:** run status/down first, then inspect only ports `9443`, `19005`, `19006`, `19010`, `19011`, and `27018`. The lifecycle refuses unowned listeners rather than killing them.
- **Ownership mismatch:** do not delete the process manifest or kill another session. Inspect `.dev-verification/logs/` and stop only the exact owned process tree.
- **Mongo guard rejection:** confirm Compose project, volume, replica set, writable primary, marker, URI, and exact database identity. Never point this stack at shared or production MongoDB.
- **Provider rejection:** generated configuration must specify `PROVIDER_MODE=mock`; outbound mutations are not part of this stack.
- **Failed verification:** inspect sanitized status/reports and per-process logs locally. Do not paste credential-bearing request or response bodies into reports.

## Cleanup and CA removal

Run `make dev-verify-down`; optionally run `make dev-verify-purge`; then remove ignored `.dev-verification/` only when retained local evidence is no longer needed. To revoke the local development CA, use `mkcert -uninstall` and follow the platform/browser trust-store removal instructions printed by mkcert. This may affect other local mkcert certificates on the same workstation.
