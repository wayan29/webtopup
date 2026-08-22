# GitHub Setup

Gunakan panduan ini saat menyiapkan repository baru atau saat repo akan dipublikasikan.

## Langkah Awal

1. Pastikan repo sudah rapi:
   - source di `client/`, `server/`, dan `rust-api/`
   - docs di `docs/`
   - scripts di `scripts/`
2. Pastikan file sensitif tidak ikut:
   - `server/.env`
   - `node_modules/`
   - `dist/`
   - logs dan file sementara
3. Jalankan setup git lokal:

```bash
npm run github:setup
```

## Repository Target

- default branch: `main`
- remote repository: sesuaikan URL GitHub Anda

## Sebelum Push

- review `git status`
- cek commit message mengikuti [CONTRIBUTING.md](../../CONTRIBUTING.md)
- update docs bila struktur/folder berubah
- jalankan build yang relevan

## Dokumen Terkait

- [READY_TO_UPLOAD.md](READY_TO_UPLOAD.md)
- [UPLOAD_GUIDE.md](UPLOAD_GUIDE.md)
- [CLEAN-UPLOAD.md](CLEAN-UPLOAD.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
