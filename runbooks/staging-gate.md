# Staging gate — GATE 12 checklist (Phase 14.5–14.9)

Everything here runs against **staging**, never production. Each check is one command of
`scripts/ops/staging-gate.ts`. Each run writes `ops/results/<date>-<check>.md` and `.json`. Run a
check from a shell with staging credentials, or from GitHub: **Actions → Staging gate (GATE 12) →
Run workflow**, then pick the check. The workflow uses the `staging` environment's secrets and
variables, and uploads `ops/results/` as the `staging-gate-results` artifact.

A check exits 0 on PASS, 1 on FAIL or INCOMPLETE, and 2 when `--live-providers` refuses to run
without `--confirm`.

## Before you start

- Staging runs the release under test. Record its image tag (N), and have the next build (N+1)
  ready with an expand migration (rollback.md).
- Alerting is deployed (14.3), so a breach during the gate pages someone.
- You have a platform staff JWT for staging (`STUDIO_STAFF_TOKEN`) and a JWT for a dedicated
  load-test organisation (`STUDIO_TOKEN`).
- You have a read-only role on the staging database (`STAGING_DATABASE_URL`). It times the scoped
  kill-switch levels and is the source for the restore snapshot. **On the single server**
  ([vps-deploy.md](vps-deploy.md) section 9) Postgres is private to the Docker network: run the
  DB-backed checks (4, 7, 8) on the server through the `ops` service
  (`bash scripts/vps/compose.sh staging run --rm ops …`, and `scripts/vps/pg-restore.sh` for 7–8).
  On Render the database accepts
  private-network connections only, so run the DB-backed checks (4, 7, 8) from the
  `studio-web-staging` **Shell**, or add the machine's IP to the database's inbound IP rules for
  the session and remove it afterwards ([render-deploy.md](render-deploy.md)).
- `k6` is installed (https://grafana.com/docs/k6/latest/set-up/install-k6/), or `K6_BIN` points
  at it. The workflow installs it for you.

## Order

Run the checks in this order. Each step says who runs it.

| # | Check | Command | Who |
| --- | --- | --- | --- |
| 1 | Live providers: estimate only | `npm run gate:live` | Operator |
| 2 | Live providers + posts (14.8) | `npm run gate:live -- --confirm` | Operator, with staging keys and platform test accounts |
| 3 | k6 smoke (14.5) | `npx tsx scripts/ops/staging-gate.ts --k6 smoke` | Operator |
| 4 | Kill switch, all five levels, under load (14.6) | `npx tsx scripts/ops/staging-gate.ts --rehearse kill-switch` | Operator |
| 5 | Rollback N+1 → N (14.6) | `npx tsx scripts/ops/staging-gate.ts --rehearse rollback --from-tag <N> --to-tag <N+1>` | Operator + DevOps (deploy access) |
| 6 | k6 full profile (14.5) | `npx tsx scripts/ops/staging-gate.ts --k6 full` | Operator |
| 7 | Restore snapshot (14.7) | `DATABASE_URL=<staging> npx tsx scripts/ops/staging-gate.ts --snapshot` | DevOps |
| 8 | PITR restore, then verify (14.7) | `DATABASE_URL=<restored> npx tsx scripts/ops/staging-gate.ts --restore-check --incident-at <ISO> --restore-started-at <ISO>` | DevOps |
| 9 | Corpus pre-flight, sample (14.9) | `npx tsx scripts/ops/staging-gate.ts --corpus-preflight corpus.csv --sample 100` | Operator |
| 10 | Corpus sample → review → full | runbooks/corpus-ingestion.md | Operator |

### 1–2. Live providers and posts (14.8)

`npm run gate:live` prints the plan and the cost estimate, taken from each adapter's own
`estimateCostPence`. Nothing is spent. Add `--confirm` to run the plan:

- Every GATE 2 script: `npm run gate2:anthropic|runway|luma|heygen|elevenlabs|shotstack|router`.
- Adapter tests for the providers that have no script: ElevenLabs Music, Hive (synchronous),
  AssemblyAI, OpenAI image and embedding, and Storyblocks SFX. These run through the same tracked
  harness, so rows appear in `provider_jobs`.
- ElevenLabs Instant Voice Clone from `LIVE_TEST_VOICE_SAMPLE_PATH`, deleted straight away. Use a
  recording you have consent to clone.
- One real post per configured platform, using the test account's `LIVE_<PLATFORM>_ACCESS_TOKEN`
  and `LIVE_<PLATFORM>_ACCOUNT_ID`, plus the video at `LIVE_TEST_VIDEO_PATH` and
  `LIVE_TEST_VIDEO_URL`. TikTok posts `SELF_ONLY` and YouTube posts `private`. Each post is then
  taken down through the platform's delete API. **TikTok has no delete API:** the report says
  "REMOVE IT BY HAND". Do that in the test account straight away.

`--only runway,tiktok` narrows the run. `--no-posts` and `--no-providers` skip one half. Tests
whose env is missing are listed as SKIPPED, and the verdict is then INCOMPLETE.

Follow up by hand, as the report lists: the Hive async path (a render over 90 s through the
pipeline) and `npm run gate3`.

### 3 and 6. k6 (14.5)

Env: `BASE_URL`, `STUDIO_TOKEN`, and optionally `WRITES=1` + `BUSINESS_ID` (draft projects only)
and `TARGET_VUS`. Also set `METRICS_URL` + `METRICS_TOKEN` to measure queue throughput during the
run against spec 17.2 (500 projects and 4,000 publications a day).

The script re-checks the thresholds from k6's `--summary-export`:

- p95 < 300 ms (spec 17.1)
- p99 < 2 s
- read p95 < 300 ms
- write p95 < 500 ms
- errors < 0.1%
- checks > 99.9%

It also records k6's exit code (99 means a threshold was crossed). After the full run, tune the
`StudioQueueBacklog` and failure-rate alert thresholds (`ops/prometheus/studio-alerts.yml`) from
the measured values.

### 4. Kill switch (14.6)

Put staging under load first: run the k6 smoke, a few real generations, and scheduled posts on
the rehearsed platform. Levels run least-disruptive first: provider → platform → project →
workspace → global. The switch is released after every level, even when something fails.

Targets come from flags or env:

- `--provider` / `REHEARSE_PROVIDER` (default `runway`).
- `--platform` / `REHEARSE_PLATFORM` (default `tiktok`).
- `--project` / `REHEARSE_PROJECT_ID`.
- `--workspace` / `REHEARSE_WORKSPACE_ID` (the load-test organisation).

How each level is measured:

- **Global:** the time until `studio_queue_jobs{state="active"}` reaches 0 on every queue
  (`METRICS_URL`).
- **Workspace, project, provider:** from `provider_jobs` in `STAGING_DATABASE_URL`. The time is
  when the last in-scope job *started* after the switch was engaged. The level must then stay
  quiet for 30 s inside the observation window (`--observe-seconds`, default 90).
- **Platform:** the same, from `video_publications` moving to PUBLISHING or PUBLISHED. In-flight
  publishing must also reach 0. The publish queue gauge is recorded next to it.

A level with no in-scope work in the 5 minutes before it was engaged reports **INCOMPLETE**,
because an idle scope proves nothing. Without `STAGING_DATABASE_URL`, the scoped levels are
engaged and released but not timed (INCOMPLETE).

### 5. Rollback (14.6)

`STAGING_DEPLOY_CMD` is your deploy command with `{tag}` in it. For example:

- **Single server (primary):** `bash scripts/vps/deploy.sh --env staging --ssh deploy@<ip> {tag}`,
  where `{tag}` is the commit SHA of an image CI pushed to GHCR. It runs `scripts/vps/deploy.sh` on
  the server over SSH: pull, migrate, web, worker, Caddy, and it exits 0 only once
  `/api/health/ready` answers inside the container and through Caddy, so the wait below starts
  on the new release. In GitHub Actions the workflow installs the SSH key from the `staging`
  environment (secret `VPS_SSH_PRIVATE_KEY`, variable `VPS_SSH_KNOWN_HOSTS`) before the check
  runs ([vps-deploy.md](vps-deploy.md) section 9). Staging must be switched on first.
- `IMAGE_TAG={tag} docker compose -f docker-compose.prod.yml up -d --no-deps web worker-orchestration …`
- `./deploy-staging.sh {tag}` for ECS or Kubernetes, which should wait for the rollout.
- **Render:** `npx tsx scripts/render/deploy.ts {tag}`, where `{tag}` is the git commit SHA.
  Set `RENDER_API_KEY` (Render **Account settings → API Keys**) and
  `RENDER_DEPLOY_SERVICE_IDS` (the staging `srv-…` ids, web first, then the six workers). It
  uses the Render API (`POST /v1/services/{id}/rollback` when a retained build of that commit
  exists, otherwise `POST /v1/services/{id}/deploys` with `commitId`), deploys the web service
  first and waits until every service is `live`. The command must wait: on Render the old
  instances keep answering `/api/health/ready` until the new ones take over, so readiness alone
  cannot tell that a deploy finished. Neither API call turns auto-deploy off, so set the staging
  services' **Auto-Deploy** to **Off** for the rehearsal and back to **After CI Checks Pass**
  afterwards. In GitHub Actions add both as `staging` environment secrets, and set
  `STAGING_DEPLOY_CMD` to the command above.

The script deploys N+1 and waits for `/api/health/ready` (or `STAGING_READY_URL`) to answer 200
three times in a row. Then it rolls back to N and times from the start of the rollback to ready,
against the **5 min SLO**. After that, finish the manual steps in rollback.md: check that N runs on
the N+1 schema, then redeploy N+1.

### 7–8. Point-in-time restore (14.7)

1. `--snapshot` records every `studio` table's row count and the latest write, in
   `ops/results/restore-snapshot.json` (or `--snapshot-file`).
2. DevOps restores to a new instance at the target time (backup-recovery.md). **On the single
   server** the whole of 14.7 is three commands on the server, and the live staging database is
   not touched:
   ```bash
   bash scripts/vps/pg-restore.sh staging snapshot                        # step 1 (live db)
   bash scripts/vps/pg-restore.sh staging drill '2026-10-01 09:00:00+00'  # restore into postgres-restore
   bash scripts/vps/pg-restore.sh staging check --incident-at <ISO> --restore-started-at <ISO>
   bash scripts/vps/pg-restore.sh staging cleanup
   ```
   `check` runs this script's `--restore-check` with `DATABASE_URL` pointed at the restored copy;
   reports land in `/var/lib/postmind-studio/staging/results/`. On Render: the
   database → **Recovery → Point-in-Time Recovery** ([render-deploy.md](render-deploy.md) step 11).
   Render Postgres accepts private-network connections only (`ipAllowList: []`), so run the
   snapshot and the check from the `studio-web-staging` **Shell**, with the database URL built by
   the wrapper:
   `RENDER_POSTGRES_URL=<restored internal URL> sh scripts/render/with-db-url.sh npx tsx scripts/ops/staging-gate.ts --restore-check …`.
   The GitHub workflow cannot reach it unless you allow-list the runner.
3. `--restore-check` against the restored `DATABASE_URL` runs these checks:
   - `prisma migrate status` must be up to date.
   - Row counts are compared with the snapshot. A table that was emptied or is missing fails.
   - pgvector must be present and a cosine query must work (`vector-sql.ts`).
   - A read-only smoke runs, with every query in a `READ ONLY` transaction.
   - RPO is recorded (`--incident-at` or `--restore-target` minus the latest restored write), and
     so is RTO (`--restore-started-at` to verified).
4. Then boot the image against the restored database and run the golden-path smoke before any
   cut-over.

In GitHub, run `restore-snapshot` first. Then run `restore-check` with `snapshot_run_id` set to
that run's id, and with the `RESTORED_DATABASE_URL` environment secret pointing at the restored
instance.

### 9–10. Corpus (14.9)

`--corpus-preflight` wraps `ingest-corpus.ts <manifest> --preflight`. It checks:

- the admin API and taxonomy
- `STUDIO_LIBRARY_PLAN_TIER` (ENTERPRISE for the full run)
- library worker slots, compared with the runbook's throughput table
- the storage provider (`STORAGE_PROVIDER`: S3, or Cloudflare R2 and its endpoint); an invalid
  configuration fails here
- write access to `S3_BUCKET_LIBRARY`
- the `STUDIO_CORPUS_S3_BUCKETS` allow-list, plus HEAD probes of up to 20 s3:// sources
- manifest validation

The bucket probes use the same storage client as the workers.

- **On R2:** `s3://bucket/key` sources must be R2 buckets in the same account and jurisdiction,
  readable with the app's R2 token.
- **In GitHub Actions:** set these alongside the AWS ones in the `staging` environment
  ([r2-setup.md](r2-setup.md)):
  - variables `STORAGE_PROVIDER=r2`, `R2_ACCOUNT_ID` and `R2_JURISDICTION`;
  - secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

  The AWS variables stay for KMS. The live `openai-image` test also writes to storage, and it asks
  for the R2 variables instead of `AWS_REGION` when `STORAGE_PROVIDER=r2`.

Run it with the **library workers' env**. Start the manifest from `corpus/manifest.template.csv`,
then follow corpus-ingestion.md: sample, review with its checklist, re-run the pre-flight without
`--sample`, then the full run.

## Results (fill in)

| # | Check | Date | Operator | Result | Measured | Report |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | Live providers + posts | | | | cost £ | |
| 3 | k6 smoke | | | | p95 ms / errors % | |
| 4a | Kill switch — provider | | | | s (SLO 60) | |
| 4b | Kill switch — platform | | | | s (SLO 60) | |
| 4c | Kill switch — project | | | | s (SLO 60) | |
| 4d | Kill switch — workspace | | | | s (SLO 60) | |
| 4e | Kill switch — global | | | | s (SLO 60) | |
| 5 | Rollback N+1 → N | | | | s (SLO 300) | |
| 6 | k6 full | | | | p95 ms / publications per day | |
| 8 | PITR restore check | | | | RTO s / RPO s | |
| 9 | Corpus pre-flight (sample) | | | | | |
| 10 | Corpus sample reviewed / full run | | | | videos / £ | |

Copy each row into PROGRESS.md under GATE 12 as well. Any FAIL, and any SLO breach, is a launch
blocker.
