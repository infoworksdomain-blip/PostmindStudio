#!/usr/bin/env bash
# Deployment: single VPS. Shared helpers for scripts/vps/*.sh — sourced, never run on its own.
#
# Layout on the server (created by deploy/vps/bootstrap.sh):
#   /opt/postmind-studio                       this repository (git clone), REPO_DIR
#   /etc/postmind-studio/<env>.env             app + compose env (deploy/vps/.env.example)
#   /etc/postmind-studio/<env>.backup.env      backup credentials (deploy/vps/backup.env.example)
#   /etc/postmind-studio/secrets/<env>/        files mounted as compose secrets (monitoring)
#   /var/lib/postmind-studio/                  state: deployed tags, Caddy site files, reports
# Every path can be overridden with the variables below (tests, a second checkout).

set -euo pipefail

VPS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${STUDIO_REPO_DIR:-$(cd "$VPS_LIB_DIR/../.." && pwd)}"
DEPLOY_DIR="$REPO_DIR/deploy/vps"
CONFIG_DIR="${STUDIO_CONFIG_DIR:-/etc/postmind-studio}"
STATE_DIR="${STUDIO_STATE_DIR:-/var/lib/postmind-studio}"
EDGE_PROJECT="postmind-edge"

# Image tags: the same rule as scripts/ops/staging-gate (src/lib/studio/ops/staging-gate/args.ts).
# shellcheck disable=SC2034 # used by deploy.sh, which sources this file
TAG_PATTERN='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'

log() { printf '%s [vps] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# env_get KEY FILE — the last KEY=value in an env file, surrounding quotes removed. Never sources
# the file (values may contain shell metacharacters) and never prints secrets on its own.
env_get() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in
    \'*\') value="${value#\'}" value="${value%\'}" ;;
    \"*\") value="${value#\"}" value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

# vps_init <production|staging> — sets PROJECT, ENV_FILE, BACKUP_ENV_FILE, SECRETS_DIR and the
# variables compose.yml interpolates from the shell (they win over --env-file values).
vps_init() {
  STUDIO_ENV="${1:-}"
  case "$STUDIO_ENV" in
    production) PROJECT="postmind-studio" ;;
    staging) PROJECT="postmind-studio-staging" ;;
    *) die "environment must be production or staging (got '${STUDIO_ENV}')" ;;
  esac
  ENV_FILE="${STUDIO_ENV_FILE:-$CONFIG_DIR/$STUDIO_ENV.env}"
  BACKUP_ENV_FILE="${STUDIO_BACKUP_ENV_FILE:-$CONFIG_DIR/$STUDIO_ENV.backup.env}"
  SECRETS_DIR="${STUDIO_SECRETS_DIR:-$CONFIG_DIR/secrets/$STUDIO_ENV}"
  PRODUCTION_ENV_FILE="${STUDIO_PRODUCTION_ENV_FILE:-$CONFIG_DIR/production.env}"
  TAGS_FILE="$STATE_DIR/$STUDIO_ENV/deployed-tags"
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy deploy/vps/.env.example, runbooks/vps-deploy.md)"
  [ -f "$BACKUP_ENV_FILE" ] || die "missing $BACKUP_ENV_FILE (copy deploy/vps/backup.env.example)"
  local file_env
  file_env="$(env_get STUDIO_ENV "$ENV_FILE")"
  [ "$file_env" = "$STUDIO_ENV" ] ||
    die "$ENV_FILE says STUDIO_ENV=${file_env:-<empty>}, expected $STUDIO_ENV"
  export STUDIO_ENV_FILE="$ENV_FILE" STUDIO_BACKUP_ENV_FILE="$BACKUP_ENV_FILE"
  export STUDIO_SECRETS_DIR="$SECRETS_DIR" STUDIO_STATE_DIR="$STATE_DIR"
}

# The profiles this environment runs, from its env file.
vps_profiles() {
  local args=()
  [ "$(env_get STUDIO_MONITORING "$ENV_FILE")" = "on" ] && args+=(--profile monitoring)
  [ "$(env_get HEADLESS_RENDER "$ENV_FILE")" = "on" ] && args+=(--profile headless-render)
  printf '%s\n' "${args[@]+"${args[@]}"}"
}

# The tag currently deployed (last line of the tags file), or empty.
current_tag() {
  [ -f "$TAGS_FILE" ] || return 0
  tail -n 1 "$TAGS_FILE" | awk '{print $2}'
}

# The tag deployed before the current one, or empty.
previous_tag() {
  [ -f "$TAGS_FILE" ] || return 0
  awk '{print $2}' "$TAGS_FILE" | awk -v cur="$(current_tag)" '$0 != cur {prev=$0} END {print prev}'
}

# app_compose ARGS… — docker compose for this environment's project. IMAGE_TAG must be exported
# (deploy.sh sets the new one; compose.sh uses the deployed one).
app_compose() {
  docker compose -p "$PROJECT" \
    -f "$DEPLOY_DIR/compose.yml" \
    --env-file "$ENV_FILE" \
    --env-file "$BACKUP_ENV_FILE" \
    "$@"
}

# edge_compose ARGS… — the shared Caddy project, interpolated from the production env file (or this
# environment's when production has none yet).
edge_compose() {
  local env_file="$PRODUCTION_ENV_FILE"
  [ -f "$env_file" ] || env_file="$ENV_FILE"
  docker compose -p "$EDGE_PROJECT" -f "$DEPLOY_DIR/compose.edge.yml" --env-file "$env_file" "$@"
}

# post_ops_alert <summary> <resolve:true|false> — tells a human. Alertmanager (when this
# environment runs monitoring) gets a StudioOpsCheckFailed alert (severity ticket → Slack, see
# ops/alertmanager/alertmanager.yml); otherwise OPS_ALERT_WEBHOOK_URL gets {"text": …}. Never fails
# the caller: an unreachable alert channel is logged.
post_ops_alert() {
  local summary="$1" resolve="${2:-false}" check="${3:-ops}" now ends port url
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$resolve" = "true" ]; then ends="$now"; else ends="$(date -u -d '+25 hours' +%Y-%m-%dT%H:%M:%SZ)"; fi
  # Drop quotes and backslashes so the summary cannot break the hand-built JSON below.
  summary="$(printf '%s' "$summary" | sed 's/["\\]//g' | tr '\n' ' ')"
  if [ "$(env_get STUDIO_MONITORING "$ENV_FILE")" = "on" ]; then
    port="$(env_get ALERTMANAGER_HOST_PORT "$ENV_FILE")"
    if curl -fsS --max-time 10 -H 'content-type: application/json' \
      -d "[{\"labels\":{\"alertname\":\"StudioOpsCheckFailed\",\"severity\":\"ticket\",\"check\":\"${check}\",\"environment\":\"${STUDIO_ENV}\"},\"annotations\":{\"summary\":\"${summary}\"},\"endsAt\":\"${ends}\"}]" \
      "http://127.0.0.1:${port:-9093}/api/v2/alerts" >/dev/null; then
      return 0
    fi
    log "could not reach Alertmanager on 127.0.0.1:${port:-9093}"
  fi
  [ "$resolve" = "true" ] && return 0
  url="$(env_get OPS_ALERT_WEBHOOK_URL "$ENV_FILE")"
  if [ -z "$url" ]; then
    log "no alert channel (STUDIO_MONITORING=off and OPS_ALERT_WEBHOOK_URL empty): $summary"
    return 0
  fi
  curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d "{\"text\":\"[postmind-studio ${STUDIO_ENV}] ${summary}\"}" "$url" >/dev/null ||
    log "could not post to OPS_ALERT_WEBHOOK_URL"
}
