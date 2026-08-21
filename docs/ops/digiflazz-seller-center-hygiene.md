# Digiflazz/IRS Seller Hygiene Runbook

Runbook ini mengatur penghapusan historis `rawRequest`/`raw` pada data seller dan
pemasangan index unique `{ refId: 1 }` untuk `digiflazzsellerorders` dan
`irssellerorders`.

## Prinsip

- Default selalu **dry-run**. Tidak ada tulis baru tanpa `--apply`.
- Scrubber Node **tidak pernah** membuat/mengubah index; ia hanya `$unset`
  field raw dan melaporkan jumlah.
- Index dibuat hanya oleh binary `seller_order_readiness --apply`, dan itu
  otomatis hanya untuk database disposable `webtopup_task14_dev`.
- Database protected memerlukan persetujuan eksplisit, `--apply`,
  `--allow-protected-database`, `--confirm-database <nama-persis>`, serta
  `--backup-reference` non-kosong (scrub) — untuk index, lakukan manual via
  mongosh setelah backup dan persetujuan.
- Jangan pernah menempelkan nilai laporan yang mengandung credential ke
  tiket/log. Laporan hanya berisi jumlah dan status.

## Sebelum deploy kode yang menuntut readiness

1. Hentikan bila dry-run menandai `blocking: true`:
   - `duplicateRefIds > 0` → selesaikan duplikasi `refId` secara manual.
   - index `refId` drifted (non-unique/TTL/partial) → drop index drifted
     secara manual, jangan lewati tool.
2. **Jangan** restart/deploy API sebelum index lolos verifikasi; startup API
   fail-closed bila index belum ready.

## Dry-run (disposable maupun production)

```bash
npm run seller-center:hygiene -- --mongo-uri "$MONGO_URI" --database "$MONGO_DB"
```

Output JSON berisi per-koleksi: `scanned`, `affected`, `duplicateRefIds`,
`uniqueIndexReady` (koleksi order), plus `blocking`.

## Verifikasi index (dry-run)

```bash
cd rust-api
MONGO_URI="$MONGO_URI" MONGO_DB="$MONGO_DB" ./target/debug/seller_order_readiness --json
```

## Apply pada database disposable

```bash
# unsets raw fields
npm run seller-center:hygiene -- --mongo-uri "$MONGO_URI" \
  --database webtopup_task14_dev --apply

# create missing exact unique indexes (refuses duplicates/drift)
cd rust-api
MONGO_URI="$MONGO_URI" MONGO_DB=webtopup_task14_dev ./target/debug/seller_order_readiness --apply --json
```

Setelah apply, **ulangi dry-run** dan pastikan `affected: 0`,
`duplicateRefIds: 0`, dan kedua `uniqueIndexReady: true`.

## Apply pada production (hanya setelah backup + persetujuan tertulis)

1. Backup MongoDB dan simpan referensinya (`$BACKUP_REFERENCE`).
2. Dry-run kedua tool; selesaikan dulu setiap duplikasi/drift.
3. Scrub (Node):

```bash
npm run seller-center:hygiene -- --mongo-uri "$MONGO_URI" --database "$MONGO_DB" \
  --apply --allow-protected-database --confirm-database "$MONGO_DB" \
  --backup-reference "$BACKUP_REFERENCE"
```

4. Index (binary Rust menolak apply di luar disposable; gunakan mongosh):

```javascript
db.digiflazzsellerorders.createIndex({ refId: 1 }, { unique: true });
db.irssellerorders.createIndex({ refId: 1 }, { unique: true });
```

5. Verifikasi ulang dengan dry-run kedua tool sampai tidak blocking, baru
   restart API.

## Rollback / berhenti aman

- Scrub hanya menghapus kolom `rawRequest`/`raw`; rollback =
  restore dari backup `$BACKUP_REFERENCE` ke staging, bukan restore buta ke
  production.
- Bila satu langkah gagal: berhenti, jangan retry `--apply` sebelum dry-run
  kembali bersih dipahami, dan jangan menurunkan guard.
