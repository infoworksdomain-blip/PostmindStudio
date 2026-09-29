#!/usr/bin/env bash
# Deployment: single VPS — CI only (.github/workflows/ci.yml, job vps). Writes throw-away env files
# and secret files from the committed examples so `docker compose config` and the stack smoke test
# can run. Every value is a placeholder or a random value generated here; nothing real.
#
#   bash scripts/vps/ci-fixture.sh "$RUNNER_TEMP/vps"     # prints the exports to eval
set -euo pipefail

out="${1:?usage: ci-fixture.sh <out-dir>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$out/secrets/production" "$out/state/caddy/sites" "$out/state/production/results"

rand() { openssl rand -hex 24; }

set_key() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}='${value}'|" "$file"
  else
    printf "%s='%s'\n" "$key" "$value" >>"$file"
  fi
}

env="$out/production.env"
cp "$repo/deploy/vps/.env.example" "$env"
set_key "$env" STUDIO_DOMAIN studio.ci.invalid
set_key "$env" ACME_EMAIL ci@example.com
set_key "$env" POSTGRES_PASSWORD "$(rand)"
set_key "$env" METRICS_TOKEN "$(rand)"
set_key "$env" STUDIO_INTERNAL_SERVICE_TOKEN "$(rand)"
set_key "$env" POSTMIND_CORE_URL http://core.ci.invalid
set_key "$env" POSTMIND_JWKS_URL http://core.ci.invalid/.well-known/jwks.json
set_key "$env" POSTMIND_AUDIT_URL http://core.ci.invalid/api/internal/audit
set_key "$env" POSTMIND_SERVICE_TOKEN "$(rand)"
set_key "$env" STUDIO_PLATFORM_ORG_IDS ci-platform
set_key "$env" AWS_REGION eu-central-1
set_key "$env" R2_ACCOUNT_ID ci
for bucket in S3_BUCKET_ASSETS S3_BUCKET_RENDERS S3_BUCKET_THUMBNAILS S3_BUCKET_LIBRARY S3_BACKUP_BUCKET; do
  set_key "$env" "$bucket" "ci-$(printf '%s' "$bucket" | tr 'A-Z_' 'a-z-')"
done
set_key "$env" PG_BACKUPS off

backup="$out/production.backup.env"
cp "$repo/deploy/vps/backup.env.example" "$backup"
set_key "$backup" S3_BACKUP_ACCESS_KEY_ID ci
set_key "$backup" S3_BACKUP_SECRET_ACCESS_KEY "$(rand)"
set_key "$backup" PG_BACKUP_CIPHER_PASS "$(rand)"

for name in metrics-token pagerduty-routing-key slack-webhook-url; do
  printf 'ci-placeholder' >"$out/secrets/production/$name"
done
chmod 0777 "$out/state/production/results"

cat <<EOF
export STUDIO_ENV_FILE=$env
export STUDIO_BACKUP_ENV_FILE=$backup
export STUDIO_PRODUCTION_ENV_FILE=$env
export STUDIO_SECRETS_DIR=$out/secrets/production
export STUDIO_STATE_DIR=$out/state
EOF
