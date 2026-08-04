# PPOB Fullstack Application

[![API v2 build check](https://github.com/wayan29/webtopup/actions/workflows/api-v2-build-check.yml/badge.svg)](https://github.com/wayan29/webtopup/actions/workflows/api-v2-build-check.yml)
[![API v2 runtime smoke](https://github.com/wayan29/webtopup/actions/workflows/api-v2-runtime-smoke.yml/badge.svg)](https://github.com/wayan29/webtopup/actions/workflows/api-v2-runtime-smoke.yml)

Monorepo untuk platform PPOB dengan frontend React + Vite, Node/Fastify gateway, MongoDB, dan Rust API v2.

Arsitektur utama saat ini:

```text
Frontend
  -> Node gateway /api/v2/*
     -> Rust API /v2/*
     -> MongoDB
     -> provider sandbox/live
```

API v1 Node masih tersedia sebagai legacy compatibility layer, tetapi sudah deprecated. Frontend internal menggunakan API v2 lewat Node gateway.

## Struktur Singkat

- `client/`: aplikasi frontend publik, member, dan admin
- `server/`: Node/Fastify gateway, API v1 legacy, proxy API v2, model, vendor adapter, dan script backend
- `rust-api/`: service Rust API v2 yang berjalan di belakang Node gateway
- `docs/`: dokumentasi deployment, API v2, GitHub, struktur project, dan screenshot
- `scripts/`: smoke test, staging verification, provider sandbox stub, dan helper GitHub
- `tools/dev-verification/`: stack verifikasi lokal terisolasi

Detail struktur terbaru ada di [PROJECT_STRUCTURE.md](docs/project/PROJECT_STRUCTURE.md).

## Prerequisites

Pastikan dependency berikut tersedia sebelum menjalankan project lokal:

- Node.js `^20.19.0` atau `>=22.12.0` (Vite 7). Disarankan current supported LTS yang memenuhi rentang itu (Node 22 LTS, atau Node 20.19+)
- npm
- Rust toolchain (`cargo` dan `rustup`)
- MongoDB lokal atau connection string MongoDB yang bisa diakses

Jika Rust belum terpasang, install lewat rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Quick Start

1. Install dependency Node:

```bash
npm run install:all
```

2. Siapkan environment service-local dari template non-secret:

```bash
cp server/.env.example server/.env
cp rust-api/.env.example rust-api/.env
cp client/.env.example client/.env.local
```

Template root `.env.local.example` dan `.env.staging.example` adalah input untuk verification/smoke tooling, **bukan** pengganti `server/.env`, `rust-api/.env`, atau env frontend. Salin template service-local di atas dulu, lalu sesuaikan root verification template hanya saat menjalankan smoke/staging helpers.

### Shared Node/Rust configuration

Nilai berikut harus selaras antara `server/.env` dan `rust-api/.env`:

- **Sama persis di Node dan Rust:** `JWT_SECRET`, `API_V2_PROXY_SECRET`, flag/cohort session rollout (`SESSION_REFRESH_ENABLED`, `SESSION_REFRESH_*_COHORT_PERCENT`, `LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL`), `MONGO_URI`, dan `UPLOAD_DIR`.
- **Database logis yang sama:** `MONGO_DB` jika dikonfigurasi eksplisit (Rust mewajibkannya; Node mengikuti URI/db yang sama).
- **Origin frontend:** `PUBLIC_APP_URL` (Node CORS/public URL) dan `API_V2_ALLOWED_ORIGIN` (Rust) harus mengidentifikasi origin frontend yang sebenarnya.
- **Upstream private:** `API_V2_UPSTREAM_URL` di Node mengarah ke Rust privat (lokal default `http://127.0.0.1:9010`).

### Rust-only session/security settings

Dibaca runtime Rust API v2 saja (jangan dokumentasikan sebagai secret Node yang harus di-duplicate):

- `SESSION_TOKEN_HASH_SECRET`: required Rust; generate independen dan **jangan** reuse `JWT_SECRET`.
- `SESSION_ROTATION_ACTIVE_KEY_ID` / `SESSION_ROTATION_KEYS`: Rust-only rotation key ring.
- `SESSION_RECOVERY_ENCRYPTION_ACTIVE_KEY_ID` / `SESSION_RECOVERY_ENCRYPTION_KEYS`: Rust-only recovery AEAD key ring, terpisah dari rotation ring.

### Mongo transactions

- **Rust / API v2:** `MONGO_TRANSACTIONS_ENABLED` is required for financial mutation paths and defaults to `true` when unset; production should keep `true` on a transaction-capable Mongo deployment (replica set/sharded).
- **Node:** the same variable is only consulted for feature-specific legacy webhook behavior, not as a general shared financial-transaction switch for the whole stack.

`MONGO_URI` adalah nama kanonis. `MONGODB_URI` hanya alias legacy pada script tertentu, bukan preferred runtime variable.

Contoh minimal shared placeholders:

```env
MONGO_URI=mongodb://localhost:27017/POBB
JWT_SECRET=replace-with-the-same-32-plus-character-secret
API_V2_PROXY_SECRET=replace-with-32-plus-random-characters
API_V2_UPSTREAM_URL=http://127.0.0.1:9010
```

Rust-only companion (from `rust-api/.env.example`):

```env
SESSION_TOKEN_HASH_SECRET=replace-with-independent-32-plus-character-secret
MONGO_TRANSACTIONS_ENABLED=true
```

3. Jalankan service lokal di terminal terpisah:

```bash
npm run api-v2:dev
npm run dev:server
npm run dev:client
```

`npm run dev` hanya menjalankan Node gateway dan frontend. Karena project sudah memakai API v2 Rust, tetap jalankan `npm run api-v2:dev` di terminal terpisah.

4. Cek service berhasil jalan:

```bash
curl http://localhost:9010/health
curl http://localhost:9005/api/v2/health
curl http://localhost:9005/api/v2/ping
```

Default local endpoints:

- Frontend: `http://localhost:9006` atau port Vite yang tampil di terminal
- Node gateway: `http://localhost:9005`
- Public API v2 gateway: `http://localhost:9005/api/v2`
- Internal Rust API v2: `http://localhost:9010/v2`

## Script Penting

Command groups yang ada di `package.json` (nama script verbatim):

```text
Development/build: dev, dev:server, dev:client, api-v2:dev, build
Read verification: api-v2:check, api-v2:verify:local, api-v2:verify:local:read:guarded
Mutation/provider: api-v2:verify:local:mutations, api-v2:verify:local:full, api-v2:smoke:providers, api-v2:dry-run:transaction-create
Staging: staging:check, staging:smoke, staging:smoke:mutations, staging:smoke:providers, staging:dry-run:transaction-create
Sandbox/dev verification: dev:provider-sandbox, test:provider-sandbox, dev-verify:setup, dev-verify:up, dev-verify:test, dev-verify:down
Compatibility/release: api-v1:removal-readiness, api-v1:usage-report
Browser E2E: test:e2e, test:e2e:headed, test:e2e:ui
```

Mutation, provider, dan transaction dry-run smoke test memakai guard environment supaya tidak sengaja mengubah saldo atau memanggil provider live. Jangan anggap command mutation/provider aman tanpa guard yang didokumentasikan. Mutation verify lokal wajib memakai Mongo fixture agar e2e yang Mongo-backed tidak ter-skip diam-diam:

```bash
MONGO_URI="mongodb://user:pass@localhost:27017/POBB" MONGO_DB=POBB npm run api-v2:verify:local:mutations
```

Untuk menjalankan verifikasi lokal penuh setelah service Node/Rust berjalan, gunakan:

```bash
MONGO_URI="mongodb://user:pass@localhost:27017/POBB" MONGO_DB=POBB npm run api-v2:verify:local:full
```

Lihat dokumentasi API v2 di `docs/project/` dan `docs/deployment/` sebelum menjalankan smoke yang bersifat write/provider-backed.

Tracing request API v2 dengan OpenTelemetry + Jaeger ada di [OPENTELEMETRY_JAEGER.md](docs/deployment/OPENTELEMETRY_JAEGER.md).

Sebelum release besar, ikuti [API_V2_RELEASE_GATE.md](docs/project/API_V2_RELEASE_GATE.md). Workflow `API v2 mutation smoke` bersifat manual-only dan sebaiknya dijalankan sebelum perubahan route/security/financial dipromosikan.

### Matrix Verifikasi Lokal

| Command | Butuh service | Butuh Mongo env | Efek |
| --- | --- | --- | --- |
| `npm run api-v2:check` | tidak | tidak | Rust format check dan compile check |
| `npm run build` | tidak | tidak | build client dan server |
| `npm run api-v2:smoke` | Node `9005` | tidak | read-only smoke lewat gateway; direct Rust guard di-skip jika `API_V2_DIRECT_URL` unset |
| `npm run api-v2:smoke:guards` | Node `9005`, Rust `9010` | tidak | read-only smoke plus direct Rust proxy guard checks |
| `npm run api-v2:verify:local` | Node `9005` | tidak | `api-v2:check`, `git diff --check`, build, read smoke |
| `npm run api-v2:verify:local:read:guarded` | Node `9005`, Rust `9010` | tidak | full read verification plus direct Rust proxy guard checks |
| `npm run api-v2:verify:local:mutations` | Node `9005`, Rust `9010` | ya | guarded mutation smoke dengan fixture restore |
| `npm run api-v2:verify:local:full` | Node `9005`, Rust `9010` | ya | read verify plus guarded mutation smoke |

Gunakan `api-v2:verify:local:read:guarded` saat ingin memastikan endpoint admin/read-only tetap tidak bisa diakses langsung ke Rust tanpa proxy context dari Node.

## API Notes

- `VITE_API_V2_URL`: preferred public gateway, default `/api/v2`.
- `VITE_ASSET_BASE_URL`: optional explicit uploaded-asset origin/base; biarkan kosong untuk diturunkan dari API URL.
- `VITE_API_URL`: legacy fallback only, dipakai hanya jika variabel yang lebih baru unset.
- Public client tidak langsung memanggil Rust API; semua request masuk lewat Node gateway `/api/v2/*`.
- Rust API protected routes menolak akses langsung tanpa proxy context/secret dari Node.
- API v1 legacy berada di `/v1/*` dan mengirim deprecation headers.
- Public provider callback v2 tersedia di `/api/v2/webhook/digiflazz` dan `/api/v2/webhook/tokovoucher`.

## Workflow Repo

Aturan commit, branch, dan update GitHub sekarang dipusatkan di:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [GITHUB_SETUP.md](docs/github/GITHUB_SETUP.md)
- [UPLOAD_GUIDE.md](docs/github/UPLOAD_GUIDE.md)

Ringkasnya:

- pakai branch terpisah untuk pekerjaan baru
- gunakan commit message yang konsisten
- jangan commit `.env`, build output, atau file eksperimen
- screenshot dan artefak non-source simpan di `docs/assets/screenshots/`

## Dokumentasi

Index dokumentasi repo ada di [docs/README.md](docs/README.md).
