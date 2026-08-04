# Project Structure

```text
/home/home/web
├── README.md
├── CONTRIBUTING.md
├── .gitignore
├── package.json
├── client/
├── server/
├── rust-api/
├── tools/
│   └── dev-verification/
├── docs/
│   ├── README.md
│   ├── ai/
│   ├── deployment/
│   ├── github/
│   ├── operations/
│   ├── project/
│   ├── superpowers/
│   │   ├── specs/
│   │   └── plans/
│   └── assets/screenshots/
└── scripts/
    ├── dev/
    ├── smoke/
    └── github/
```

Generated local artifacts are intentionally excluded from this map: `.pi-subagents/`, `.pi-task-reports/`, worktrees, test results, uploads, ignored real env files, and similar runtime/output paths.

## Root

- `README.md`: ringkasan repo dan quick start
- `CONTRIBUTING.md`: aturan branch, commit, PR, dan hygiene repo
- `package.json`: script root untuk dev/build, API v2 smoke, staging verification, sandbox, E2E, dan helper GitHub

## Frontend

`client/src/`

- `api/`: client API wrapper
- `components/`: reusable UI components
- `layouts/`: layout aplikasi
- `pages/`: halaman publik, member, dan admin
- `store/`: Zustand store
- `lib/`: helper utilitas frontend

Canonical frontend env template: `client/.env.example`.

## Backend

`server/src/`

- `config/`: koneksi dan konfigurasi server
- `controllers/`: handler request
- `middlewares/`: auth dan guard permission
- `models/`: schema Mongoose
- `routes/`: routing API
- `services/`: business/service layer
- `utils/`: helper runtime/backend
- `vendors/`: adapter vendor eksternal
- `scripts/`: seed dan utilitas backend

## API v2 Rust

`rust-api/src/`

- `routes/`: handler API v2 internal di bawah `/v2/*`
- `middleware/`: proxy context, auth, dan guard request protected
- `models/`: struktur data MongoDB dan response API v2
- `services/`: helper business/provider/API logic
- `state.rs`: konfigurasi runtime dan shared application state

Public client tidak memanggil Rust API langsung. Request frontend masuk ke Node gateway `/api/v2/*`, lalu Node meneruskan ke Rust `/v2/*` dengan proxy context.

## Docs

- `docs/ai/`: catatan agent/skill internal repo
- `docs/deployment/`: deployment production, staging verification, OpenTelemetry/Jaeger, session lifecycle rollout
- `docs/github/`: setup repo, upload, checklist GitHub
- `docs/operations/`: operational integrity/runbook material
- `docs/project/`: struktur repo, audit migrasi, review endpoint, provider rollout, dan dry-run checklist
- `docs/superpowers/`: approved specs and implementation plans (design/plan history, not runtime docs)
- `docs/assets/screenshots/`: screenshot referensi

## Scripts and verification tools

- `scripts/dev/`: local provider validation sandbox and tests
- `scripts/smoke/`: API v2 read/mutation/provider/staging checks, sandbox stub, API v1 reports
- `scripts/github/setup-git.sh`: bootstrap config git lokal
- `scripts/github/upload-to-github.sh`: helper upload repo ke GitHub
- `tools/dev-verification/`: isolated local verification stack lifecycle

## Rule Rapih Repo

- file source tetap di `client/`, `server/`, dan `rust-api/`
- dokumentasi tidak ditaruh lagi di root selain `README.md` dan `CONTRIBUTING.md`
- script bantu tidak ditaruh lagi di root
- screenshot tidak ditaruh lagi di root
- real env files, uploads, agent reports, dan correlation sandboxes di-ignore, bukan dijadikan source tree
