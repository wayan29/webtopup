#!/usr/bin/env bash
# webtopup Mongo backup: archive dump + dry-run validation + manifest + retention pruning.
#
# Usage: sudo scripts/ops/backup-mongo.sh [daily|weekly]
#
# Environment overrides:
#   MONGO_CONTAINER  (default webtopup-mongo)
#   SOURCE_DB        (default POBB)
#   BACKUP_ROOT      (default /var/backups/webtopup)
#   KEEP_DAILY       (default 7)
#   KEEP_WEEKLY      (default 4)
#
# Output: $BACKUP_ROOT/<mode>/<db>-<UTC-timestamp>.archive.gz plus .sha256 and .manifest.json
# sidecars. Production is only read (mongodump); nothing is ever written back to the database.
set -euo pipefail

MONGO_CONTAINER="${MONGO_CONTAINER:-webtopup-mongo}"
SOURCE_DB="${SOURCE_DB:-POBB}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/webtopup}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
MODE="${1:-daily}"

case "$MODE" in
  daily|weekly) ;;
  *) echo "usage: $0 [daily|weekly]" >&2; exit 64 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo): $BACKUP_ROOT is root-owned" >&2
  exit 77
fi
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 69; }
docker inspect "$MONGO_CONTAINER" >/dev/null 2>&1 || {
  echo "mongo container '$MONGO_CONTAINER' not found" >&2
  exit 69
}

# Prevent overlapping runs (cron + manual).
mkdir -p /var/lock
exec 9>/var/lock/webtopup-mongo-backup.lock
flock -n 9 || { echo "another backup is already running" >&2; exit 75; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DIR="$BACKUP_ROOT/$MODE"
DEST="$DEST_DIR/${SOURCE_DB}-${TS}.archive.gz"
TMP="$DEST_DIR/.${SOURCE_DB}-${TS}.tmp.$$"
KEEP="$KEEP_DAILY"
[ "$MODE" = weekly ] && KEEP="$KEEP_WEEKLY"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "[$(date -u +%FT%TZ)] backup start db=$SOURCE_DB container=$MONGO_CONTAINER mode=$MODE"
mkdir -p "$DEST_DIR"

# 1) Stream the archive dump (read-only for the database).
if ! docker exec "$MONGO_CONTAINER" mongodump --db "$SOURCE_DB" --archive --gzip > "$TMP"; then
  echo "backup FAILED: mongodump error" >&2
  exit 1
fi
if [ ! -s "$TMP" ]; then
  echo "backup FAILED: empty archive" >&2
  exit 1
fi

# 2) Validate the archive with a restore dry-run before accepting it.
VALIDATE_LOG="$(mktemp)"
if ! docker exec -i "$MONGO_CONTAINER" mongorestore --archive --gzip --dryRun \
      --nsInclude="$SOURCE_DB.*" < "$TMP" > "$VALIDATE_LOG" 2>&1 \
   || ! grep -q '0 document(s) failed to restore' "$VALIDATE_LOG"; then
  echo "backup FAILED: archive did not validate (dry-run restore)" >&2
  tail -5 "$VALIDATE_LOG" >&2
  rm -f "$VALIDATE_LOG"
  exit 2
fi
rm -f "$VALIDATE_LOG"

# 3) Publish the archive with restrictive permissions and sidecars.
mv "$TMP" "$DEST"
chmod 600 "$DEST"
SHA256="$(sha256sum "$DEST" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$DEST" > "$DEST.sha256"
chmod 600 "$DEST.sha256"

COUNTS_JSON="$(docker exec "$MONGO_CONTAINER" mongosh --quiet "$SOURCE_DB" --eval '
const out = {};
for (const c of db.getCollectionNames().sort()) out[c] = db.getCollection(c).countDocuments({});
print(JSON.stringify(out));')"

SIZE="$(stat -c %s "$DEST")"
python3 - "$DEST" "$SOURCE_DB" "$MODE" "$TS" "$SIZE" "$SHA256" "$COUNTS_JSON" <<'PY'
import json, sys
dest, db, mode, ts, size, sha, counts = sys.argv[1:8]
manifest = {
    "database": db,
    "mode": mode,
    "createdAt": ts,
    "sizeBytes": int(size),
    "sha256": sha,
    "collections": json.loads(counts),
}
with open(dest + ".manifest.json", "w") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
chmod 600 "$DEST.manifest.json"

# 4) Retention: keep the newest $KEEP archives (plus sidecars) in this mode bucket.
shopt -s nullglob
PRUNED=0
mapfile -t ARCHIVES < <(ls -1t "$DEST_DIR/${SOURCE_DB}-"*.archive.gz 2>/dev/null)
for OLD in "${ARCHIVES[@]:$KEEP}"; do
  rm -f "$OLD" "$OLD.sha256" "$OLD.manifest.json"
  PRUNED=$((PRUNED + 1))
  echo "pruned $OLD"
done
shopt -u nullglob

echo "[$(date -u +%FT%TZ)] backup ok dest=$DEST size=$SIZE sha256=$SHA256 pruned=$PRUNED kept=$((${#ARCHIVES[@]} > KEEP ? KEEP : ${#ARCHIVES[@]}))"
exit 0
