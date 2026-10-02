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

**Getting the videos into a bucket first.** The operator's corpus is on a local hard drive:
[corpus-upload.md](corpus-upload.md) scans it, uploads it to the `eu-corpus-source` R2 bucket
with rclone, writes the manifest from the folder (`npm run corpus:manifest`) and ends at step 1
below.

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
   - Upload the corpus, or list its https URLs. From a local drive: corpus-upload.md steps 1–9.
   - Write the manifest. From an uploaded folder: `npm run corpus:manifest` (corpus-upload.md
     step 10).
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
  - STANDARD: £15 per day and £73 per month (price list 2026-09-30). That stops a full run after
    about 300–750 videos a day and 1,460–3,650 a month.
  - **For 9.3, set `STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE`**: £150 per day and £1,100 per month.
    That is about 3,000–7,500 videos a day and 22,000–55,000 a month, so a 50k run can need
    more than one month at the defaults.
  - To finish in one month, give the `postmind-platform` organisation its own cost-cap override
    (Admin → Organisations → Cost caps, 13.19), for example £400 a day and £3,000 a month, and
    remove it after the run.
- Do not raise a tier's caps to make room: those caps apply to every customer on the tier.
- At 16 slots, spend is about £150–£380 a day. That needs the per-organisation daily override
  above (the ENTERPRISE default is £150) and leaves the £2,500 global daily cap (shared with
  customers) most of its room.
- The tool prints the estimate before anything is submitted.

## Library caching (20.15)

The reference library is the same for every customer, so user reads are cached once for
everyone in Studio's Redis (DB 3). Code: `src/lib/studio/library/cache.ts`.

What is cached:

| Read | Key parts | TTL |
| --- | --- | --- |
| Category tree | none | 15 min |
| Browse page (`GET /library/videos`) | every filter: category, tags (sorted), duration, mood, cursor, limit | 15 min |
| Detail (`GET /library/videos/:id`) | id (the trimmed allow-list shape only) | 15 min |
| Similar | id, limit | 15 min |
| Blueprint | id | 15 min |
| Search page (`POST /library/search`) | normalised query, category, duration, mood, tags, cursor, limit | 15 min |
| Recommended | organisation, business, category, limit | 1 h |
| Query embedding | sha256(model + normalised query) | 30 days |

- Every key carries the catalogue version (`studio:library:version`). Any catalogue change
  INCRs it, so the next read is fresh. Nothing is scanned or deleted; old keys expire.
- What bumps it: ingest worker (success and final failure), re-analysis worker, admin edit
  (`PATCH /admin/library/videos/:id`, including licence changes), bulk review, retire, and
  `npm run db:seed` (taxonomy). Staff reads (`/admin/library/*`, including
  `/admin/library/categories`) are never cached.
- Licence expiry is not frozen in the cache: the raw licence terms are cached and the allowed
  modes are worked out on every response.
- Signed URLs are never cached. Thumbnails are signed as of the start of the UTC day, valid for
  25 h, so the URL stays the same all day and the browser keeps the image (`Cache-Control:
  public, max-age=604800, immutable`, set at upload). Previews stay 10-minute, per request.
- GET library responses carry `Cache-Control: private, max-age=60`.
- Redis down or erroring: reads go to the database, a warning is logged at most once a minute,
  and no request fails. A failed version bump is logged ("version bump failed"); cached reads
  can then be up to 15 minutes old.
- Metrics: `studio_library_cache_total{cache, result="hit|miss|error"}`.
- Off switch: `STUDIO_LIBRARY_CACHE=off` (every read goes to the database).

After a database restore or a manual SQL change to the library tables, bump the version by
hand:

```bash
redis-cli -u "$REDIS_URL" INCR studio:library:version
```

### Thumbnail Cache-Control backfill (one-off)

Thumbnails ingested before 20.15 have no Cache-Control. Run once per environment, with the
storage env of that environment (STORAGE_PROVIDER, R2_* or AWS_*, S3_BUCKET_LIBRARY):

```bash
npx tsx scripts/library/set-thumbnail-cache-headers.ts --dry-run    # counts only, writes nothing
npx tsx scripts/library/set-thumbnail-cache-headers.ts --limit 20   # trial batch
npx tsx scripts/library/set-thumbnail-cache-headers.ts              # everything
```

It copies each `library/<hash>-thumb.jpg` onto itself (CopyObject, MetadataDirective REPLACE),
keeping Content-Type and user metadata. Objects that already have the header are skipped, so it
is safe to re-run. It exits 1 if any object failed; the failed keys are logged.

### Preview sound: rebuilding existing previews (one-off, 20.17)

Since 20.17 (operator decision 2026-10-01) library previews keep their sound: H.264 + AAC
stereo at 96 kb/s, still 360 px wide, at most 30 seconds, with no download control, signed per
request for 10 minutes. New ingests get sound automatically. Previews made before 20.17 are
silent until they are rebuilt with `scripts/library/rebuild-previews.ts`.

For every library item that is not retired, the script signs the stored source (`s3Bucket` /
`s3Key`), runs ffmpeg and overwrites `library/<hash>-preview.mp4` with `Content-Type: video/mp4`
and `Cache-Control: public, max-age=604800, immutable`, the same as ingest. Overwriting the key
is safe: previews are only reached through 10-minute signed URLs, so browsers do not keep an old
copy. It makes no AI or provider calls (storage, ffprobe and ffmpeg only). Users still never get
the source file.

Run it on production from the VPS, one step at a time:

```bash
# 1. Count only: nothing is encoded or written.
bash scripts/vps/compose.sh production run --rm -T ops npx tsx scripts/library/rebuild-previews.ts --dry-run
# 2. Trial batch: rebuild 5 previews, then open a few library items and press play.
bash scripts/vps/compose.sh production run --rm -T ops npx tsx scripts/library/rebuild-previews.ts --limit 5
# 3. Full run: rebuild every preview that is still silent.
bash scripts/vps/compose.sh production run --rm -T ops npx tsx scripts/library/rebuild-previews.ts --only-missing-audio
```

Flags:

- `--dry-run` counts and writes nothing (with `--only-missing-audio` it still runs ffprobe, which
  only reads).
- `--limit N` stops after N items.
- `--concurrency N` sets how many items are encoded at once (default 2, at most 8). It is capped by
  `STUDIO_FFMPEG_MAX_CONCURRENT`, which is 1 in the VPS example env, so the run encodes one at a
  time unless you add `-e STUDIO_FFMPEG_MAX_CONCURRENT=2` after `run` (it is passed to
  `docker compose run`). The ops
  container is limited to 1 CPU and 512 MB, so keep 1 or 2 on the 4 GB server.
- `--only-missing-audio` uses ffprobe to skip items whose preview already has an audio stream, and
  items whose source has no audio at all (a rebuild would still be silent). Use it for the full
  run and for any re-run after failures: it carries on where the last run stopped.

Every item is logged (`library preview`, with the outcome). A failed item is logged with its id
and key and the run carries on. At the end there is one summary line (`examined`, `rebuilt`,
`skippedHasAudio`, `skippedSourceSilent`, `failed`, and the first 20 failures). The script exits 1
if any item failed; run it again with `--only-missing-audio` to retry only those.

Timing is not measured yet: each item reads the source and encodes at most 30 seconds of 360 px
video, so expect seconds per item rather than minutes; the `--limit 5` run shows the real rate
(compare the first and last log times) before the full run of about 430 items. The
library cache does not need a version bump: it stores no preview data, and preview URLs are
signed per request.

## Verification

- `counts.SUCCEEDED + counts.DUPLICATE` reaches the manifest's valid-row count.
- `backlog` is 0 queued and 0 running, and `liveLibraryItems` matches.
- `GET /library/videos?category=<top-level>` returns items for every category in the manifest.
- A TEMPLATE project from a random corpus item reaches READY_FOR_REVIEW.
- Record the result against 9.2 and 9.3 in PROGRESS.md.

## GAP

- The per-video minutes figure is an assumption until the sample run measures it.
- A job's wall-clock time is bounded only by the per-FFmpeg-call timeouts.
