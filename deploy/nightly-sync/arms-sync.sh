#!/bin/bash
# ARMS nightly sync: copy the latest returns from the NAHDIS SQL Server into
# ARMS's Postgres. Run by arms-sync.timer at 02:00 South African time.
#
# What it does, in order, and it stops at the first thing that is not right:
#   1. asks the NAHDIS server for an export. The key it uses can do nothing
#      else: the server forces it to run nahdis-export.ps1, as arms_sync, whose
#      SQL login can only read the three ARMS databases.
#   2. checks the export arrived whole (SHA-256) and is the full record
#   3. refuses if ARMS holds returns the export would lose - work captured or
#      approved in ARMS itself
#   4. backs up the arms database (the last 14 nights are kept)
#   5. loads every table in one transaction, so it all lands or none of it does
#   6. restarts ARMS so the explorer rebuilds, and runs npm run check
#
# The NAHDIS server keeps returns up to the end of the last complete month, so
# a month appears once it is over. Nothing here writes to the NAHDIS server.
set -euo pipefail

APP=/srv/arms
HERE=$APP/deploy/nightly-sync
NAHDIS=${ARMS_SYNC_HOST:-arms_sync@102.67.140.12}
KEY=${ARMS_SYNC_KEY:-/root/.ssh/arms_sync}
BACKUPS=/root/arms-backups/nightly
KEEP=14
WORK=$(mktemp -d /root/arms-sync.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

exec 9>/run/arms-sync.lock
flock -n 9 || { echo "another sync is running"; exit 1; }

log() { echo "$(date '+%F %T') $*"; }

log "1. fetching the export from ${NAHDIS#*@}"
ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=30 \
    -o ServerAliveInterval=30 "$NAHDIS" > "$WORK/raw.txt"
tr -d '\r' < "$WORK/raw.txt" > "$WORK/out.txt"
if grep -q '^ARMS-SYNC-ERROR' "$WORK/out.txt"; then
  log "the NAHDIS server reported: $(grep '^ARMS-SYNC-ERROR' "$WORK/out.txt")"; exit 1
fi
CUTOFF=$(sed -n 's/^ARMS-SYNC-BEGIN //p' "$WORK/out.txt")
SHA=$(sed -n 's/^ARMS-SYNC-END //p' "$WORK/out.txt")
[ -n "$CUTOFF" ] && [ -n "$SHA" ] || { log "no export in the reply"; exit 1; }
sed -n '/^ARMS-SYNC-BEGIN/,/^ARMS-SYNC-END/p' "$WORK/out.txt" | sed '1d;$d' | base64 -d > "$WORK/export.zip"

log "2. checking it: returns before $CUTOFF"
echo "$SHA  $WORK/export.zip" | sha256sum -c --quiet - || { log "checksum mismatch - a damaged transfer"; exit 1; }
mkdir "$WORK/tsv"
unzip -q "$WORK/export.zip" -d "$WORK/tsv"
grep -v '^cutoff' "$WORK/tsv/manifest.tsv" | awk -F'\t' '{printf "   %-52s %8s\n", $1, $2}' | grep -iE 'formdata\b|formdataitems|itemparts|organisation\b' || true

set -a; . <(grep -E '^SQL_(SERVER|PORT|DATABASE|USER|PASSWORD)=' "$APP/.env"); set +a
export PGHOST=$SQL_SERVER PGPORT=${SQL_PORT:-5432} PGDATABASE=${SQL_DATABASE:-arms} PGUSER=$SQL_USER PGPASSWORD=$SQL_PASSWORD
export NODE_PATH=$APP/node_modules

log "3. guard"
node "$HERE/pgload.cjs" guard "$WORK/tsv"

log "4. backup"
mkdir -p "$BACKUPS"
DUMP="$BACKUPS/arms-pg-$(date +%Y%m%d-%H%M%S).dump"
pg_dump -Fc -f "$DUMP"
ls -1t "$BACKUPS"/arms-pg-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
log "   $DUMP ($(du -h "$DUMP" | cut -f1))"

log "5. loading"
node "$HERE/pgload.cjs" script "$WORK/tsv" "$WORK/load.psql"
psql -w -q -f "$WORK/load.psql" > "$WORK/load.log" 2>&1 || { tail -5 "$WORK/load.log"; log "load failed - rolled back, ARMS unchanged"; exit 1; }
psql -w -Atc "SELECT '   ' || to_char(frmd_startdate,'YYYY-MM') || '  ' || count(*) || ' returns, ' || sum((frmd_status='Approved')::int) || ' approved'
              FROM schedule8data.formdata WHERE frmd_startdate >= date_trunc('month', now()) - interval '3 months' GROUP BY 1 ORDER BY 1"

log "6. restarting ARMS and checking"
systemctl restart arms
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$(grep -oP '^PORT=\K\d+' "$APP/.env" || echo 3000)/api/health" >/dev/null && break; sleep 1; done
cd "$APP" && sudo -u arms npm run --silent check | grep -E 'FAIL|returns|periods|All checks'
sudo -u arms npm run --silent check | grep -q 'All checks passed' || { log "check failed after the load"; exit 1; }
log "done"
