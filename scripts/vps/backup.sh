#!/usr/bin/env bash
# Deployment: single VPS. Nightly backups of one environment (runbooks/backup-recovery.md), run by
# the systemd timer postmind-backup@<env>.timer (scripts/vps/install-timers.sh):
#   db       pgBackRest base backup to R2: full on Sundays, differential otherwise (the schedule in
#            https://pgbackrest.org/user-guide.html), then `check` (WAL archiving still works).
#            Expiry per PG_BACKUP_RETENTION_DAYS runs after every backup.
#   storage  the object-storage backup copy (scripts/ops/backup-storage.ts --apply, Phase 17.5).
#
#   scripts/vps/backup.sh production              # db + storage
#   scripts/vps/backup.sh production db --type full
#   scripts/vps/backup.sh production storage
#   scripts/vps/backup.sh production info         # pgBackRest backups and WAL range in R2
# Exit 1 when any part failed; a failure is also posted to Alertmanager or OPS_ALERT_WEBHOOK_URL.
set -euo pipefail
# shellcheck source=scripts/vps/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -ge 1 ] || die "usage: scripts/vps/backup.sh <production|staging> [db|storage|all|info] [--type full|diff|incr]"
vps_init "$1"
what="${2:-all}"
type=""
if [ "${3:-}" = "--type" ]; then type="${4:-}"; fi
case "$type" in "" | full | diff | incr) ;; *) die "--type must be full, diff or incr" ;; esac

tag="$(current_tag)"
[ -n "$tag" ] || die "nothing deployed to $STUDIO_ENV yet"
export IMAGE_TAG="$tag"

backup_db() {
  if [ "$(env_get PG_BACKUPS "$ENV_FILE")" = "off" ]; then
    log "PG_BACKUPS=off: skipping the database backup"
    return 0
  fi
  local kind="$type"
  if [ -z "$kind" ]; then
    # Sunday = 7 (date +%u). A diff needs a full first; pgBackRest promotes it to full if none exists.
    if [ "$(date -u +%u)" = "7" ]; then kind="full"; else kind="diff"; fi
  fi
  log "pgBackRest $kind backup of $STUDIO_ENV"
  app_compose exec -T -u postgres postgres pgbackrest --type="$kind" backup &&
    app_compose exec -T -u postgres postgres pgbackrest check
}

backup_storage() {
  log "object-storage backup copy of $STUDIO_ENV"
  app_compose run --rm --no-deps backup-storage
}

db_info() {
  app_compose exec -T -u postgres postgres pgbackrest info
}

failed=()
case "$what" in
  db) backup_db || failed+=(db) ;;
  storage) backup_storage || failed+=(storage) ;;
  all)
    backup_db || failed+=(db)
    backup_storage || failed+=(storage)
    ;;
  info)
    db_info
    exit 0
    ;;
  *) die "unknown part '$what' (db, storage, all, info)" ;;
esac

if [ "${#failed[@]}" -gt 0 ]; then
  post_ops_alert "backup FAILED on $(hostname): ${failed[*]} (journalctl -u postmind-backup@${STUDIO_ENV})" false backup
  die "backup failed: ${failed[*]}"
fi
post_ops_alert "backup OK" true backup
log "backup OK ($what)"
