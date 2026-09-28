# Rollback (playbook §11.4) — SLO 5 minutes

Images are immutable and tagged with the git SHA (see [deploy.md](deploy.md)). A rollback is a
redeploy of the previous tag. Never rebuild old code during an incident.

## Decide

Roll back when a release causes any of the following:

- A readiness failure.
- An error-rate spike, in Sentry or as `studio_jobs_total{outcome="failed"}` climbing.
- A p95 API breach (over 300 ms, sustained for 10 minutes).
- A broken golden path.

If customers could be harmed while the rollback runs (bad publishing, runaway cost), **engage the
kill switch first** ([kill-switch.md](kill-switch.md)).

## Roll back

```bash
PREV=<previous good sha>   # from the deploy log / registry
IMAGE_TAG=$PREV docker compose -f docker-compose.prod.yml up -d --no-deps \
  web worker-orchestration worker-assets worker-publish worker-scheduled worker-analytics worker-library
```

On ECS or Kubernetes, point the service or deployment at `:$PREV` and let the rollout finish.

Workers stop gracefully: on SIGTERM they finish in-flight jobs, with a 120 s grace period. BullMQ
retries any job that is interrupted.

## Database migrations

Migrations are **forward-only and expand/contract**. A release may add columns or tables that the
previous release ignores. It may not drop or rename anything the previous release still reads.
Destructive changes ship at least one release after the code stops using the object. This rule is
what lets the previous image run against the newer schema, so **never run `prisma migrate reset`
and never hand-revert migrations** during a rollback.

If a migration itself is broken:

1. Stop the migrate job.
2. Fix forward with a new migration.
3. Mark the failed one rolled back: `npx prisma migrate resolve --rolled-back <name>`.

## Verify

1. `/api/health/ready` returns 200 on every web replica.
2. Workers log `studio workers started`.
3. Queue depths drain.
4. Sentry's error rate returns to baseline.
5. Run the golden-path smoke on staging accounts: create a draft, generate, review, approve,
   publish.

## Rehearsal (BACKLOG 12.3) — staging

1. Deploy release N (the current release).
2. Deploy N+1, which carries a new expand migration.
3. Roll back to N and time it, from the decision to readiness green on all replicas.
4. Confirm that N runs correctly on the N+1 schema.
5. Redeploy N+1 and confirm it runs.

Steps 2–3 are automated (Phase 14.6). `STAGING_DEPLOY_CMD` is your deploy command with `{tag}`:

```bash
STUDIO_URL=https://studio-staging.postmind.ai \
STAGING_DEPLOY_CMD='IMAGE_TAG={tag} docker compose -f docker-compose.prod.yml up -d --no-deps web worker-orchestration worker-assets worker-publish worker-scheduled worker-analytics worker-library' \
npx tsx scripts/ops/staging-gate.ts --rehearse rollback --from-tag <N> --to-tag <N+1>
```

It deploys N+1 and waits for `/api/health/ready` (or `STAGING_READY_URL`) to answer 200 three
times in a row. Then it rolls back to N and times from the start of the rollback to ready, against
the 5 min SLO. The report goes to `ops/results/<date>-rehearse-rollback.md`. The same check is in
GitHub Actions: **Staging gate (GATE 12)** → `rehearse-rollback`. Steps 4–5 stay manual.

Record the times in PROGRESS.md and runbooks/staging-gate.md. **Anything over 5 minutes is a
blocker.**
