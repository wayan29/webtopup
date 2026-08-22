# Project Structure

```text
webtopup/
├── README.md
├── CONTRIBUTING.md
├── .gitignore
├── package.json
├── Makefile
├── Caddyfile
├── compose.dev-verification.yml
├── playwright.config.ts
├── client/
├── server/
├── rust-api/
├── infra/
├── tests/
│   └── e2e/
├── tools/
│   └── dev-verification/
├── docs/
│   ├── README.md
│   ├── deployment/
│   ├── github/
│   ├── ops/
│   ├── project/
│   ├── superpowers/          # gitignored; local design/plan history
│   │   ├── specs/
│   │   └── plans/
│   └── assets/screenshots/
└── scripts/
    ├── dev/
    ├── github/
    ├── ops/
    ├── security/
    └── smoke/
```

Generated local artifacts are intentionally excluded from this map: `.pi/`, `.pi-subagents/`, `.superpowers/`, `graphify-out/`, worktrees, `logs/`, `uploads/`, `client/dist/`, `target/`, `node_modules/`, test results, ignored real env files, and similar runtime/output paths.

## Root

- `README.md`: ringkasan repo dan quick start
- `CONTRIBUTING.md`: aturan branch, commit, PR, dan hygiene repo
- `package.json`: script root untuk install/dev/build, API v2 smoke, staging, E2E, dan helper GitHub
- `Makefile`: target verifikasi lokal (`dev-verify`, Rust/Node/client checks)
- `Caddyfile`: reverse proxy production
- `compose.dev-verification.yml`: stack verifikasi terisolasi
- `playwright.config.ts`: E2E root; verifikasi lokal memakai config di `tools/dev-verification/`

## Frontend

`client/` adalah aplikasi Vite + React + TypeScript (publik, member, admin). Env template kanonik: `client/.env.example`.

`client/src/`

- `api/`: client API wrapper
- `auth/`: session, step-up, idle lock, coordinator
- `components/`: reusable UI (`admin/`, `auth/`, `home/`, `public/`)
- `layouts/`: layout publik dan admin
- `pages/`: halaman publik, member, dan admin
- `store/`: Zustand store
- `lib/`: helper domain (nav, slider, vendor health, seller center)
- `utils/`: helper UI/format
- `assets/`: aset frontend

Tes unit frontend di-colocate sebagai `*.test.ts` di samping helper yang diuji.

## Node gateway

`server/` adalah Fastify/TypeScript gateway: proxy API v2 ke Rust, leftover API v1, upload, cookie/session edge, dan adapter vendor. Env template kanonik: `server/.env.example`.

`server/src/`

- `config/`: koneksi dan konfigurasi server
- `controllers/`: handler request Node
- `middlewares/`: auth, rate limit, step-up, permission
- `models/`: schema Mongoose
- `repositories/`: akses data Node yang masih dipakai
- `routes/`: routing Fastify, termasuk proxy `/api/v2/*`
- `services/`: business/service layer Node
- `utils/`: helper runtime/backend
- `vendors/`: adapter vendor eksternal
- `scripts/`: seed dan utilitas backend

Controller/route seller Node yang tidak terdaftar di `app.ts` bukan API hidup. Path seller aktif: Node gateway → Rust.

## API v2 Rust

`rust-api/` adalah crate Axum tunggal di belakang Node gateway. Env template kanonik: `rust-api/.env.example`.

Public client tidak memanggil Rust langsung. Request frontend masuk ke Node `/api/v2/*`, lalu Node meneruskan ke Rust `/v2/*` dengan proxy context.

`rust-api/src/`

- `main.rs`: entry point HTTP
- `lib.rs`: seam publik terbatas untuk binary/operator
- `routes/`: handler API v2 per domain (`auth`, `content`, `digiflazz_seller`, `irs_seller`, `vendors`, …)
- `services/`: helper business, integrity, secrecy, provider
- `utils/`: helper BSON/tanggal
- `bin/`: operator binaries (readiness, integrity)
- `state.rs`: konfigurasi runtime dan shared application state
- `security.rs` / `security_hardening_checks.rs`: auth/proxy/hardening
- `telemetry.rs`: tracing/metrics

Tes Rust utama ada di dalam crate (`cargo test`), bukan di `rust-api/tests/`.

## Docs

- `docs/deployment/`: deployment production, staging verification, OpenTelemetry/Jaeger, session lifecycle
- `docs/github/`: setup repo, upload, checklist GitHub, catatan upload ulang
- `docs/ops/`: runbook operasional (backup/restore, seller hygiene, product-id integrity)
- `docs/project/`: struktur repo, audit migrasi, review endpoint, provider rollout, dan dry-run checklist
- `docs/superpowers/`: approved specs and implementation plans (gitignored; design/plan history, bukan runtime docs)
- `docs/assets/screenshots/`: screenshot referensi

## Scripts, infra, and verification

- `scripts/dev/`: local provider validation sandbox
- `scripts/github/`: bootstrap git lokal dan helper upload
- `scripts/ops/`: backup Mongo, uji restore, status report
- `scripts/security/`: policy/scrub secret
- `scripts/smoke/`: API v2 read/mutation/provider/staging checks
- `infra/dev-verification/`: Caddy/config stack verifikasi
- `tools/dev-verification/`: isolated local verification stack
- `tests/e2e/`: Playwright specs yang dijalankan dari root

## Rule Rapih Repo

- file source tetap di `client/`, `server/`, dan `rust-api/`
- dokumentasi tidak ditaruh di root selain `README.md` dan `CONTRIBUTING.md`
- script bantu tidak ditaruh di root
- screenshot tidak ditaruh di root
- real env files, uploads, agent reports, dan correlation sandboxes di-ignore, bukan dijadikan source tree
