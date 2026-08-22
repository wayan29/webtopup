# Documentation Index

## Project

- [PROJECT_STRUCTURE.md](project/PROJECT_STRUCTURE.md): peta folder utama repo
- [API_V2_MIGRATION_AUDIT.md](project/API_V2_MIGRATION_AUDIT.md): audit migrasi API v2
- [API_V2_COVERAGE_INVENTORY.md](project/API_V2_COVERAGE_INVENTORY.md): inventory route, auth boundary, dan smoke coverage API v2
- [API_V2_RELEASE_GATE.md](project/API_V2_RELEASE_GATE.md): checklist release gate API v2 lokal, CI, staging, dan v1 removal
- [API_V2_PROVIDER_ROLLOUT_RUNBOOK.md](project/API_V2_PROVIDER_ROLLOUT_RUNBOOK.md): runbook provider sandbox/live rollout
- [API_V2_PROVIDER_SANDBOX_STRATEGY.md](project/API_V2_PROVIDER_SANDBOX_STRATEGY.md): strategi provider sandbox
- [API_V2_TRANSACTION_CREATE_DRY_RUN_CHECKLIST.md](project/API_V2_TRANSACTION_CREATE_DRY_RUN_CHECKLIST.md): checklist dry-run transaksi
- [API_V2_TRANSACTION_CREATE_DRY_RUN_TEMPLATE.md](project/API_V2_TRANSACTION_CREATE_DRY_RUN_TEMPLATE.md): template bukti dry-run transaksi
- [API_V2_TRANSACTION_CREATE_REVIEW.md](project/API_V2_TRANSACTION_CREATE_REVIEW.md): review endpoint create transaction v2

## GitHub & Workflow

- [GITHUB_SETUP.md](github/GITHUB_SETUP.md): setup awal repository GitHub
- [UPLOAD_GUIDE.md](github/UPLOAD_GUIDE.md): langkah upload/publish repository
- [READY_TO_UPLOAD.md](github/READY_TO_UPLOAD.md): checklist sebelum push
- [GIT_SETUP_COMPLETE.md](github/GIT_SETUP_COMPLETE.md): verifikasi cepat setelah setup git
- [CLEAN-UPLOAD.md](github/CLEAN-UPLOAD.md): catatan snapshot/upload ulang GitHub (bukan prosedur harian)
- [CONTRIBUTING.md](../CONTRIBUTING.md): aturan branch, commit, PR, dan update repo


## Deployment

- [DEPLOYMENT.md](deployment/DEPLOYMENT.md): panduan deployment production (env, build/start order, health, update/rollback)
- [API_V2_STAGING_VERIFICATION.md](deployment/API_V2_STAGING_VERIFICATION.md): runbook smoke/staging API v2
- [OPENTELEMETRY_JAEGER.md](deployment/OPENTELEMETRY_JAEGER.md): tracing OpenTelemetry + Jaeger untuk API v2
- [SESSION_LIFECYCLE_ROLLOUT.md](deployment/SESSION_LIFECYCLE_ROLLOUT.md): runbook rollout session refresh/rotation/recovery

## Operations

- [product-id-integrity.md](ops/product-id-integrity.md): integritas product id dan runbook operasional terkait
- [backup-restore-monitoring.md](ops/backup-restore-monitoring.md): backup Mongo, uji restore disposable, dan status report
- [digiflazz-seller-center-hygiene.md](ops/digiflazz-seller-center-hygiene.md): hygiene raw payload Seller Center dan indeks `refId`


## Assets

- `docs/assets/screenshots/`: screenshot review dan referensi visual

## Rule Repo

- Jangan taruh screenshot, script helper, atau dokumen ad-hoc di root repo.
- Dokumen proses masuk ke `docs/`.
- Script operasional masuk ke `scripts/`.
- Artefak lokal ter-generate (tooling agent, uploads, real `.env`) tidak termasuk source project.
