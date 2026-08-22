# Upload ulang GitHub (repo bersih)

Dokumen ini adalah catatan snapshot/upload ulang, bukan prosedur harian. Upload biasa tetap lewat [UPLOAD_GUIDE.md](UPLOAD_GUIDE.md).

Folder snapshot yang dirujuk di sini adalah aplikasi **tanpa**:

- history git lama
- `docs/superpowers/`, `.superpowers/`, `docs/ai/`, `skills/`, `CLAUDE.md`
- `node_modules/`, `target/`, `dist/`, artefak agent lokal

Ada **1 commit** atas nama:

`Wayan Danayasa <wayandayan22@gmail.com>`

## Opsi A — ganti repo `wayan29/webtopup` (hapus dulu di GitHub)

1. Di GitHub: **Settings → Delete this repository** untuk `wayan29/webtopup`.
2. Buat repo kosong baru dengan nama yang sama (tanpa README/license/.gitignore).
3. Di server:

```bash
cd /home/danayasa/webtopup-clean
git remote add origin https://github.com/wayan29/webtopup.git
git push -u origin main
```

Kalau pakai SSH:

```bash
git remote add origin git@github.com:wayan29/webtopup.git
git push -u origin main
```

## Opsi B — repo baru (arsipkan yang lama)

1. Buat repo baru, mis. `wayan29/danayasa-webtopup`.
2. Push dari folder ini ke remote baru (sama seperti di atas, ganti URL).
3. Repo lama biarkan private/arsip.

## Catatan server production

- Stack production tetap di `/home/danayasa/proyek/webtopup-test`.
- Source kerja lama dengan history penuh: `/home/danayasa/proyek/webtopup-src`.
- Setelah GitHub diganti, samakan remote di `webtopup-src` hanya jika Anda memang ingin source server ikut remote baru (opsional; bisa dikerjakan terpisah).

## Verifikasi setelah push

- Contributors GitHub: hanya akun Anda.
- Tidak ada path `docs/superpowers`, `CLAUDE.md`, `skills/`, `docs/ai` di branch `main`.
