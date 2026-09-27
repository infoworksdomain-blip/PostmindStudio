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

Projects in active pipeline states (`QUEUED`, `SCANNING`, `PLANNING`, `ASSETS_QUEUED`,
`ASSETS_GENERATING`, `RENDERING`, `QUALITY_CHECKING`) lose their queued jobs and stop moving.
Re-drive them once the workers are back on the new Redis:

```bash
STUDIO_URL=... STUDIO_STAFF_TOKEN=... npx tsx scripts/ops/redrive.ts stuck --stuck-minutes 30
# review the dry run, then the same command with --apply
```

(or Admin Centre → **Re-drive** → *Stuck projects*). Each project idle for longer than
`--stuck-minutes` (default 30, minimum 10) gets the job for its **current** stage added again under
its **current** run: `plan-project`, `populate-slideshow`, `generate-asset` for each unfinished shot
(or `compose-video` when none), `compose-video` or `run-quality-gate`. Job ids are deterministic per
run, so a job that still exists is not duplicated and a repeated apply is harmless. Shots with
assets are never regenerated. A shot that was mid-generation when Redis was lost is generated
again, which may repeat that one provider call. Projects without a recorded plan tier (runs started
before this release) are skipped and listed — regenerate those from the project page.

Scheduled publications are re-armed by the scheduler.

## Restore drill

Quarterly:

1. Restore the `studio` schema into staging from a PITR snapshot.
2. Run `npx prisma migrate status`.
3. Boot the image against it.
4. Run the golden-path smoke.

Record the date and the restore time.
