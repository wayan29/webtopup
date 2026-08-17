#!/usr/bin/env bash
# Restore-verify a webtopup Mongo backup into the DISPOSABLE database only.
#
# Hard safety guarantees (refuse and exit otherwise):
#   * The restore target database name is always exactly `webtopup_task14_dev`.
#   * The mongod target is always the disposable instance (port 27018), never 27017.
#   * The container used for mongorestore is never the production container.
#   * Restoring over an existing non-empty disposable database requires --drop.
#
# Usage: scripts/ops/restore-mongo-verify.sh <backup.archive.gz> [--drop]
#          [--container NAME] [--port N] [--ns-from DB]
#
# Full disaster recovery into production is a documented MANUAL procedure
# (docs/ops/backup-restore-monitoring.md); this script never performs it.
set -euo pipefail

ALLOWED_DB="webtopup_task14_dev"
PROD_CONTAINER="webtopup-mongo"
PROD_PORT="27017"
DEFAULT_PORT="27018"
DEFAULT_CONTAINER="webtopup-task14-dev-mongo-1"

BACKUP=""
DROP=0
CONTAINER="$DEFAULT_CONTAINER"
PORT="$DEFAULT_PORT"
NS_FROM="POBB"

while [ $# -gt 0 ]; do
  case "$1" in
    --drop) DROP=1 ;;
    --container) CONTAINER="${2:?}"; shift ;;
    --port) PORT="${2:?}"; shift ;;
    --ns-from) NS_FROM="${2:?}"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 64 ;;
    *) if [ -n "$BACKUP" ]; then echo "unexpected argument: $1" >&2; exit 64; fi
       BACKUP="$1" ;;
  esac
  shift
done

[ -n "$BACKUP" ] || { echo "usage: $0 <backup.archive.gz> [--drop]" >&2; exit 64; }
BACKUP="$(readlink -f "$BACKUP")"
[ -f "$BACKUP" ] || { echo "backup file not found: $BACKUP" >&2; exit 66; }
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 69; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "disposable mongo container '$CONTAINER' not running (compose up the dev-verification mongo first)" >&2
  exit 69
}
if [ "$CONTAINER" = "$PROD_CONTAINER" ]; then
  echo "REFUSED: '$CONTAINER' is the production container" >&2
  exit 125
fi
if [ "$PORT" = "$PROD_PORT" ]; then
  echo "REFUSED: port $PROD_PORT is the production mongod; disposable stack uses $DEFAULT_PORT" >&2
  exit 125
fi
case "$NS_FROM" in
  ''|*[!A-Za-z0-9_-]*) echo "invalid --ns-from database name" >&2; exit 64 ;;
esac

URI="mongodb://127.0.0.1:$PORT/$ALLOWED_DB?directConnection=true"

# Verify checksum sidecar when present.
if [ -f "$BACKUP.sha256" ]; then
  ( cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256" >/dev/null ) \
    || { echo "checksum mismatch for $BACKUP" >&2; exit 65; }
  echo "checksum ok"
fi

# Refuse to merge silently into a non-empty disposable database.
EXISTING="$(docker exec "$CONTAINER" mongosh --quiet "$URI" --eval '
let docs = 0;
for (const c of db.getCollectionNames()) docs += db.getCollection(c).countDocuments({});
print(docs);' | tail -1)"
if [ "${EXISTING:-0}" -gt 0 ] && [ "$DROP" -ne 1 ]; then
  echo "target $ALLOWED_DB already holds ${EXISTING} document(s); pass --drop to replace them" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] restore start backup=$BACKUP"
echo "  target db=$ALLOWED_DB port=$PORT container=$CONTAINER nsFrom=$NS_FROM.* nsTo=$ALLOWED_DB.* drop=$DROP"

DROP_FLAG=()
[ "$DROP" -ne 1 ] || DROP_FLAG=(--drop)

if ! docker exec -i "$CONTAINER" mongorestore \
      --host 127.0.0.1 --port "$PORT" \
      --archive --gzip \
      --nsFrom="$NS_FROM.*" --nsTo="$ALLOWED_DB.*" \
      "${DROP_FLAG[@]}" \
      < "$BACKUP"; then
  echo "restore FAILED" >&2
  exit 1
fi

# Post-restore verification: per-collection counts vs the backup manifest when available.
MANIFEST="$BACKUP.manifest.json"
RESTORED="$(docker exec "$CONTAINER" mongosh --quiet "$URI" --eval '
const out = {};
for (const c of db.getCollectionNames().sort()) out[c] = db.getCollection(c).countDocuments({});
print(JSON.stringify(out));')"

if [ -f "$MANIFEST" ]; then
  RESULT="$(python3 - "$MANIFEST" "$RESTORED" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
restored = json.loads(sys.argv[2])
expected = manifest.get("collections", {})
mismatches = []
rows = []
for name in sorted(expected):
    exp, got = expected.get(name, 0), restored.get(name, 0)
    rows.append(("count", name, exp, got))
    if exp != got:
        mismatches.append({"collection": name, "expected": exp, "restored": got})
extras = [name for name in sorted(restored) if name not in expected]
print(json.dumps({
    "collections": [{"kind": k, "name": n, "expected": e, "restored": g} for k, n, e, g in rows],
    "extras": extras,
    "mismatches": mismatches,
    "ok": not mismatches,
}))
PY
)"
  echo "$RESULT" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for row in data["collections"]:
    mark = "OK " if row["expected"] == row["restored"] else "BAD"
    name, exp, got = row["name"], row["expected"], row["restored"]
    print(f"  {mark} {name}: expected={exp} restored={got}")
for name in data["extras"]:
    print(f"  NOTE {name}: present in target but not in this backup (pre-existing disposable state)")
if data["ok"]:
    print("restore verification: ALL COUNTS MATCH")
else:
    print("restore verification: MISMATCH", file=sys.stderr)
    sys.exit(1)
'
else
  echo "no manifest sidecar; restored counts (unverified against backup):"
  echo "$RESTORED" | python3 -m json.tool
fi

echo "[$(date -u +%FT%TZ)] restore ok (disposable database $ALLOWED_DB only; production untouched)"
