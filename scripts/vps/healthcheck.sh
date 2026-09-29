#!/usr/bin/env bash
# Deployment: single VPS. The lightweight monitor that runs by default (Prometheus is off on a 2 GB
# server). Every 5 minutes (postmind-healthcheck@<env>.timer, scripts/vps/install-timers.sh):
#   - /api/health/ready through Caddy (TLS + proxy + app + Postgres + Redis);
#   - web, worker, postgres, redis containers running and healthy, none OOM-killed;
#   - signs the server is too small: swap use, low available memory, a full disk, queue backlog
#     (studio_queue_jobs waiting+prioritized > 500, the StudioQueueBacklog threshold).
# A problem is posted once (then every 6 h while it lasts) to Alertmanager or OPS_ALERT_WEBHOOK_URL,
# and a recovery is posted when it clears. It cannot see the server itself die: pair it with an
# external uptime check of https://<domain>/api/health/ready (runbooks/vps-deploy.md "Monitoring").
#
#   scripts/vps/healthcheck.sh production        # prints the findings; exit 1 on a failure
set -euo pipefail
# shellcheck source=scripts/vps/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -ge 1 ] || die "usage: scripts/vps/healthcheck.sh <production|staging>"
vps_init "$1"
tag="$(current_tag)"
[ -n "$tag" ] || die "nothing deployed to $STUDIO_ENV yet"
export IMAGE_TAG="$tag"

SWAP_WARN_PCT="${STUDIO_SWAP_WARN_PCT:-50}"
MEM_AVAILABLE_WARN_MB="${STUDIO_MEM_AVAILABLE_WARN_MB:-150}"
DISK_FAIL_PCT="${STUDIO_DISK_FAIL_PCT:-85}"
BACKLOG_WARN="${STUDIO_BACKLOG_WARN:-500}"
REPEAT_SEC=$((6 * 3600))
STATUS_FILE="$STATE_DIR/$STUDIO_ENV/healthcheck.status"

failures=()
warnings=()

check_ready() {
  local domain
  domain="$(env_get STUDIO_DOMAIN "$ENV_FILE")"
  curl -fsS --max-time 15 --resolve "$domain:443:127.0.0.1" -o /dev/null \
    "https://$domain/api/health/ready" || failures+=("https://$domain/api/health/ready is not 200")
}

check_containers() {
  local service id state
  for service in web worker postgres redis; do
    id="$(app_compose ps -q "$service" 2>/dev/null || true)"
    if [ -z "$id" ]; then
      failures+=("$service is not running")
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.OOMKilled}}' "$id")"
    case "$state" in
      "running healthy "* | "running none "*) ;;
      *) failures+=("$service: $state") ;;
    esac
    [[ "$state" != *" true" ]] || warnings+=("$service was OOM-killed (raise its memory limit or the server size)")
  done
}

check_host() {
  local swap_total swap_free mem_available used_pct disk_pct
  swap_total="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  swap_free="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  mem_available="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
  if [ "${swap_total:-0}" -gt 0 ]; then
    used_pct=$(((swap_total - swap_free) * 100 / swap_total))
    [ "$used_pct" -lt "$SWAP_WARN_PCT" ] || warnings+=("swap ${used_pct}% used: the server is short of memory")
  fi
  [ "$mem_available" -ge "$MEM_AVAILABLE_WARN_MB" ] || warnings+=("only ${mem_available} MB memory available")
  disk_pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [ "$disk_pct" -lt "$DISK_FAIL_PCT" ] || failures+=("disk ${disk_pct}% full (docker image prune, bigger disk)")
}

check_backlog() {
  local metrics
  metrics="$(app_compose exec -T web node -e \
    "fetch('http://127.0.0.1:3010/api/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" \
    2>/dev/null || true)"
  [ -n "$metrics" ] || return 0
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && warnings+=("queue backlog: $line")
  done < <(printf '%s\n' "$metrics" | awk -v max="$BACKLOG_WARN" '
    /^studio_queue_jobs\{/ && /state="(waiting|prioritized)"/ {
      match($0, /queue="[^"]*"/); q = substr($0, RSTART + 7, RLENGTH - 8); sum[q] += $NF }
    END { for (q in sum) if (sum[q] > max) printf "%s has %d jobs waiting\n", q, sum[q] }')
}

# Posts on a change of state, and every REPEAT_SEC while a problem lasts.
notify() {
  local summary="$1" status="$2" previous="" since=0 now
  now="$(date +%s)"
  if [ -f "$STATUS_FILE" ]; then read -r previous since <"$STATUS_FILE" || true; fi
  if [ "$status" = "ok" ]; then
    [ "$previous" = "ok" ] || [ -z "$previous" ] || post_ops_alert "recovered" true healthcheck
    printf 'ok %s\n' "$now" >"$STATUS_FILE"
    return 0
  fi
  if [ "$previous" != "$status" ] || [ $((now - ${since:-0})) -ge "$REPEAT_SEC" ]; then
    post_ops_alert "$summary" false healthcheck
    printf '%s %s\n' "$status" "$now" >"$STATUS_FILE"
  fi
}

check_ready
check_containers
check_host
check_backlog

mkdir -p "$(dirname "$STATUS_FILE")"
for item in "${failures[@]+"${failures[@]}"}"; do log "FAIL $item"; done
for item in "${warnings[@]+"${warnings[@]}"}"; do log "WARN $item"; done
if [ "${#failures[@]}" -gt 0 ]; then
  notify "health FAILED on $(hostname): ${failures[*]} ${warnings[*]+| ${warnings[*]}}" fail
  exit 1
fi
if [ "${#warnings[@]}" -gt 0 ]; then
  notify "server under pressure on $(hostname): ${warnings[*]}" warn
  exit 0
fi
notify "" ok
log "OK: $STUDIO_ENV ready, containers healthy, memory/disk/queues within limits"
