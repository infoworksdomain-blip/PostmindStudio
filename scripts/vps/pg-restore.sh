#!/usr/bin/env bash
# Deployment: single VPS. Point-in-time restore of one environment's Postgres from the pgBackRest
# repository in R2 (runbooks/backup-recovery.md, staging-gate.md 7–8). pgBackRest commands follow
# https://pgbackrest.org/user-guide.html (read 2026-09-29): restore --type=time --target=…
# --target-action=promote, with --delta for an in-place restore.
#
# Drill / verification (the live database is not touched):
#   scripts/vps/pg-restore.sh staging snapshot                     # 1. row counts of the LIVE db
#   scripts/vps/pg-restore.sh staging drill '2026-09-29 10:15:00+00'   # 2. restore into postgres-restore
#   scripts/vps/pg-restore.sh staging check --incident-at <ISO> --restore-started-at <ISO>
#                                                                  # 3. staging-gate --restore-check
#   scripts/vps/pg-restore.sh staging cleanup                      # 4. remove the drill instance
# Real incident, in place (stops web + worker; engage the kill switch first):
#   scripts/vps/pg-restore.sh production in-place '2026-09-29 10:15:00+00' --yes
set -euo pipefail
# shellcheck source=scripts/vps/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -ge 2 ] || die "usage: scripts/vps/pg-restore.sh <env> snapshot|drill <time>|check [flags]|cleanup|in-place <time> --yes"
vps_init "$1"
action="$2"
shift 2
tag="$(current_tag)"
[ -n "$tag" ] || die "nothing deployed to $STUDIO_ENV yet"
export IMAGE_TAG="$tag"
PGDATA_PATH=/var/lib/postgresql/data

valid_target() {
  [[ "${1:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([+-][0-9]{2}(:?[0-9]{2})?|Z)$ ]] ||
    die "restore time must look like '2026-09-29 10:15:00+00' (with a UTC offset)"
}

# Waits until the named service accepts connections and has left recovery (promoted).
wait_promoted() {
  local service="$1" deadline=$((SECONDS + ${STUDIO_RESTORE_TIMEOUT_SEC:-3600}))
  log "waiting for $service to finish WAL replay and promote"
  until [ "$(app_compose exec -T -u postgres "$service" \
    psql -U studio -d postmind_studio -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)" = "f" ]; do
    [ "$SECONDS" -lt "$deadline" ] || die "$service did not promote in time: scripts/vps/compose.sh $STUDIO_ENV logs $service"
    sleep 10
  done
}

staging_gate() {
  # ops mounts STATE_DIR/<env>/results as ops/results (the snapshot file lives there).
  app_compose run --rm --no-deps ops node --import tsx scripts/ops/staging-gate.ts "$@"
}

case "$action" in
  snapshot)
    staging_gate --snapshot
    ;;
  drill)
    valid_target "${1:-}"
    started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    log "drill restore of $STUDIO_ENV to $1 (started $started; pass it as --restore-started-at)"
    app_compose --profile restore rm -sf postgres-restore >/dev/null 2>&1 || true
    docker volume rm -f "${PROJECT}_postgres-restore-data" >/dev/null 2>&1 || true
    # shellcheck disable=SC2016 # expanded by the container shell (args after sh -c), not here
    app_compose --profile restore run --rm --no-deps -u postgres postgres-restore sh -c \
      'pgbackrest --type=time "--target=$1" --target-action=promote restore && chmod 0700 "$2"' \
      restore "$1" "$PGDATA_PATH"
    app_compose --profile restore up -d postgres-restore
    wait_promoted postgres-restore
    log "restored instance is up (service postgres-restore). Next: pg-restore.sh $STUDIO_ENV check --incident-at <ISO> --restore-started-at $started"
    ;;
  check)
    # --restore-check reads DATABASE_URL: point it at the drill instance for this run only.
    # shellcheck disable=SC2016 # expanded by the container shell (args after sh -c), not here
    app_compose run --rm --no-deps --entrypoint sh ops -c \
      'export DATABASE_URL="$RESTORED_DATABASE_URL"; exec node --import tsx scripts/ops/staging-gate.ts --restore-check "$@"' \
      restore-check "$@"
    log "report: $STATE_DIR/$STUDIO_ENV/results/"
    ;;
  cleanup)
    app_compose --profile restore rm -sf postgres-restore
    docker volume rm -f "${PROJECT}_postgres-restore-data" >/dev/null 2>&1 || true
    log "drill instance removed"
    ;;
  in-place)
    valid_target "${1:-}"
    [ "${2:-}" = "--yes" ] || die "in-place replaces the live database: add --yes (runbooks/backup-recovery.md)"
    log "IN-PLACE restore of $STUDIO_ENV to $1: stopping web and worker, then Postgres"
    app_compose stop web worker
    app_compose stop postgres
    # shellcheck disable=SC2016 # expanded by the container shell (args after sh -c), not here
    app_compose run --rm --no-deps -u postgres postgres sh -c \
      'pgbackrest --delta --type=time "--target=$1" --target-action=promote restore && chmod 0700 "$2"' \
      restore "$1" "$PGDATA_PATH"
    app_compose up -d --wait --wait-timeout 300 postgres
    wait_promoted postgres
    log "Postgres promoted on a new timeline; starting web and worker"
    app_compose up -d --no-deps --wait --wait-timeout 300 web worker
    log "taking a fresh full backup of the new timeline"
    bash "$(dirname "${BASH_SOURCE[0]}")/backup.sh" "$STUDIO_ENV" db --type full
    log "done. Verify (golden path), then release the kill switch."
    ;;
  *) die "unknown action '$action'" ;;
esac
