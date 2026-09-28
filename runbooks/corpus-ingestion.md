# Corpus ingestion (BACKLOG 9.2 sample run, 9.3 full run)

| | |
| --- | --- |
| **Metric** | `GET /api/studio/admin/library/ingest/status`: `counts.FAILED` against `counts.SUCCEEDED + counts.DUPLICATE` over the window, and `backlog`. |
| **Threshold** | Failure rate above 5% over 1 hour, or a backlog that stops shrinking for 1 hour while workers are up. |
| **Escalation** | On-call engineer, then the ML Engineer for analysis quality. The operator approves the sample before the full run. |

**Licence.** Operator decision, 2026-09-27: the corpus is operator-owned and needs no licence.
Every item is ingested with `licenseScenario: NOT_REQUIRED`. That allows both TEMPLATE and
INSPIRE modes. `licenseSource` records the decision as the audit trail. The default is
`Operator decision 2026-09-27: no licence required for the PostMind corpus`, and
`--license-source` overrides it (for example, to add a ticket reference). Items ingested under
LICENSED, OWNED or SCRAPED keep their existing gating: SCRAPED allows INSPIRE only, and expired
licences are refused.

## Tools

- `scripts/ops/ingest-corpus.ts` reads a CSV or JSONL manifest. It is a dry run by default and
  submits only with `--apply`. It needs `STUDIO_URL` and `STUDIO_STAFF_TOKEN`: a platform staff
  JWT with `studio:admin:library` and `studio:project:read` (for `GET /library/categories`).
- `GET /api/studio/admin/library/ingest/status?windowHours=24&failures=20[&runIds=…]` returns
  counts by state and recent failures with their reasons. The admin **Library** tab shows the same
  data under "Ingestion status" and refreshes it every 30 seconds.
- `POST /api/studio/admin/library/ingest` takes batches of 100 or fewer. Resubmitting a source
  that is already ingested returns it under `skipped`. A failed source is re-enqueued under a
  fresh job id.
- `POST /api/studio/admin/library/ingest/resubmit { "failedOnly": true }` (13.15) re-enqueues
  every FAILED run with the item it was submitted with; pass `runIds` to pick runs, or
  `"failedOnly": false` to also re-enqueue QUEUED/RUNNING runs stuck for an hour or more (a lost
  job). The admin **Library** tab has a "Resubmit failures" button for the first case. Runs
  submitted before 13.15 have no stored item and are skipped with that reason: resubmit them
  with the tool.

- `ingest-corpus.ts <manifest> --preflight [--sample 100] [--workers N]` (Phase 14.9) checks
  that a run can start. It submits nothing. Run it with the **library workers' env**, for example
  inside the `worker-library` container, so it reads the settings the workers use. It checks:
  - the admin API and the taxonomy
  - the caps tier: `STUDIO_LIBRARY_PLAN_TIER` must be ENTERPRISE for a full run (a WARN for a
    sample)
  - the job slots (`STUDIO_LIBRARY_CONCURRENCY` × `--workers`) against the table below, with the
    time and daily-spend estimate
  - write and delete access to `S3_BUCKET_LIBRARY` (a probe object under `library/staging/`)
  - that every s3:// row is inside `STUDIO_CORPUS_S3_BUCKETS`, with HEAD probes of up to 20 of
    them
  - manifest validation

  It exits 1 on any FAIL.
  `npx tsx scripts/ops/staging-gate.ts --corpus-preflight <manifest> [--sample 100]` wraps it and
  writes `ops/results/<date>-corpus-preflight-*.md` (runbooks/staging-gate.md).

### Manifest

Start from `corpus/manifest.template.csv`: the header row plus two example rows to replace. Put
one row per video. Use CSV with a header row, or JSONL with one object per line.

| Field | Aliases | Required | Notes |
| --- | --- | --- | --- |
| `url` | `sourceUrl`, `source_url` | yes | `https://…`, fetched through the SSRF guard. Or `s3://bucket/key`, only for buckets listed in `STUDIO_CORPUS_S3_BUCKETS`. `http://` is refused. |
| `title` | | no | |
| `tags` | | no | CSV: separated by `a\|b\|c` or `;`. JSONL: an array. 20 or fewer, each 60 characters or fewer. |
| `category` | `category_slug` | no | A slug from `GET /library/categories`. If it's empty, Claude classifies the video. |
| `sourceRef` | `external_id`, `id` | no | Your id for the row. It must be unique, and it is shown in failures and the review report. |
| `language` | `lang` | no | `en`, `pt-BR`, … |
| `sourcePlatform` | `platform` | no | |

The tool rejects these rows before anything is sent:

- a bad scheme
- a duplicate URL or `sourceRef`
- an unknown category slug
- oversized fields

A full run refuses to start while any row is invalid. A sample run samples only from the valid
rows.

### s3:// sources

`STUDIO_CORPUS_S3_BUCKETS=postmind-corpus` allows a whole bucket.
`STUDIO_CORPUS_S3_BUCKETS=studio-library-assets/corpus/` allows only one prefix.

The worker reads the object with Studio's own S3 client (`size` + `readRange`), subject to the
same 200 MB cap. The IAM role needs `s3:GetObject` on that bucket or prefix. Buckets that aren't
listed are refused. This path never touches HTTP, and https sources still always go through the
SSRF guard.

## Steps

1. **Prepare.**
   - Upload the corpus, or list its https URLs.
   - Write the manifest.
   - Set `STUDIO_CORPUS_S3_BUCKETS` if you use s3 sources.
   - Check that `S3_BUCKET_LIBRARY` is set and the taxonomy is seeded (`npm run db:seed`).
   - Run a dry run:

     ```
     STUDIO_URL=… STUDIO_STAFF_TOKEN=… npx tsx scripts/ops/ingest-corpus.ts corpus.csv
     ```

   - Fix every invalid row it reports. Read the cost and time estimate.
   - Run the pre-flight for the sample:
     `… ingest-corpus.ts corpus.csv --preflight --sample 100`. Fix every FAIL.
2. **Sample run (9.2).**

   ```
   npx tsx scripts/ops/ingest-corpus.ts corpus.csv --sample 100 --seed 7 --apply
   ```

   - The tool takes a stratified sample: every top-level category gets a share proportional to
     its size, and rows without a category form one stratum. The same `--seed` gives the same
     sample.
   - It submits the sample, then waits for it (`--wait-minutes 180`) and prints the review report:
     - ingested OK and failed counts
     - the category distribution
     - the failures and their reasons
     - 10 random items as `<STUDIO_URL>/library/<id>` links
   - State goes to `corpus.csv.state.json`, or to `--state <file>`.
   - To reprint the report later, run `… corpus.csv --report`.
3. **Operator review (the gate).** Work through this checklist on the review report:
   - [ ] Failure rate is 5% or less. Every failure reason is understood: a bad source, or a fix
     is planned.
   - [ ] The category distribution matches the manifest's strata, and no category is missing.
   - [ ] For each of the 10 random links:
     - [ ] the category is right, or close enough that search still finds it
     - [ ] the shot breakdown matches the video (count, rough timing)
     - [ ] the on-screen text and transcript are right and in the right language
     - [ ] the style signature and tags are sensible (no generic or empty tags)
     - [ ] "Use as template" offers TEMPLATE and INSPIRE, and a TEMPLATE project starts
   - [ ] Search: `GET /library/videos?category=<slug>` returns sample items for two or three
     categories.
   - [ ] Spend: today's corpus spend (`GET /api/studio/admin/cost/caps`) is in line with
     £0.02–£0.05 per video.
   - [ ] Throughput: the measured `completedPerHour` replaces the 3-minute assumption in the
     full-run estimate.

   Record the operator's approval, or the problems, in PROGRESS.md and in
   runbooks/staging-gate.md (results row 10).

   Fix the causes (taxonomy, manifest categories, analysis prompt) and repeat step 2 until the
   operator approves. Retire bad sample items with
   `POST /api/studio/admin/library/videos/<id>/retire`.
4. **Full run (9.3).** Set the throughput and cost settings (see below). Run the pre-flight in
   full mode, `… ingest-corpus.ts corpus.csv --preflight --workers 2`, until it passes. Then
   run:

   ```
   npx tsx scripts/ops/ingest-corpus.ts corpus.csv --apply --queue-concurrency 8 --workers 2
   ```

   - Use the same state file, so rows the sample already took are skipped.
   - The run submits 100 per batch, 2 batches in flight (`--concurrency`, 8 at most).
   - It retries 429, 408, 5xx and network errors with exponential backoff, honouring
     `Retry-After`. The API's write limit is 120 per minute per user.
   - The state file is rewritten atomically after every batch. If the tool dies, run the same
     command again: accepted rows are not resubmitted, and rows the server rejected are retried.
5. **Monitor.**
   - Watch the admin Library tab, "Ingestion status", or poll
     `GET /api/studio/admin/library/ingest/status?windowHours=1`.
   - Watch these metrics:
     - `studio_jobs_total{job="ingest-library-video"}`
     - `studio_queue_jobs{queue="studio-library"}` (service-health.md)
     - today's spend (`GET /api/studio/admin/cost/caps`)
   - Replace the time estimate's assumption with the measured `completedPerHour`.
6. **Failure handling.**
   - `recentFailures[].errorReason` gives the cause.
   - *Source returned HTTP 4xx*, *larger than 200 MB*, *no video duration*: bad sources. Fix or
     drop the rows. If you drop them, remove them from the manifest.
   - *not in STUDIO_CORPUS_S3_BUCKETS*: the bucket isn't allow-listed. Fix the env var and restart
     the workers.
   - *No valid category*: the taxonomy doesn't cover the video. Add a category to the manifest
     row.
   - *Provider / cost-cap paused*: see provider-outage.md and cost-runaway.md. The job retries.
     After a cost-cap pause, resubmit after midnight UTC.
   - To re-run failures, press "Resubmit failures" in the admin Library tab (or POST
     `/admin/library/ingest/resubmit`), or run the tool again: either way FAILED sources are
     re-enqueued under a fresh job id. `scripts/ops/redrive.ts` is for projects, not library jobs.
   - To stop the run:
     - Engage the `provider` or `global` kill switch (kill-switch.md). Library jobs check it at
       start.
     - Or scale the library workers to 0.

     Queued jobs stay in Redis and resume when the workers come back.

## Throughput math (50,000 videos)

- One job holds a worker slot for its whole ingest: download, ffprobe, scene detection,
  keyframes, the preview render, the transcription wait, Claude vision analysis and the
  embedding. There is no measured figure yet: the tool's default assumption is 3 min per video.
  Replace it with the sample's measured rate (`100 ÷ elapsed hours`, or `completedPerHour`).
- Job slots = `STUDIO_LIBRARY_CONCURRENCY` (default 2, capped at 32) × worker processes running
  the `studio-library` queue.
- Time ≈ `videos × minutes ÷ slots ÷ 60` hours.

| Slots | Videos per hour (3 min each) | 50k takes |
| --- | --- | --- |
| 2 (default: 1 worker × 2) | 40 | ~1,250 h (~52 days) |
| 8 (1 × 8) | 160 | ~313 h (~13 days) |
| 16 (2 × 8) | 320 | ~156 h (~6.5 days) |
| 32 (4 × 8) | 640 | ~78 h (~3.3 days) |

- **Memory:** since 13.15 each job streams its source to S3 with a multipart upload (8 MiB
  parts, hashed on the way, staged under `library/staging/` then copied to
  `library/<sha256>.mp4`), so a job holds about one part in memory. Budget FFmpeg per slot
  (about 300 MB) rather than the source size. A failed upload is aborted (no orphaned parts);
  a crashed worker can leave a `library/staging/` object behind, which the S3 lifecycle rule
  `studio-library-staging-expire-2d` expires after 2 days (infra/s3-lifecycle.json, storage-cost.md).
- **Providers:** each video makes about 1 Claude vision call (up to 12 keyframes), 1 AssemblyAI
  transcription and 1 embedding. 640 per hour is about 11 per minute: check your account's rate
  limits before going above 16 slots.

## Cost

- PROGRESS Phase 9 estimates about **£0.02–£0.05 per video** in provider calls. For 50k videos
  that is about **£1,000–£2,500**. Storage is extra (storage-cost.md): the source, a preview and a
  thumbnail per video.
- Corpus jobs bill the `postmind-platform` organisation at `STUDIO_LIBRARY_PLAN_TIER` (default
  STANDARD). The cost guard applies that tier's org caps to it:
  - STANDARD: £30 per day and £150 per month. That stops a full run after about 600–1,500 videos
    a day and 3,000–7,500 a month.
  - **For 9.3, set `STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE`**: £400 per day and £3,000 per month.
    That covers the whole corpus in one month, at up to about 8,000–20,000 videos a day.
- Do not raise a tier's caps to make room: those caps apply to every customer on the tier.
- At 16 slots, spend is about £150–£380 a day. That fits the ENTERPRISE daily cap and leaves the
  £2,500 global daily cap (shared with customers) most of its room.
- The tool prints the estimate before anything is submitted.

## Verification

- `counts.SUCCEEDED + counts.DUPLICATE` reaches the manifest's valid-row count.
- `backlog` is 0 queued and 0 running, and `liveLibraryItems` matches.
- `GET /library/videos?category=<top-level>` returns items for every category in the manifest.
- A TEMPLATE project from a random corpus item reaches READY_FOR_REVIEW.
- Record the result against 9.2 and 9.3 in PROGRESS.md.

## GAP

- The per-video minutes figure is an assumption until the sample run measures it.
- A job's wall-clock time is bounded only by the per-FFmpeg-call timeouts.
