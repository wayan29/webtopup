# Backup, Restore, dan Monitoring — PostgreSQL

Status: teruji pada 2026-10-14. Restore hanya menuju `webtopup_restore_proof`.

## Kebijakan

- RPO: 24 jam.
- RTO: 4 jam.
- Redis menyimpan cache dan rate limit. Kehilangan data Redis saat restart diterima; data uang, sesi, dan idempotensi tetap di PostgreSQL.
- Backup memakai `pg_dump --format=custom`, dienkripsi AES-256-CBC, mode file `0600`, disertai SHA-256 dan manifest jumlah baris.
- Credential tidak ditulis ke nama file, manifest, atau output skrip.

## Backup

```bash
PGPASSWORD="$PGPASSWORD" BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
  scripts/ops/backup-postgres.sh daily
```

Retensi default: 7 backup harian dan 4 backup mingguan. Sumber `pobb`, `ppob`, dan `webtopup` ditolak.

## Restore

```bash
PGPASSWORD="$PGPASSWORD" BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
  scripts/ops/restore-postgres-verify.sh /var/backups/webtopup-sql/daily/<arsip>.dump.enc
```

Target selain `webtopup_restore_proof` ditolak. Skrip juga menolak sumber yang sama dengan target. Setelah restore, bandingkan owner, katalog, order, dan ledger dengan manifest.

## Monitoring

`scripts/ops/status-report.sh` memeriksa health gateway, kesegaran backup, dan disk. Backup dianggap gagal bila usia arsip terbaru melewati 25 jam. Ambang disk: peringatan 85%, gagal 95%.
