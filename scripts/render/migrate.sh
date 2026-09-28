#!/bin/sh
# Deployment: Render. The web service's preDeployCommand (render.yaml), run through
# with-db-url.sh on a separate instance before each deploy goes live
# (https://render.com/docs/deploys#pre-deploy-command). Same steps as the compose `migrate`
# service: forward-only, expand-only migrations (runbooks/rollback.md), then the idempotent seed
# (prisma/seed.ts: system flags are insert-if-missing so an engaged kill switch is never reset;
# taxonomy is upserted by slug and never deleted; built-in presets/templates are updated in place).
# A failure here fails the deploy and the previous version keeps serving.
set -eu

npx --no-install prisma migrate deploy
npx --no-install prisma db seed
