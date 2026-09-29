#!/usr/bin/env bash
# Deployment: single VPS. `docker compose` for one environment with the right project name, env
# files and the deployed IMAGE_TAG — use it instead of calling docker compose by hand.
#
#   scripts/vps/compose.sh production ps
#   scripts/vps/compose.sh production logs -f --tail 200 worker
#   scripts/vps/compose.sh production exec postgres psql -U studio -d postmind_studio
#   scripts/vps/compose.sh production run --rm ops node --import tsx scripts/ops/redrive.ts stuck
#   scripts/vps/compose.sh edge logs caddy                 # the shared Caddy project
set -euo pipefail
# shellcheck source=scripts/vps/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -ge 2 ] || die "usage: scripts/vps/compose.sh <production|staging|edge> <docker compose args…>"
target="$1"
shift

if [ "$target" = "edge" ]; then
  ENV_FILE="${STUDIO_PRODUCTION_ENV_FILE:-$CONFIG_DIR/production.env}"
  PRODUCTION_ENV_FILE="$ENV_FILE"
  [ -f "$ENV_FILE" ] || ENV_FILE="$CONFIG_DIR/staging.env"
  export STUDIO_STATE_DIR="$STATE_DIR"
  edge_compose "$@"
  exit $?
fi

vps_init "$target"
tag="$(current_tag)"
[ -n "$tag" ] || die "nothing deployed to $target yet (scripts/vps/deploy.sh --env $target <tag>)"
export IMAGE_TAG="$tag"
mapfile -t profiles < <(vps_profiles)
app_compose "${profiles[@]+"${profiles[@]}"}" "$@"
