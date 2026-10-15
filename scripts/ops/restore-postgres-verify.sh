#!/usr/bin/env bash
set -euo pipefail
BACKUP="${1:-}"
CONTAINER="${POSTGRES_CONTAINER:-webtopup-pg-migration-postgres-1}"
TARGET_DB="${TARGET_DB:-webtopup_restore_proof}"
[ -f "$BACKUP" ] || { echo "usage: $0 <backup.dump.enc>" >&2; exit 64; }
case "$TARGET_DB" in webtopup_restore_proof) ;; *) echo "refusing target $TARGET_DB" >&2; exit 77 ;; esac
case "${SOURCE_DB:-webtopup_pg_dev}" in pobb|ppob|webtopup) echo "refusing protected source" >&2; exit 77 ;; esac
[ "$TARGET_DB" = "${SOURCE_DB:-webtopup_pg_dev}" ] && { echo "refusing to overwrite source" >&2; exit 77; }
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || { echo "BACKUP_ENCRYPTION_KEY is required" >&2; exit 77; }
if [ -f "$BACKUP.sha256" ]; then sha256sum -c "$BACKUP.sha256" >/dev/null || { echo "checksum mismatch" >&2; exit 2; }; fi
PLAIN="$(mktemp)"
trap 'rm -f "$PLAIN"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$BACKUP" -out "$PLAIN"
STARTED="$(date +%s%3N)"
docker exec -e PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}" "$CONTAINER" psql -h 127.0.0.1 -p 55432 -U migration_admin -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB';" >/dev/null
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" dropdb -h 127.0.0.1 -p 55432 -U migration_admin --if-exists "$TARGET_DB"
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" createdb -h 127.0.0.1 -p 55432 -U migration_admin "$TARGET_DB"
docker exec -i -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" pg_restore -h 127.0.0.1 -p 55432 -U migration_admin -d "$TARGET_DB" --no-owner --exit-on-error < "$PLAIN"
COUNTS="$(docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" psql -h 127.0.0.1 -p 55432 -U migration_admin -d "$TARGET_DB" -Atc "SELECT json_build_object('users',(SELECT count(*) FROM users),'products',(SELECT count(*) FROM products),'orders',(SELECT count(*) FROM orders),'ledger',(SELECT count(*) FROM ledger_entries));")"
python3 - "$BACKUP.manifest.json" "$COUNTS" <<'PY'
import json, sys
manifest, actual = json.load(open(sys.argv[1])), json.loads(sys.argv[2])
if manifest["counts"] != actual: raise SystemExit(f"count mismatch expected={manifest['counts']} actual={actual}")
PY
ELAPSED="$(( $(date +%s%3N) - STARTED ))"
echo "restore ok target=$TARGET_DB elapsed_ms=$ELAPSED counts=$COUNTS"
