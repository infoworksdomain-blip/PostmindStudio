#!/bin/sh
# Deployment: Render. Entrypoint wrapper for every Studio command on Render (web, workers and the
# pre-deploy migration): builds DATABASE_URL from Render's plain RENDER_POSTGRES_URL plus
# schema=studio, the per-service connection_limit (STUDIO_DB_CONNECTION_LIMIT) and
# application_name (src/lib/render/database-url.ts), then exec's the real command so it replaces
# this shell and receives SIGTERM from tini directly (graceful worker shutdown).
#
#   sh scripts/render/with-db-url.sh npx next start -p 3010
#   sh scripts/render/with-db-url.sh npx tsx scripts/worker.ts studio-assets
#
# The URL is held in a variable only; nothing here echoes it. `set -e` stops before exec if the
# URL cannot be built (missing or malformed RENDER_POSTGRES_URL), so the deploy fails loudly.
set -eu

if [ "$#" -eq 0 ]; then
  echo "with-db-url: no command given" >&2
  exit 64
fi

DATABASE_URL="$(npx --no-install tsx scripts/render/database-url.ts)"
export DATABASE_URL

exec "$@"
