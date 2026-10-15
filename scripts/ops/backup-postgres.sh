#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-daily}"
CONTAINER="${POSTGRES_CONTAINER:-webtopup-pg-migration-postgres-1}"
SOURCE_DB="${SOURCE_DB:-webtopup_pg_dev}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/webtopup-sql}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
case "$MODE" in daily|weekly) ;; *) echo "usage: $0 [daily|weekly]" >&2; exit 64 ;; esac
case "$SOURCE_DB" in pobb|ppob|webtopup) echo "refusing protected source $SOURCE_DB" >&2; exit 77 ;; esac
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || { echo "BACKUP_ENCRYPTION_KEY is required" >&2; exit 77; }
command -v docker >/dev/null && command -v openssl >/dev/null || { echo "docker and openssl are required" >&2; exit 69; }
mkdir -p /var/lock
exec 9>/var/lock/webtopup-sql-backup.lock
flock -n 9 || { echo "another SQL backup is running" >&2; exit 75; }
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DIR="$BACKUP_ROOT/$MODE"
mkdir -p "$DEST_DIR"
chmod 700 "$BACKUP_ROOT" "$DEST_DIR"
DEST="$DEST_DIR/${SOURCE_DB}-${TS}.dump.enc"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
docker exec -e PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}" "$CONTAINER" pg_dump -h 127.0.0.1 -p 55432 -U migration_admin -d "$SOURCE_DB" --format=custom --no-password > "$TMP"
[ -s "$TMP" ] || { echo "backup failed: empty dump" >&2; exit 1; }
openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$TMP" -out "$DEST"
chmod 600 "$DEST"
SHA256="$(sha256sum "$DEST" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$DEST" > "$DEST.sha256"
COUNTS="$(docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" psql -h 127.0.0.1 -p 55432 -U migration_admin -d "$SOURCE_DB" -Atc "SELECT json_build_object('users',(SELECT count(*) FROM users),'products',(SELECT count(*) FROM products),'orders',(SELECT count(*) FROM orders),'ledger',(SELECT count(*) FROM ledger_entries));")"
python3 - "$DEST" "$SOURCE_DB" "$MODE" "$TS" "$SHA256" "$COUNTS" <<'PY'
import json, os, sys
dest, db, mode, ts, sha, counts = sys.argv[1:]
manifest = {"database": db, "mode": mode, "createdAt": ts, "sha256": sha, "sizeBytes": os.path.getsize(dest), "counts": json.loads(counts), "rpo": "24h", "rto": "4h"}
with open(dest + ".manifest.json", "w") as handle: json.dump(manifest, handle, indent=2, sort_keys=True); handle.write("\n")
PY
chmod 600 "$DEST.sha256" "$DEST.manifest.json"
KEEP="$KEEP_DAILY"; [ "$MODE" = weekly ] && KEEP="$KEEP_WEEKLY"
mapfile -t ARCHIVES < <(ls -1t "$DEST_DIR/${SOURCE_DB}-"*.dump.enc 2>/dev/null || true)
for OLD in "${ARCHIVES[@]:$KEEP}"; do rm -f "$OLD" "$OLD.sha256" "$OLD.manifest.json"; done
echo "backup ok dest=$DEST sha256=$SHA256 counts=$COUNTS"
