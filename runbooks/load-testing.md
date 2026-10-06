# Load testing (BACKLOG 20.29)

How to check that the pipeline and the API hold under load **without touching production and
without calling a paid provider**. Results of the last run: `ops/results/load-test-2026-10-03.md`.

## What exists

| Piece | What it does |
| --- | --- |
| `scripts/load/pipeline-load.ts` | Starts N video projects at once across K organisations (one "heavy" organisation, the rest light) and runs the **real** pipeline on them: BullMQ workers on Redis 5+, Postgres, router, provider_jobs tracking, cost guard, circuit breakers, the 20.29 concurrency caps, real FFmpeg (probe, blackdetect, loudness, mastering, thumbnails) on small sample media. Only the providers are simulated. Writes `<scenario>.json` / `.md`. `--attach` instead processes what the API enqueued (used with k6). |
| `src/lib/studio/load-test/*` | The simulated providers (latency 30–180 s per AI clip, Seedance 3 / Kling 20 / Veo 10 concurrent tasks per account with 429 over it, a share of random 429s and failures), local disk storage served on 127.0.0.1, sample media, the report maths, and the guard. |
| `load-test/k6/studio-users.js` | 200 virtual users of mixed traffic (dashboard, project, library, calendar, analytics, page loads, create project, generate) with 3–8 s think time, plus a 100-user "generate" burst 3 minutes in. |
| `scripts/load/seed-k6-accounts.ts` | 40 organisations × 5 users with real sessions (sign-in endpoint), a business and 6 projects each. |
| `.github/workflows/load-test.yml` | Runs everything on CI: job `pipeline` (the scenarios below, Redis 7 + Postgres 17 services) and job `api-200` (the production compose stack `deploy/vps/compose.yml` with its container limits, `current` and `4gb` sizing). |
| `load-test/k6/studio-api.js` | The older read-only API smoke (BACKLOG 12.1), unchanged. |

### Safety

- Simulated providers start only with `STUDIO_FAKE_PROVIDERS=1`. They **refuse** an environment that
  looks like production (`NODE_ENV`, `STUDIO_ENV` or `SENTRY_ENVIRONMENT` = production) unless a
  second variable is set: `STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION=yes-this-is-a-disposable-stack`
  (CI's throw-away copy of the compose stack names itself "production"). They **always** refuse an
  `APP_URL` on the live domain (`postmindai.pro`), whatever else is set. Never set either variable on
  the server.
- The pipeline's `fetch` in the harness only reaches 127.0.0.1 / localhost / `data:` URLs; any other
  host throws. Stock images are switched off. No publish or email queue runs.
- k6 and the seed script run only against the disposable stack.

## Running it

### On CI (the normal way)

Actions → **Load test** → Run workflow (or push to `load-test/**`). Inputs: `scenarios` (comma list
or `all`) and `run_api`. Results: the run's summary page and the artifacts `load-test-pipeline`,
`load-test-api-200-current`, `load-test-api-200-4gb` (JSON per scenario, k6 summary, `docker stats`
samples, worker and web logs). About 2–3 hours for everything.

Pipeline scenarios (time scale 0.1: simulated provider latencies run ten times faster; every time in
the reports is converted back to real time):

| Scenario | Videos / orgs | Worker sizing | Notes |
| --- | --- | --- | --- |
| `burst-10-2gb`, `burst-25-2gb`, `burst-50-2gb` | 10/5, 25/8, 50/10 (half from one org) | today's `.env.example` (orchestration 2, assets 3, one FFmpeg) | asserts caps, fair share, no rate-limit failures, ≥ 90 % ready |
| `burst-50-4gb` | 50/10 | recommended 4 GB (orchestration 4, assets 12, two FFmpeg) | same assertions |
| `burst-50-4gb-no-caps` | 50/10 | 4 GB | Seedance/Kling caps off: the behaviour before 20.29 (no assertions) |
| `burst-100-4gb-queue` | 100/40 | 4 GB | "100 of the 200 users press generate at once", default overflow `queue` |
| `burst-100-4gb-failover` | 100/40 | 4 GB | the same with `STUDIO_PROVIDER_OVERFLOW=failover` |

### Locally

Needs Redis 5+ (BullMQ), Postgres with the migrations, and FFmpeg on the PATH. The build machine's
Redis 3 is too old, so use CI unless you have Docker:

```bash
STUDIO_FAKE_PROVIDERS=1 STORAGE_PROVIDER=s3 AWS_REGION=eu-west-2 S3_BUCKET_ASSETS=lt-a \
S3_BUCKET_RENDERS=lt-r S3_BUCKET_THUMBNAILS=lt-t \
WORKER_CONCURRENCY_ORCHESTRATION=4 WORKER_CONCURRENCY_ASSETS=12 STUDIO_FFMPEG_MAX_CONCURRENT=2 \
npx tsx scripts/load/pipeline-load.ts --scenario burst-25 --videos 25 --orgs 8 --time-scale 0.1 --assert
```

Flags: `--videos`, `--orgs`, `--heavy-share` (0–1, default 0.5), `--tier` (default STANDARD),
`--time-scale` (default 0.1), `--rate-limited-ratio` (default 0.05), `--fail-ratio` (default
0.02), `--timeout-min`, `--out`, `--assert`, `--attach --accounts <file> --done-file <file>`.

## Reading the results

- **Time to ready** (generate → READY_FOR_REVIEW), real-time equivalent, p50 / p95 / max, and
  **throughput** (videos per hour).
- **Light-organisation spread**: slowest light organisation's median time ÷ the fastest's (1 = even).
  The heavy organisation's own time is expected to be longer: it started half the burst.
- **Peak in flight / cap** per provider and **peak per organisation / share**: the caps must hold.
- **Job runs deferred**: how often work waited for a provider without spending a retry.
- **Projects that showed "queued, starting soon"** (`metadata.providerWait`).
- **Worker peak RSS / CPU, FFmpeg children, Postgres connections, assets queue depth.**
- k6 (`api-200`): `studio_read_latency`, `studio_page_latency`, `studio_write_latency`,
  `studio_generate_latency` p95, `studio_errors`, `studio_rate_limited`, `studio_quota_refused`; the
  job summary adds peak memory and CPU per container from `docker stats`.

## Knobs the results point at

| Variable | Default | What it does |
| --- | --- | --- |
| `STUDIO_PROVIDER_CONCURRENCY_<ID>` | Seedance `3`, Kling `20`, others none | In-flight cap per provider account, optionally `,org=<n>` (default share: half, rounded up). Set it to the account's real limit: Seedance `10` on a BytePlus enterprise account. `0`/`off` = no cap. |
| `STUDIO_PROVIDER_OVERFLOW` | `queue` | `queue`: wait for the cheapest provider. `failover`: use the next provider (Kling, then Veo) while the first is full; faster under a burst, dearer per clip. |
| `STUDIO_PROVIDER_RATE_<ID>` | none | Calls per window (15.C3), e.g. Seedance RPM `180/60`. |
| `WORKER_CONCURRENCY_*`, `STUDIO_FFMPEG_MAX_CONCURRENT` | see `deploy/vps/.env.example` | Worker sizing; the 4 GB values are in the results file. |
| `WEB_DB_CONNECTION_LIMIT`, `WORKER_DB_CONNECTION_LIMIT`, `PG_MAX_CONNECTIONS` | 5, 10, 40 | Prisma pools; their sum plus ~10 must stay under `PG_MAX_CONNECTIONS` (an empty value means the default). |

## Real-provider check (Phase 2, needs the operator's approval of the cost)

Not run. See the results file for the proposed 5-video production burst, its exact command and
its expected cost.

## Queue capacity model (23.6)

`npx tsx scripts/load-test/capacity-model.ts` runs a deterministic simulation of the BullMQ lanes
(`src/lib/studio/load-test/capacity-model.ts`). It uses virtual time and needs no Redis, database or
providers, so it runs anywhere (it also runs in the unit suite) and the same flags always give the
same numbers. Scenario: 100 organisations each approve a 28-day plan at 3 posts a day (8,400 posts)
at the same moment, with the production medians of 2026-10-06 (Claude 6 s, Shotstack 49 s, carousel
26 s, AI clips 30-180 s; mix 40 % carousel, 30 % slideshow, 20 % wall of text, 10 % AI video).

- **Before:** every post generates at once; compose-video holds an orchestration slot through the
  render; orchestration 4, assets 8.
- **After (23.6):** rolling generation (72 h window + first 3 posts), render lane 3 with
  asynchronous renders, runners at HIGH priority.

| Measure | before | after |
| --- | --- | --- |
| Initial backlog drain | 32.7 h (8,400 posts) | 55 min (600 posts due now) |
| Time to first post per organisation p50 / p95 / max | 63 / 97 / 100 min | 9 / 17 / 17 min |
| Late posts | 0 | 0 |
| Runner (tick) wait on orchestration p95 / max | 24 s / 49 s | 0 s / 7 s |

After 23.6 the rest of the month is generated 72 h ahead of each slot (about 300 posts a day for
this load), so "every post ready" follows the posting schedule. Flags: `--orgs`,
`--orchestration`, `--render`, `--assets`, `--window-hours`, `--immediate`,
`--no-callbacks`; rerun after any change to lane sizes or latencies. It models queue capacity
only: provider-side limits (Seedance / Kling concurrency, Shotstack account throughput) are not
simulated.