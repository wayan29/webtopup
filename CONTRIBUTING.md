# Contributing Guide

## Branch Rule

- Gunakan branch terpisah untuk setiap pekerjaan.
- Format yang disarankan: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>`.
- Jangan kerja langsung di `main` untuk perubahan besar.

## Commit Rule

- Pakai commit message ringkas dan konsisten.
- Format yang disarankan:

```text
type(scope): summary
```

Contoh:

- `feat(public-home): add article deep links`
- `fix(admin-rewards): harden redeem flow`
- `docs(repo): reorganize root documentation`

Tipe yang dipakai:

- `feat`: fitur baru
- `fix`: perbaikan bug
- `refactor`: rapikan kode tanpa ubah perilaku
- `docs`: perubahan dokumentasi
- `chore`: maintenance repo, struktur, tooling
- `test`: perubahan test

## Pull Request Rule

- Satu PR untuk satu fokus perubahan.
- Jelaskan scope, risiko, dan cara verifikasi.
- Sertakan screenshot jika ada perubahan UI.
- Sebelum PR:
  - jalankan build yang relevan
  - cek tidak ada `.env`, `dist`, atau file eksperimen ikut terbawa
  - update docs jika struktur/path berubah

## GitHub Update Flow

1. Sync branch terbaru.
2. Kerjakan perubahan per scope.
3. Jalankan verifikasi lokal.
4. Commit dengan format di atas.
5. Push branch.
6. Buka PR dengan ringkasan singkat dan checklist.

## File Hygiene

- Dokumen masuk ke `docs/`
- Script bantu masuk ke `scripts/`
- Screenshot masuk ke `docs/assets/screenshots/`
- Jangan simpan screenshot atau file sementara di root repo

## Sensitive Files

- Jangan commit `server/.env`
- Jangan commit build output atau dependency folders
- Jangan commit credential, token, atau data produksi
