# Backup and recovery (playbook E-12)

Studio owns the `studio` schema, the S3 buckets, and Redis DB 3. It shares the Postgres cluster and
the Redis instance with PostMind Core, and **never modifies Core's schema**. The cluster-level
backups are owned by DevOps. This runbook covers the Studio-specific checks.

| Store | Backup | Studio recovery notes |
| --- | --- | --- |
| Postgres (the `studio` schema) | Managed point-in-time recovery (PITR), with at least 7 days of retention. **Render:** continuous PITR on paid Postgres, 7 days on a Pro workspace (3 on Hobby), plus on-demand logical exports kept 7 days ([Render docs](https://render.com/docs/postgresql-backups)). | Restore to a new instance at the target time, verify it, then cut over. Migrations are forward-only, so the restored schema matches the image that ran at that time. Render cut-over: [render-deploy.md](render-deploy.md) step 11. |
| S3 buckets (`STORAGE_PROVIDER=s3`) | Versioning enabled, with lifecycle rules for noncurrent versions | Restore objects by version id. Renders are immutable, so restoring overwrites nothing. |
| R2 buckets (`STORAGE_PROVIDER=r2`) | **No versioning on R2**: a deleted object cannot be restored from R2 itself. A separate backup copy is needed (below). | Copy objects back from the backup bucket. The key is on the row (`s3Key`), so restoring is a copy of the same key into the same bucket. |
| Redis DB 3 (BullMQ, idempotency keys, OAuth state) | AOF persistence or snapshots (Render Key Value: `persistenceMode: journal-snapshot`, AOF every second plus snapshots) | Treat Redis as rebuildable. After a loss, re-enqueue the active projects (see below). Idempotency keys expire anyway. |

## R2: recovering deleted objects (no versioning)

R2 does not implement bucket versioning (https://developers.cloudflare.com/r2/api/s3/api/). On
R2, the only way to recover a deleted object is from a backup copy that DevOps keeps outside the
live buckets.

- **What to back up.** Studio keys are write-once: uuid or content-hash names, and renders are
  never overwritten. Losses therefore come from deletes, not overwrites. Back up the assets,
  renders and thumbnails buckets. The library can be re-ingested from the corpus manifest.
- **How.** Copy the objects on a schedule (daily is enough for the RPO above) into a backup R2
  bucket in the same jurisdiction, under a separate token.
  - Use any S3-compatible sync tool pointed at `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.
  - Copy new keys only. Never propagate deletes immediately.
  - The app token must not be able to delete from the backup bucket.
- **Retention must honour purges.** The organisation hard delete (30-day grace) and the business
  purge delete data for legal reasons.
  - Expire backup copies after at most 30 days with a lifecycle rule on the backup bucket, so
    purged data ages out of the backup too.
  - Never restore an object whose organisation has an `organisation_purges` row in `hard_deleted`.
- **Do not use R2 bucket locks** on the live buckets as a substitute. They block the deletes that
  purges, the upload sweep and lifecycle expiry rely on.
- **Restore.** Find the row's `s3Bucket` / `s3Key`, then copy that key from the backup bucket back
  into the live bucket. Presigned URLs work again at once; no row changes are needed.
- **Status: GAP.** The backup job itself is DevOps tooling and is not part of this repo.

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

Quarterly (the first drill is GATE 12, Phase 14.7):

1. Before restoring, snapshot the source's row counts:
   `DATABASE_URL=<staging> npx tsx scripts/ops/staging-gate.ts --snapshot`. This writes
   `ops/results/restore-snapshot.json`.
2. Restore the `studio` schema into a new instance from PITR at the target time. Note when you
   started. On Render: the database → **Recovery → Point-in-Time Recovery → Restore Database**.
   Render creates a new instance and cannot restore to within 10 minutes of now.
   Steps 1 and 3 run from the web service **Shell** (the database is private), with
   `sh scripts/render/with-db-url.sh` in front of the command and `RENDER_POSTGRES_URL` set to the
   instance to check.
3. Verify the restored instance:

   ```bash
   DATABASE_URL=<restored> npx tsx scripts/ops/staging-gate.ts --restore-check \
     --incident-at <restore point, ISO> --restore-started-at <when you began, ISO>
   ```

   It runs these checks:
   - `prisma migrate status` must be up to date.
   - Row counts are compared with the snapshot. An emptied or missing table fails.
   - pgvector is checked through `src/lib/studio/vector-sql.ts`.
   - A read-only smoke runs, with each query in a `READ ONLY` transaction.
   - RTO and RPO are recorded.

   The report goes to `ops/results/<date>-restore-check.md`.
4. Boot the image against the restored database and run the golden-path smoke.

Record the date, RTO and RPO in PROGRESS.md and in the results table of
[staging-gate.md](staging-gate.md). In GitHub Actions, run **Staging gate (GATE 12)** →
`restore-snapshot`, then `restore-check` with `snapshot_run_id`.
