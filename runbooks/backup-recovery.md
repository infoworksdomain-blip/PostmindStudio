# Backup and recovery (playbook E-12)

Studio owns the `studio` schema, the S3 buckets, and Redis DB 3. It shares the Postgres cluster and
the Redis instance with PostMind Core, and **never modifies Core's schema**. The cluster-level
backups are owned by DevOps. This runbook covers the Studio-specific checks.

| Store | Backup | Studio recovery notes |
| --- | --- | --- |
| Postgres on the single server (primary, [vps-deploy.md](vps-deploy.md)) | **pgBackRest** in the Postgres container: continuous WAL archiving (`archive_timeout = 60`, so at most about a minute of writes at risk) plus a nightly base backup (full on Sundays, differential otherwise) to `s3://<S3_BACKUP_BUCKET>/postgres/<env>/` on R2, encrypted client-side (aes-256-cbc). Time-based retention of 22 days (`PG_BACKUP_RETENTION_DAYS`, max 22): with weekly fulls the oldest data kept is at most 22 + 7 + 1 = 30 days old. See "Postgres on the single server" below. | Drill: `scripts/vps/pg-restore.sh <env> snapshot / drill / check / cleanup` (restores into a separate `postgres-restore` container; the live database is untouched). Incident: `pg-restore.sh <env> in-place '<time>' --yes`. |
| Postgres on a managed service (Render alternative) | Managed point-in-time recovery (PITR), with at least 7 days of retention. **Render:** continuous PITR on paid Postgres, 7 days on a Pro workspace (3 on Hobby), plus on-demand logical exports kept 7 days ([Render docs](https://render.com/docs/postgresql-backups)). | Restore to a new instance at the target time, verify it, then cut over. Migrations are forward-only, so the restored schema matches the image that ran at that time. Render cut-over: [render-deploy.md](render-deploy.md) step 11. |
| S3 buckets (`STORAGE_PROVIDER=s3`) | Versioning enabled, with lifecycle rules for noncurrent versions (kept 30 days). For deletes older than that, the daily backup copy below. | Restore objects by version id within 30 days, otherwise from the backup bucket. Renders are immutable, so restoring overwrites nothing. |
| R2 buckets (`STORAGE_PROVIDER=r2`) | **No versioning on R2**: a deleted object cannot be restored from R2 itself. The daily backup copy (below) keeps it. | Copy objects back from the backup bucket (below). |
| Redis DB 3 (BullMQ, idempotency keys, OAuth state) | AOF persistence or snapshots. Single server: Valkey with `appendonly yes`, `appendfsync everysec` and RDB snapshots on its volume. Render Key Value: `persistenceMode: journal-snapshot`, AOF every second plus snapshots. | Treat Redis as rebuildable. After a loss, re-enqueue the active projects (see below). Idempotency keys expire anyway. |

## Postgres on the single server (pgBackRest → R2)

**Why pgBackRest, not WAL-G** (sources read 2026-09-29):

- WAL-G has an open issue, [wal-g#2550](https://github.com/wal-g/wal-g/issues/2550) (opened
  2026-09-10), "wal-push hangs indefinitely against Cloudflare R2". A hanging `archive_command`
  stops archiving and fills the disk with WAL.
- pgBackRest runs against R2 in production. Its one R2-specific problem, HTTP 429 during the
  archive check ([pgbackrest#2655](https://github.com/pgbackrest/pgbackrest/issues/2655)), was fixed
  by "Add HTTP retries for 408 and 429 errors" in v2.57.0 ([release notes](https://pgbackrest.org/release.html)).
  The PostgreSQL apt repository ships 2.59.x for bookworm, and the official postgres:17 image (the
  base of `pgvector/pgvector:0.8.6-pg17`) already has that repository configured, so the image adds
  it with one `apt-get install` (`deploy/vps/postgres/Dockerfile`).
- pgBackRest has native day-based retention that also expires the WAL, client-side encryption, and
  reads every option from `PGBACKREST_*` environment variables ([command reference](https://pgbackrest.org/command.html)).

**Configuration** (`deploy/vps/compose.yml` service `postgres`, `deploy/vps/postgres/postgresql.conf`):

- `archive_command = 'pgbackrest --stanza=studio archive-push %p'`, `wal_level = replica`,
  `archive_mode` from `PG_BACKUPS` (on by default), `archive_timeout = 60` ("a minute or so are
  usually reasonable", [PostgreSQL 17 docs](https://www.postgresql.org/docs/17/continuous-archiving.html)).
- Repository: `repo1-type=s3`, endpoint `<R2_ACCOUNT_ID>.eu.r2.cloudflarestorage.com` (a
  jurisdiction bucket is only reachable through its jurisdiction endpoint,
  [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)), region `auto`
  ("the region for an R2 bucket is `auto`", [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)),
  path-style URIs, path `/postgres/<env>` inside `S3_BACKUP_BUCKET`. The object backup copy uses
  the `assets/`, `renders/` and `thumbnails/` prefixes of the same bucket and lists only those, so
  the two never touch each other's objects.
- Credentials: the backup job's R2 token and `PG_BACKUP_CIPHER_PASS`, from
  `/etc/postmind-studio/<env>.backup.env`, which only the `postgres` and `backup-storage` containers
  receive. **Keep the cipher passphrase in the password manager**: the backups are useless without
  it, and it must never change for an existing repository.
- Retention: `repo1-retention-full-type=time`, `repo1-retention-full=22`. pgBackRest removes a full
  backup older than that only once a newer full backup is itself at least that old, and expires the
  WAL older than the oldest remaining full ([configuration reference](https://pgbackrest.org/configuration.html)).
  With a full backup every Sunday that bounds everything in the repository to about 30 days
  (22 + 7 + 1), which is the purge promise below. `deploy.sh` refuses more than 22.
- Schedule: `postmind-backup@<env>.timer`, 02:30 UTC daily (`scripts/vps/install-timers.sh`), runs
  `scripts/vps/backup.sh <env>`: `pgbackrest --type=full|diff backup`, then `pgbackrest check`,
  then the object backup copy. Each deploy runs `stanza-create` (a no-op once it exists) and
  `check`, so a broken archive stops the deploy.
- Failures: the timer's service fails (`journalctl -u postmind-backup@<env>`), and the script posts
  to Alertmanager (`StudioOpsCheckFailed`) or `OPS_ALERT_WEBHOOK_URL`. A failed `check` means WAL
  is not reaching R2 and is piling up in the Postgres volume: fix it the same day.
- Look at the repository: `bash scripts/vps/backup.sh <env> info`.

**Restore drill** (quarterly, and GATE 12 step 14.7 — on staging):

```bash
bash scripts/vps/pg-restore.sh staging snapshot                        # row counts of the live db
bash scripts/vps/pg-restore.sh staging drill '2026-10-01 09:00:00+00'  # note the start time it prints
bash scripts/vps/pg-restore.sh staging check --incident-at <ISO> --restore-started-at <ISO>
bash scripts/vps/pg-restore.sh staging cleanup
```

`drill` runs `pgbackrest --type=time --target=<time> --target-action=promote restore` into a fresh
volume of the `postgres-restore` service (archiving off, so it never writes into the live
repository), starts it and waits until it has promoted. `check` runs
`scripts/ops/staging-gate.ts --restore-check` with `DATABASE_URL` pointed at that copy (migrate
status, row counts against the snapshot, pgvector, read-only smoke, RTO/RPO); the report is in
`/var/lib/postmind-studio/staging/results/`.

**Real incident, in place:** engage the kill switch, then
`bash scripts/vps/pg-restore.sh production in-place '<time>' --yes`. It stops web and the worker,
stops Postgres, runs `pgbackrest --delta --type=time --target=<time> --target-action=promote
restore` on the live volume, starts Postgres and waits for the promotion (a new timeline, archived
as usual), starts web and the worker, and takes a full backup. Verify the golden path, then release
the kill switch. Pick a time **before** the incident; RPO is the gap to the last archived WAL
(about a minute).

## Object storage backup copy (Phase 17.5)

R2 does not implement bucket versioning (https://developers.cloudflare.com/r2/api/s3/api/), and
S3 keeps noncurrent versions for 30 days only. A daily job therefore copies the live buckets into a
separate **backup bucket**: `scripts/ops/backup-storage.ts` (logic in
`src/lib/studio/ops/storage-backup*.ts`). On the single server the nightly
`postmind-backup@<env>.timer` runs it (service `backup-storage` of `deploy/vps/compose.yml`, after
the Postgres backup, from 02:30 UTC); on Render the cron job `studio-backup-storage-<env>` runs it at
03:30 UTC ([render-deploy.md](render-deploy.md)). It works on S3 and R2 through the storage client
factory and needs no database.

- **What is backed up.** The assets, renders and thumbnails buckets (`S3_BUCKET_*`), into **one**
  backup bucket (`S3_BACKUP_BUCKET`) under a prefix per bucket: `assets/<key>`, `renders/<key>`,
  `thumbnails/<key>`. One bucket means one token scope and one set of bucket rules per environment.
  The library is not included by default (it can be re-ingested from the corpus manifest); add it
  with `--only assets,renders,thumbnails,library`. Objects written to the 15.E9 fallback buckets
  during a primary outage are **not** backed up while they stay there. Consolidate them into the
  primaries after the outage ([storage-failover.md](storage-failover.md) "After an outage"); the
  next run then copies them.
- **How.**
  - Incremental: both buckets are listed. An object is copied when its copy is missing, has another
    size, or has another ETag *and* is older than the source.
  - Server-side `CopyObject` when the backup bucket is behind the same endpoint (same AWS region, or
    same R2 account and jurisdiction; `S3_BACKUP_REGION` empty / `auto`). Otherwise each object is
    streamed GET → PUT through the job.
  - Deletes are never propagated at once (see retention).
  - Dry run by default; the cron job passes `--apply`.
- **Credentials.** The job uses its own key pair (`S3_BACKUP_ACCESS_KEY_ID` /
  `S3_BACKUP_SECRET_ACCESS_KEY`): read on the live buckets, read and write on the backup bucket.
  The **app token has no access to the backup bucket**, so a leaked app token, or a bug, cannot
  delete the backups ([r2-setup.md](r2-setup.md) step 7). On S3: an IAM user or role with
  `s3:ListBucket` + `s3:GetObject` on the live buckets and `s3:ListBucket`, `s3:GetObject`,
  `s3:PutObject`, `s3:DeleteObject` on the backup bucket.
- **Retention honours purges.** The organisation hard delete (after its 30-day grace) and the
  business purge delete data for legal reasons.
  - The purge (`src/lib/studio/services/purge-storage.ts`) deletes from the live and failover
    buckets only; it **does not** delete from the backup bucket (it runs with the app token). The
    backup copies **age out** instead.
  - The first run that finds a backup copy without its source records a *tombstone* (the time it
    was first seen missing) in `.studio-backup/state.json` in the backup bucket. When the tombstone
    is `S3_BACKUP_RETENTION_DAYS` old (default and maximum **30**; the job refuses a larger value),
    the run deletes the copy. So purged data leaves the backup at most **30 days + one day** after
    the purge deleted the live object. The same applies to lifecycle expiry (`intermediates/`,
    `library/staging/`) and the abandoned-upload sweep.
  - A source that comes back (a restore) clears its tombstone.
  - A state file that does not parse stops the job (exit 1) rather than restarting every clock.
    Fix or restore the file; never delete it to "get going again" unless you accept that the
    30-day clock restarts for copies already waiting.
  - **Do not** add a versioning rule, object lock or bucket lock to the backup bucket: a deleted
    copy must really go. On S3, create the backup bucket **without** versioning.
  - Never restore an object whose organisation has an `organisation_purges` row in `hard_deleted`.
- **Safety valve.** If a run would start the clock on more than 25 % of a bucket's copies at once
  (at least 100), or the live bucket lists empty, the job does nothing for that bucket and fails. A
  wrong `S3_BUCKET_*` name must not age the whole backup out. Check the names; when the deletes are
  real (a large purge), run once by hand with `--allow-mass-tombstone`.
- **Monitoring.** Each run logs one JSON line per bucket (`event: storage_backup_bucket`: copied,
  bytes, waiting, expired, errors) and one per run (`event: storage_backup_run`, `ok`). Any copy,
  delete or listing error, or the safety valve, exits 1: the Render cron run shows **Failed** and
  the workspace's failure notification fires. Treat a failed run as a ticket, two in a row as a
  page for DevOps.
- **Run by hand.** Single server: `bash scripts/vps/backup.sh <env> storage` (with `--apply`), or
  a dry run with `bash scripts/vps/compose.sh <env> run --rm backup-storage node --import tsx
  scripts/ops/backup-storage.ts`. Render: from the `studio-backup-storage-<env>` **Shell**, or
  anywhere with the same env:

  ```bash
  npx tsx scripts/ops/backup-storage.ts            # dry run: what would be copied / aged out
  npx tsx scripts/ops/backup-storage.ts --apply
  ```

- **Restore.** Find the row's `s3Bucket` / `s3Key`, then copy `<prefix>/<s3Key>` from the backup
  bucket back to `<s3Key>` in the live bucket (prefix = `assets`, `renders` or `thumbnails` for
  that bucket), for example with the AWS CLI pointed at the endpoint:
  `aws s3 cp s3://<backup>/assets/<key> s3://<live>/<key> --endpoint-url https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.
  Presigned URLs work again at once; no row changes are needed. The next run clears the tombstone.
- **Do not use R2 bucket locks** on the live buckets as a substitute. They block the deletes that
  purges, the upload sweep and lifecycle expiry rely on.

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
   started. **Single server:** steps 1–3 are `scripts/vps/pg-restore.sh staging snapshot`,
   `… drill '<time>'` and `… check …` (section "Postgres on the single server" above).
   On Render: the database → **Recovery → Point-in-Time Recovery → Restore Database**.
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
