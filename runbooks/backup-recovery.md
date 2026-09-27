# Backup and recovery (playbook E-12)

Studio owns the `studio` schema, the S3 buckets, and Redis DB 3. It shares the Postgres cluster and
the Redis instance with PostMind Core, and **never modifies Core's schema**. The cluster-level
backups are owned by DevOps. This runbook covers the Studio-specific checks.

| Store | Backup | Studio recovery notes |
| --- | --- | --- |
| Postgres (the `studio` schema) | Managed point-in-time recovery (PITR), with at least 7 days of retention | Restore to a new instance at the target time, verify it, then cut over. Migrations are forward-only, so the restored schema matches the image that ran at that time. |
| S3 buckets | Versioning enabled, with lifecycle rules for noncurrent versions | Restore objects by version id. Renders are immutable, so restoring overwrites nothing. |
| Redis DB 3 (BullMQ, idempotency keys, OAuth state) | AOF persistence or snapshots | Treat Redis as rebuildable. After a loss, re-enqueue the active projects (see below). Idempotency keys expire anyway. |

## After a Redis loss

Projects in active states (see `ACTIVE_STATES` in the UI; `QUEUED` through `RENDERING`) lose their
queued jobs. Re-drive them with the generate or regenerate endpoints, which start a new `runId` so
any stale jobs are ignored. Scheduled publications are re-armed by the scheduler.

**GAP:** there is no bulk re-drive script yet. Until one exists, list the stuck projects with SQL
(`state IN (...) AND updatedAt < now() - interval '30 minutes'`) and regenerate them one by one.

## Restore drill

Quarterly:

1. Restore the `studio` schema into staging from a PITR snapshot.
2. Run `npx prisma migrate status`.
3. Boot the image against it.
4. Run the golden-path smoke.

Record the date and the restore time.
