# Backup, Restore, dan Monitoring — Runbook Operasional

Status: **teruji** (backup + restore-verify + status report diuji pada 2026-08-17; restore diuji hanya ke database disposable `webtopup_task14_dev`).

## Lingkup

| Komponen | Alat | Jalur |
|---|---|---|
| Backup Mongo produksi | `scripts/ops/backup-mongo.sh` | `/var/backups/webtopup/{daily,weekly}/` |
| Uji restore (disposable) | `scripts/ops/restore-mongo-verify.sh` | database `webtopup_task14_dev` di port 27018 |
| Monitoring ringan | `scripts/ops/status-report.sh` | output teks/JSON, exit code |

Fakta lingkungan:

- Produksi: container Docker `webtopup-mongo` (mongo:7, replica set `rs0`, port `127.0.0.1:27017`), database `POBB`.
- Host tidak punya `mongodump`/`mongorestore`; semua tooling Mongo berjalan via `docker exec` image mongo.
- Stack disposable (compose project `webtopup-task14-dev`) menjalankan mongod sendiri di port **27018** dengan volume sendiri — terisolasi penuh dari produksi.

## Backup

```bash
sudo /home/danayasa/proyek/webtopup/scripts/ops/backup-mongo.sh daily    # retensi 7 terakhir
sudo /home/danayasa/proyek/webtopup/scripts/ops/backup-mongo.sh weekly   # retensi 4 terakhir
```

Jaminan tiap run:

1. `flock` mencegah tumpang-tindih.
2. `mongodump --archive --gzip` (read-only terhadap database).
3. Arsip **divalidasi dulu** dengan `mongorestore --dryRun` (`0 document(s) failed to restore`) sebelum diterima; arsip yang gagal validasi tidak pernah dipublikasikan.
4. Sidecar `.sha256` dan `.manifest.json` (jumlah dokumen per collection, ukuran, hash).
5. Mode `0600`, direktori `0700`.
6. Pruning retensi hanya menyentuh pola `<db>-*.archive.gz` (+ sidecar) pada bucket mode yang sama.

Override via environment: `MONGO_CONTAINER`, `SOURCE_DB`, `BACKUP_ROOT`, `KEEP_DAILY`, `KEEP_WEEKLY`.

## Uji restore (WAJIB disposable)

Prosedur verifikasi bahwa backup benar-benar bisa direstore — hanya ke database disposable:

```bash
cd /home/danayasa/proyek/webtopup

# 1) Naikkan mongo disposable (port 27018, container terpisah, volume terpisah)
docker compose -f compose.dev-verification.yml up -d mongo mongo-init

# 2) Tunggu primary siap (keluar saat "true")
until docker exec webtopup-task14-dev-mongo-1 mongosh --quiet \
  'mongodb://127.0.0.1:27018/admin?directConnection=true' \
  --eval 'print(db.hello().isWritablePrimary)' | grep -q true; do sleep 2; done

# 3) Restore-verify arsip terbaru
LATEST=$(sudo sh -c "ls -1t /var/backups/webtopup/daily/POBB-*.archive.gz | head -1")
scripts/ops/restore-mongo-verify.sh "$LATEST" --drop

# 4) Turunkan kembali stack disposable
docker compose -f compose.dev-verification.yml down
```

Skrip restore menolak keras (exit 125/1) bila: nama DB target bukan persis `webtopup_task14_dev`, port target 27017, container adalah `webtopup-mongo`, checksum tidak cocok, atau target sudah berisi dokumen tanpa `--drop`. Verifikasi akhir membandingkan jumlah dokumen per collection dengan manifest backup (`ALL COUNTS MATCH`).

## Disaster recovery produksi (MANUAL — tidak diotomasi)

Direstore ke produksi **hanya** oleh operator secara manual, dengan urutan:

1. Hentikan penulis: `sudo systemctl stop webtopup-node webtopup-rust`.
2. Buat backup kondisi-rusak dulu: `sudo scripts/ops/backup-mongo.sh daily` (agar ada jejak forensik).
3. Restore arsip terpilih ke `POBB`:
   ```bash
   sudo sh -c 'docker exec -i webtopup-mongo mongorestore --archive --gzip --drop --nsInclude="POBB.*" < /var/backups/webtopup/daily/POBB-<pilih>.archive.gz'
   ```
4. Bandingkan jumlah per collection dengan `.manifest.json` arsip yang dipakai.
5. Nyalakan ulang: `sudo systemctl start webtopup-rust webtopup-node`, lalu jalankan `scripts/ops/status-report.sh` dan smoke test UI.
6. Catat insiden + arsip yang dipakai di `/var/backups/webtopup/` (catatan tekstual).

Tidak ada jalur otomatis yang bisa menimpa `POBB`; skrip restore selalu menargetkan disposable.

## Monitoring

```bash
scripts/ops/status-report.sh            # laporan teks lengkap
scripts/ops/status-report.sh --quiet    # hanya WARN/FAIL + ringkasan
scripts/ops/status-report.sh --json     # JSON; kirim ke webhook bila ALERT_WEBHOOK diset & ada FAIL
```

Cek: unit systemd (`webtopup-rust`, `webtopup-node`, `docker`), health lokal Rust/Node, health publik via Cloudflare, ping Mongo + keberadaan PRIMARY, kesegaran backup (default maks 25 jam), dan pemakaian disk (`/` dan `/var/backups`; WARN ≥ 85%, FAIL ≥ 95%). Exit 0 hanya bila tidak ada FAIL.

## Usulan cron (BELUM dipasang — butuh persetujuan terpisah)

```cron
# /etc/cron.d/webtopup-ops  (root)
15 2 * * *  root /home/danayasa/proyek/webtopup/scripts/ops/backup-mongo.sh daily  >> /var/log/webtopup/backup.log 2>&1
20 2 * * 0  root /home/danayasa/proyek/webtopup/scripts/ops/backup-mongo.sh weekly >> /var/log/webtopup/backup.log 2>&1
*/10 * * * * root /home/danayasa/proyek/webtopup/scripts/ops/status-report.sh --quiet >> /var/log/webtopup/status.log 2>&1
```

Dengan `sudo mkdir -p /var/log/webtopup` sebelumnya. Pengiriman alert (opsional) cukup menyetel `ALERT_WEBHOOK` di cron line status.
