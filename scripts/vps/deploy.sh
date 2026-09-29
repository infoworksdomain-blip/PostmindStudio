#!/usr/bin/env bash
# Deployment: single VPS (runbooks/vps-deploy.md). Deploys one image tag (the git SHA CI pushed to
# GHCR) to one environment on the server, in this order:
#   preflight → pull image → Caddy up → Postgres + Redis up → pgBackRest stanza + check → migrate + seed →
#   web → worker (or --workers-first) → optional profiles → Caddy site + reload →
#   wait for /api/health/ready (inside, then through Caddy) → record the tag.
# The previous tag stays recorded, so `deploy.sh <previous>` (or --previous) is the rollback.
#
#   scripts/vps/deploy.sh <tag>                          production, on the server
#   scripts/vps/deploy.sh --env staging <tag>            staging project on the same server
#   scripts/vps/deploy.sh --ssh deploy@<ip> <tag>        from a laptop / CI: runs it on the server
#   scripts/vps/deploy.sh --previous                     roll back to the tag before the current one
#   scripts/vps/deploy.sh --env staging --stop           switch staging off (volumes are kept)
#
# As STAGING_DEPLOY_CMD (runbooks/staging-gate.md, rollback rehearsal):
#   scripts/vps/deploy.sh --env staging --ssh deploy@<ip> {tag}
# Exit 0 only when the release answers /api/health/ready.
set -euo pipefail
# shellcheck source=scripts/vps/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set -E # the ERR trap below also fires inside functions

READY_TIMEOUT_SEC="${STUDIO_READY_TIMEOUT_SEC:-240}"
KEEP_IMAGES="${STUDIO_KEEP_IMAGES:-3}"

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 64
}

ENV_NAME="production"
TAG=""
SSH_TARGET=""
WORKERS_FIRST=false
SKIP_EDGE_CHECK=false
STOP=false
USE_PREVIOUS=false

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env | --ssh) [ "$#" -ge 2 ] || die "$1 needs a value" ;;
    esac
    case "$1" in
      --env) ENV_NAME="$2" && shift ;;
      --ssh) SSH_TARGET="$2" && shift ;;
      --workers-first) WORKERS_FIRST=true ;;
      --skip-edge-check) SKIP_EDGE_CHECK=true ;;
      --stop) STOP=true ;;
      --previous) USE_PREVIOUS=true ;;
      -h | --help) usage ;;
      -*) die "unknown option $1" ;;
      *)
        if [ -n "$TAG" ]; then die "only one tag"; fi
        TAG="$1"
        ;;
    esac
    shift
  done
  case "$ENV_NAME" in production | staging) ;; *) die "--env must be production or staging" ;; esac
  if [ -n "$TAG" ] && ! [[ "$TAG" =~ $TAG_PATTERN ]]; then die "invalid image tag '$TAG'"; fi
}

# --ssh: run this same script on the server. Only validated values are passed on.
run_remote() {
  [[ "$SSH_TARGET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$ ]] || die "--ssh must be user@host"
  local remote_dir="${STUDIO_REMOTE_REPO_DIR:-/opt/postmind-studio}" args=(--env "$ENV_NAME")
  $WORKERS_FIRST && args+=(--workers-first)
  $SKIP_EDGE_CHECK && args+=(--skip-edge-check)
  $STOP && args+=(--stop)
  $USE_PREVIOUS && args+=(--previous)
  [ -n "$TAG" ] && args+=("$TAG")
  log "running on $SSH_TARGET: deploy.sh ${args[*]}"
  exec ssh -o BatchMode=yes "$SSH_TARGET" bash "$remote_dir/scripts/vps/deploy.sh" "${args[@]}"
}

require_value() {
  local key="$1" file="$2" pattern="$3" hint="$4" value
  value="$(env_get "$key" "$file")"
  [[ "$value" =~ $pattern ]] || die "$key in $file: $hint"
}

preflight() {
  command -v docker >/dev/null || die "docker is not installed (deploy/vps/bootstrap.sh)"
  docker compose version >/dev/null || die "the docker compose plugin is missing"
  require_value STUDIO_DOMAIN "$ENV_FILE" '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$' \
    "must be a host name like studio.example.com"
  require_value POSTGRES_PASSWORD "$ENV_FILE" '^[A-Za-z0-9]{16,}$' \
    "must be at least 16 letters/digits (openssl rand -hex 32)"
  require_value METRICS_TOKEN "$ENV_FILE" '^.{32,}$' "must be at least 32 characters"
  require_value STUDIO_INTERNAL_SERVICE_TOKEN "$ENV_FILE" '^.{32,}$' "must be at least 32 characters"
  local key mode
  for key in AWS_REGION KMS_KEY_ID R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY \
    S3_BUCKET_ASSETS S3_BUCKET_RENDERS S3_BUCKET_THUMBNAILS S3_BUCKET_LIBRARY \
    STUDIO_USD_TO_GBP_RATE; do
    require_value "$key" "$ENV_FILE" '.' "is required (deploy/vps/.env.example REQUIRED section)"
  done
  # Phase 18 §0: the mode decides the rest (the app's copy is requiredEnvForModes in src/lib/env.ts).
  mode="$(env_get STUDIO_MODE "$ENV_FILE")"
  case "${mode:-standalone}" in
    core)
      for key in POSTMIND_CORE_URL POSTMIND_JWKS_URL POSTMIND_JWT_ISSUER POSTMIND_JWT_AUDIENCE \
        POSTMIND_AUDIT_URL POSTMIND_SERVICE_TOKEN STUDIO_PLATFORM_ORG_IDS; do
        require_value "$key" "$ENV_FILE" '.' "is required when STUDIO_MODE=core"
      done
      ;;
    standalone)
      require_value BETTER_AUTH_SECRET "$ENV_FILE" '^.{32,}$' "must be at least 32 characters"
      require_value STUDIO_UNSUBSCRIBE_SECRET "$ENV_FILE" '^.{32,}$' "must be at least 32 characters"
      for key in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RESEND_API_KEY RESEND_WEBHOOK_SECRET \
        STUDIO_EMAIL_FROM; do
        require_value "$key" "$ENV_FILE" '.' "is required (deploy/vps/.env.example REQUIRED section)"
      done
      ;;
    *) die "STUDIO_MODE in $ENV_FILE must be standalone or core" ;;
  esac
  local acme_file="$PRODUCTION_ENV_FILE"
  [ -f "$acme_file" ] || acme_file="$ENV_FILE"
  require_value ACME_EMAIL "$acme_file" '^[^@[:space:]]+@[^@[:space:]]+$' "must be an email address"
  preflight_backups
  preflight_edge
  if [ "$(env_get STUDIO_MONITORING "$ENV_FILE")" = "on" ]; then
    for key in pagerduty-routing-key slack-webhook-url; do
      [ -s "$SECRETS_DIR/$key" ] || die "STUDIO_MONITORING=on needs $SECRETS_DIR/$key (vps-deploy.md step 10)"
    done
  fi
}

preflight_backups() {
  local mode days
  mode="$(env_get PG_BACKUPS "$ENV_FILE")"
  case "${mode:-on}" in on | off) ;; *) die "PG_BACKUPS must be on or off" ;; esac
  days="$(env_get PG_BACKUP_RETENTION_DAYS "$ENV_FILE")"
  days="${days:-22}"
  if ! [[ "$days" =~ ^[0-9]+$ ]] || [ "$days" -lt 1 ] || [ "$days" -gt 22 ]; then
    die "PG_BACKUP_RETENTION_DAYS must be 1-22 (weekly fulls + 22 days keeps backups within 30 days)"
  fi
  [ "${mode:-on}" = "on" ] || return 0
  require_value S3_BACKUP_BUCKET "$ENV_FILE" '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' "must be an R2 bucket name"
  require_value S3_BACKUP_ACCESS_KEY_ID "$BACKUP_ENV_FILE" '.' "is required when PG_BACKUPS=on"
  require_value S3_BACKUP_SECRET_ACCESS_KEY "$BACKUP_ENV_FILE" '.' "is required when PG_BACKUPS=on"
  require_value PG_BACKUP_CIPHER_PASS "$BACKUP_ENV_FILE" '^.{32,}$' "must be at least 32 characters"
}

preflight_edge() {
  local cidr
  for cidr in $(env_get STUDIO_INTERNAL_ALLOWED_CIDRS "$ENV_FILE"); do
    [[ "$cidr" =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ ]] || die "STUDIO_INTERNAL_ALLOWED_CIDRS: '$cidr' is not a CIDR"
  done
  for cidr in $(env_get CADDY_TRUSTED_PROXIES "$PRODUCTION_ENV_FILE"); do
    [[ "$cidr" =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ ]] || die "CADDY_TRUSTED_PROXIES: '$cidr' is not a CIDR"
  done
}

# Host files the compose file mounts. metrics-token is written from the env file each deploy; the
# two alert files are the operator's (empty placeholders keep compose's secret paths valid).
prepare_host_files() {
  mkdir -p "$SECRETS_DIR" "$STATE_DIR/caddy/sites" "$STATE_DIR/$STUDIO_ENV/results"
  chmod 0755 "$SECRETS_DIR"
  # Reports are written by the image's node user; they hold row counts, not secrets.
  chmod 0777 "$STATE_DIR/$STUDIO_ENV/results"
  local tmp="$SECRETS_DIR/.metrics-token.tmp"
  rm -f "$tmp"
  (umask 022 && env_get METRICS_TOKEN "$ENV_FILE" >"$tmp")
  chmod 0444 "$tmp" && mv -f "$tmp" "$SECRETS_DIR/metrics-token"
  local name
  for name in pagerduty-routing-key slack-webhook-url; do
    [ -e "$SECRETS_DIR/$name" ] || { : >"$SECRETS_DIR/$name" && chmod 0644 "$SECRETS_DIR/$name"; }
  done
}

image_ref() {
  local repo
  repo="$(env_get STUDIO_IMAGE "$ENV_FILE")"
  printf '%s:%s' "${repo:-ghcr.io/infoworksdomain-blip/postmind-studio}" "$1"
}

# Caddy first: its project creates the shared studio-edge network that web joins (compose.yml
# declares it external). With no site file yet it serves nothing.
start_edge() {
  log "Caddy (shared edge) up"
  edge_compose up -d --wait --wait-timeout 120 caddy
}

start_datastores() {
  log "building the Postgres image (cached after the first run)"
  app_compose build postgres
  log "starting Postgres and Redis"
  app_compose up -d --wait --wait-timeout 300 postgres redis
}

# pgBackRest: stanza-create then check, as the user guide recommends. check also proves that
# archive_command reaches R2 (it switches a WAL segment and waits for it to be archived).
ensure_backups() {
  if [ "$(env_get PG_BACKUPS "$ENV_FILE")" = "off" ]; then
    log "PG_BACKUPS=off: no WAL archiving, no point-in-time restore for $STUDIO_ENV"
    return 0
  fi
  log "pgBackRest: stanza-create (no-op when it exists) and check"
  app_compose exec -T -u postgres postgres pgbackrest stanza-create
  app_compose exec -T -u postgres postgres pgbackrest check
}

migrate() {
  log "migrating (prisma migrate deploy + seed)"
  app_compose --profile migrate run --rm migrate
}

roll_out() {
  local order=(web worker)
  $WORKERS_FIRST && order=(worker web)
  local service
  for service in "${order[@]}"; do
    log "rolling out $service"
    app_compose up -d --no-deps --wait --wait-timeout 300 "$service"
  done
  local profiles
  mapfile -t profiles < <(vps_profiles)
  if printf '%s\n' "${profiles[@]+"${profiles[@]}"}" | grep -q monitoring; then
    log "monitoring on"
    app_compose --profile monitoring up -d --wait --wait-timeout 180 prometheus alertmanager blackbox
  else
    app_compose --profile monitoring rm -sf prometheus alertmanager blackbox >/dev/null 2>&1 || true
  fi
  if printf '%s\n' "${profiles[@]+"${profiles[@]}"}" | grep -q headless-render; then
    app_compose --profile headless-render up -d browserless
  else
    app_compose --profile headless-render rm -sf browserless >/dev/null 2>&1 || true
  fi
}

# Writes STATE_DIR/caddy/sites/<env>.caddy from deploy/vps/caddy/site.caddy.tmpl and reloads Caddy.
write_site() {
  local domain cidrs site tmp
  domain="$(env_get STUDIO_DOMAIN "$ENV_FILE")"
  cidrs="$(env_get STUDIO_INTERNAL_ALLOWED_CIDRS "$ENV_FILE" | tr -s ' ')"
  site="$STATE_DIR/caddy/sites/$STUDIO_ENV.caddy"
  tmp="$site.tmp"
  if [ -n "$cidrs" ]; then
    sed -e "s|__DOMAIN__|$domain|g" -e "s|__ENV__|$STUDIO_ENV|g" -e "s|__INTERNAL_CIDRS__|$cidrs|g" \
      "$DEPLOY_DIR/caddy/site.caddy.tmpl" >"$tmp"
  else
    log "STUDIO_INTERNAL_ALLOWED_CIDRS is empty: /api/studio/internal/** is closed at the edge"
    sed -e '/not client_ip __INTERNAL_CIDRS__/d' -e "s|__DOMAIN__|$domain|g" -e "s|__ENV__|$STUDIO_ENV|g" \
      "$DEPLOY_DIR/caddy/site.caddy.tmpl" >"$tmp"
  fi
  mv -f "$tmp" "$site"
  reload_caddy
}

reload_caddy() {
  log "Caddy: start (if needed) and reload"
  edge_compose up -d --wait --wait-timeout 120 caddy
  edge_compose exec -T -w /etc/caddy caddy caddy reload --config /etc/caddy/Caddyfile
}

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SEC)) domain
  log "waiting for /api/health/ready inside the web container"
  until app_compose exec -T web node -e \
    "fetch('http://127.0.0.1:3010/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    [ "$SECONDS" -lt "$deadline" ] || die "web is not ready after ${READY_TIMEOUT_SEC}s: scripts/vps/compose.sh $STUDIO_ENV logs web"
    sleep 5
  done
  $SKIP_EDGE_CHECK && return 0
  domain="$(env_get STUDIO_DOMAIN "$ENV_FILE")"
  log "waiting for https://$domain/api/health/ready through Caddy (certificate + proxy)"
  until curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -o /dev/null \
    "https://$domain/api/health/ready"; do
    [ "$SECONDS" -lt "$deadline" ] ||
      die "not reachable through Caddy: check DNS for $domain and scripts/vps/compose.sh edge logs caddy"
    sleep 5
  done
}

record_tag() {
  mkdir -p "$(dirname "$TAGS_FILE")"
  [ "$(current_tag)" = "$TAG" ] || printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" >>"$TAGS_FILE"
}

# Removes local copies of app image tags no environment deployed recently (the disk is small).
prune_images() {
  local repo keep tag
  repo="$(image_ref x)"
  repo="${repo%:x}"
  keep="$(for f in "$STATE_DIR"/*/deployed-tags; do [ -f "$f" ] && awk '{print $2}' "$f" | tail -n "$KEEP_IMAGES"; done)"
  for tag in $(docker image ls "$repo" --format '{{.Tag}}'); do
    printf '%s\n' "$keep" | grep -qx "$tag" || docker image rm "$repo:$tag" >/dev/null 2>&1 || true
  done
}

stop_environment() {
  log "stopping $STUDIO_ENV (containers removed, volumes kept)"
  rm -f "$STATE_DIR/caddy/sites/$STUDIO_ENV.caddy"
  if docker ps --format '{{.Names}}' | grep -q '^postmind-edge-caddy'; then reload_caddy; fi
  local tag
  tag="$(current_tag)"
  export IMAGE_TAG="${tag:-stopped}"
  app_compose --profile migrate --profile ops --profile restore \
    --profile monitoring --profile headless-render down --remove-orphans
  log "$STUDIO_ENV is off. Switch it on again with: scripts/vps/deploy.sh --env $STUDIO_ENV <tag>"
}

main() {
  parse_args "$@"
  [ -z "$SSH_TARGET" ] || run_remote
  vps_init "$ENV_NAME"
  if $STOP; then
    stop_environment
    return 0
  fi
  if $USE_PREVIOUS; then
    [ -z "$TAG" ] || die "--previous takes no tag"
    TAG="$(previous_tag)"
    [ -n "$TAG" ] || die "no previous tag recorded in $TAGS_FILE"
  fi
  [ -n "$TAG" ] || usage
  local before
  before="$(current_tag)"
  log "deploying $TAG to $STUDIO_ENV (running now: ${before:-nothing})"
  trap 'log "deploy of $TAG to $STUDIO_ENV FAILED (line $LINENO); the running release is unchanged unless web/worker were already rolled out: see runbooks/vps-deploy.md Rollback"' ERR
  preflight
  prepare_host_files
  export IMAGE_TAG="$TAG"
  app_compose config --quiet
  docker pull "$(image_ref "$TAG")"
  start_edge
  start_datastores
  ensure_backups
  migrate
  roll_out
  write_site
  wait_ready
  record_tag
  prune_images
  log "DONE: $STUDIO_ENV runs $TAG."
  [ -z "$before" ] || [ "$before" = "$TAG" ] ||
    log "Rollback: scripts/vps/deploy.sh --env $STUDIO_ENV $before   (or --previous)"
}

main "$@"
