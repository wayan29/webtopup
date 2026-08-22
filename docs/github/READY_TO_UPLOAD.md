# Ready To Upload Checklist

## Security

- [ ] `server/.env` tidak ikut
- [ ] `node_modules/` tidak ikut
- [ ] `dist/` tidak ikut
- [ ] tidak ada token, secret, atau data produksi

## Repo Hygiene

- [ ] file non-source sudah ada di folder yang tepat
- [ ] screenshot ada di `docs/assets/screenshots/`
- [ ] script bantu ada di `scripts/`
- [ ] docs yang berubah sudah diupdate

## Verification

- [ ] `npm run build` di root bila perlu
- [ ] `npm run build` di `client`
- [ ] `npm run build` di `server`

## GitHub Update

- [ ] branch sudah benar
- [ ] commit message sesuai format
- [ ] PR description siap
- [ ] checklist PR sudah diisi

Upload guide detail ada di [UPLOAD_GUIDE.md](UPLOAD_GUIDE.md). Catatan snapshot/upload ulang ada di [CLEAN-UPLOAD.md](CLEAN-UPLOAD.md).
