#!/usr/bin/env bash
# webtopup lightweight ops status report: services, health endpoints, Mongo, backup
# freshness, and disk usage. Read-only; safe to run any time.
#
# Usage: scripts/ops/status-report.sh [--json] [--quiet]
#
# Exit codes: 0 = all checks pass (warnings allowed), 1 = at least one FAIL.
# Optional: ALERT_WEBHOOK — HTTPS URL that receives a JSON summary when any check fails.
set -uo pipefail

PUBLIC_BASE="${PUBLIC_BASE:-https://danayasa.biz.id}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/webtopup}"
BACKUP_DB="${BACKUP_DB:-POBB}"
MONGO_CONTAINER="${MONGO_CONTAINER:-webtopup-mongo}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-25}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
DISK_FAIL_PCT="${DISK_FAIL_PCT:-95}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"

JSON=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 64 ;;
  esac
done

RESULTS=()
PASS=0; WARN=0; FAIL=0

record() { # status name detail
  RESULTS+=("$1|$2|$3")
  case "$1" in PASS) PASS=$((PASS+1)) ;; WARN) WARN=$((WARN+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; esac
}

unit_active() {
  systemctl is-active --quiet "$1" 2>/dev/null
}

http_code() { # url timeout
  curl -ksS -o /dev/null -w '%{http_code}' --max-time "${2:-10}" "$1" 2>/dev/null || echo 000
}

# --- systemd units -----------------------------------------------------------
for unit in webtopup-rust webtopup-node docker; do
  if unit_active "$unit"; then record PASS "unit:$unit" "active"
  else record FAIL "unit:$unit" "$(systemctl is-active "$unit" 2>&1 | head -1)"; fi
done

# --- health endpoints --------------------------------------------------------
rust_local="$(http_code http://127.0.0.1:9010/health)"
node_local="$(http_code http://127.0.0.1:9005/api/v2/health)"
public="$(http_code "$PUBLIC_BASE/api/v2/health")"
[ "$rust_local" = 200 ] && record PASS "health:rust-local" "200" \
  || record FAIL "health:rust-local" "$rust_local"
[ "$node_local" = 200 ] && record PASS "health:node-local" "200" \
  || record FAIL "health:node-local" "$node_local"
[ "$public" = 200 ] && record PASS "health:public" "200" \
  || record FAIL "health:public" "$public"

# --- mongo -------------------------------------------------------------------
MONGO_PROBE="$(docker exec "$MONGO_CONTAINER" mongosh --quiet admin --eval '
let ok = "fail";
try {
  const ping = db.adminCommand({ ping: 1 });
  const rs = db.adminCommand({ replSetGetStatus: 1 });
  const primary = Array.isArray(rs.members) && rs.members.some((m) => m.state === 1);
  ok = ping.ok === 1 && primary ? "ok" : "degraded";
} catch (e) { ok = "fail"; }
print(ok);' 2>/dev/null | tail -1 || echo fail)"
case "$MONGO_PROBE" in
  ok) record PASS "mongo:$MONGO_CONTAINER" "ping ok, primary present" ;;
  degraded) record WARN "mongo:$MONGO_CONTAINER" "ping ok, no primary found" ;;
  *) record FAIL "mongo:$MONGO_CONTAINER" "unreachable" ;;
esac

# --- backup freshness --------------------------------------------------------
NEWEST_BACKUP=""
NEWEST_EPOCH=0
if [ -d "$BACKUP_ROOT" ]; then
  for f in "$BACKUP_ROOT"/daily/"$BACKUP_DB"-*.archive.gz \
           "$BACKUP_ROOT"/weekly/"$BACKUP_DB"-*.archive.gz; do
    [ -f "$f" ] || continue
    m="$(stat -c %Y "$f")"
    if [ "$m" -gt "$NEWEST_EPOCH" ]; then NEWEST_EPOCH="$m"; NEWEST_BACKUP="$f"; fi
  done
fi
if [ -z "$NEWEST_BACKUP" ]; then
  record FAIL "backup:freshness" "no backup archive found under $BACKUP_ROOT"
else
  now="$(date +%s)"
  age_h=$(( (now - NEWEST_EPOCH) / 3600 ))
  if [ "$age_h" -le "$BACKUP_MAX_AGE_HOURS" ]; then
    record PASS "backup:freshness" "newest $NEWEST_BACKUP (${age_h}h old)"
  else
    record FAIL "backup:freshness" "newest $NEWEST_BACKUP is ${age_h}h old (max ${BACKUP_MAX_AGE_HOURS}h)"
  fi
fi

# --- disk usage ----------------------------------------------------------------
check_disk() { # mount label
  local pct label mount
  label="$1"; mount="$2"
  pct="$(df -P "$mount" 2>/dev/null | awk 'NR==2{gsub("%",""); print $5}')"
  if [ -z "$pct" ]; then record WARN "disk:$label" "usage unknown"
  elif [ "$pct" -ge "$DISK_FAIL_PCT" ]; then record FAIL "disk:$label" "${pct}% used"
  elif [ "$pct" -ge "$DISK_WARN_PCT" ]; then record WARN "disk:$label" "${pct}% used"
  else record PASS "disk:$label" "${pct}% used"; fi
}
check_disk root /
check_disk backups "$(dirname "$BACKUP_ROOT")"

# --- output --------------------------------------------------------------------
emit_text() {
  local show_all=1
  [ "$QUIET" -eq 1 ] && show_all=0
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r status name detail <<< "$row"
    [ "$show_all" -eq 1 ] || case "$status" in PASS) continue ;; esac
    printf '%-4s %-28s %s\n' "$status" "$name" "$detail"
  done
  echo "SUMMARY pass=$PASS warn=$WARN fail=$FAIL"
}

emit_json() {
  PAYLOAD="$(python3 - "$PASS" "$WARN" "$FAIL" "${RESULTS[@]}" <<'PY'
import datetime, json, sys
p, w, f = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
rows = []
for raw in sys.argv[4:]:
    status, name, detail = raw.split('|', 2)
    rows.append({"status": status, "name": name, "detail": detail})
print(json.dumps({
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "summary": {"pass": p, "warn": w, "fail": f, "healthy": f == 0},
    "checks": rows,
}))
PY
)"
  echo "$PAYLOAD"
  if [ -n "$ALERT_WEBHOOK" ] && [ "$FAIL" -gt 0 ]; then
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      -d "$PAYLOAD" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

if [ "$JSON" -eq 1 ]; then emit_json; else emit_text; fi
[ "$FAIL" -eq 0 ]
