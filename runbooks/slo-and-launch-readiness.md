# SLOs and launch readiness (BACKLOG 15.D9 / 15.D10)

What this covers: the spec 17.1 latency SLOs and spec 3.5 acceptance metrics (Prometheus), and
the A14.2 launch-readiness checks plus the §20 daily provider canary. Several of these can only
be run by an operator with staging keys and people-made fixtures; each section says so.

## Metrics and alerts (15.D9)

Exported by the **worker** process (`:WORKER_METRICS_PORT/metrics`, scrape job `studio-worker`),
defined in `src/lib/studio/observability/metrics.ts`, recorded by `observability/slo.ts`:

| Metric | Labels | Measures |
| --- | --- | --- |
| `studio_generation_seconds` (histogram) | `kind` = short_form, long_form, slideshow | generate call → READY_FOR_REVIEW (clock starts in `generateProject`, stops when the quality gate passes every render) |
| `studio_publish_latency_seconds` (histogram) | `platform` | the later of publication creation / scheduled time → platform live |
| `studio_analytics_first_metric_seconds` (histogram) | `platform` | publishedAt → first analytics sample stored |
| `studio_publications_total` (counter) | `platform`, `outcome` = first_attempt, after_retry, failed | final publish outcomes |
| `studio_quality_gate_renders_total` (counter) | `result` = pass, fail | renders through the quality gate |

Rules and alerts: `ops/prometheus/studio-slo.yml` (tests `ops/prometheus/tests/studio-slo.test.yml`,
CI job `ops-config`). All alerts are `severity: ticket`, each with a minimum volume.

Not measured (by design): generation runs that reach READY_FOR_REVIEW after a Trust & Safety
review or a force-approve (they sat in a human queue), and regenerations of a script, shot or
overlay (they don't start at a generate call).

### generation-latency

`StudioShortGenerationP50Slow` / `P95Slow` (4 / 10 min) and `StudioLongFormGenerationP50Slow` /
`P95Slow` (15 / 40 min). Check the per-job durations (`studio_job_duration_seconds` by job) to
find the slow layer; provider latency usually dominates (runbooks/provider-outage.md), then
queue backlog (service-health.md#queue-backlog). Scaling workers helps only if the queue is
backed up.

### publish-latency

`StudioPublishLatencyP95High`: approve → live over 3 minutes on one platform. Check the publish
queue depth and the platform's status page; YouTube quota deferrals (15.A9) and TikTok inbox
uploads are expected to be slow — look at `video_publications.metadata` for the platform.

### analytics-freshness

`StudioAnalyticsFreshnessSlow`: the first poll runs 30 s after publish; slow first samples mean
the analytics queue is backed up or the platform returns no metrics yet (retries follow
analytics/schedule.ts).

### quality-pass-rate

`StudioQualityPassRateLow` (spec 3.5: 92%+). Group `video_renders.qualityIssues` by check code
over the last day to see which check fails; content-safety blocks are expected to be rare.

### publish-first-attempt

`StudioPublishFirstAttemptRateLow` (spec 3.5: 98%+). Group recent `video_publications.errorCode`
by platform; `needs_reconnect` means expired tokens (platform-account-revocation.md).

## Launch-readiness checks (15.D10, A14.2)

### Overlay pixel diff

`test/visual/overlay-presets.visual.test.ts` (harness `test/visual/harness.ts`), CI workflow
`.github/workflows/visual-regression.yml`. Per built-in preset it compares the editor's HTML
preview (Chromium) with the production FFmpeg pre-render, and with the Shotstack reference.
Needs ffmpeg, Playwright + Chromium and `VISUAL_FONTS_DIR`; skips with the reason otherwise.
Tolerance: `VISUAL_MAX_DIFF_RATIO` (default 0.02 = 2% of pixels).

**Capturing the Shotstack references (operator, first live run, staging keys):**

1. In staging, create a project with one 9:16 shot and add one overlay per built-in preset,
   each with the text `Save 42% today`, from 0 s to 2 s, anchored where the preset puts it.
2. For each overlay, `POST /api/studio/overlays/:id/preview` (the Shotstack preview render) and
   download the returned MP4.
3. Extract the settled frame at 540×960:
   `ffmpeg -ss 1.9 -i preview.mp4 -frames:v 1 -vf scale=540:960 test/visual/references/<preset key>.png`
   (the preset keys are in `src/lib/studio/overlays/presets.ts`).
4. Look at every PNG before committing it — a reference is the definition of "correct".
5. Run `VISUAL_FONTS_DIR=… npm run test:visual`; commit the references with the result.

A reference captured over a video frame (not transparent) will differ from the transparent
HTML preview in the background; render the preview project over a black shot.

### Business classifier accuracy (> 85% on the 50-site set)

The labelled set is Playbook H-03 (people work). Format: `test/eval/fixtures/classifier-manifest.example.json`
(illustrative — never counted). Save the real set as `test/eval/fixtures/classifier-manifest.json`
(`"illustrative": false`, 50 sites, `acceptIndustry` phrases per site). Then:

```sh
ANTHROPIC_API_KEY=<staging key> npm run test:eval -- test/eval/classifier.eval.ts
```

Each site is crawled live with the production crawler and classified with the production prompt;
the misclassified sites are printed when the threshold is missed.

### Website scan under 5 minutes (20-site QA fixture)

Format: `test/eval/fixtures/scan-sites.example.json`. Save the real 20 sites as
`test/eval/fixtures/scan-sites.json` with a staging business id per site, then:

```sh
EVAL_STUDIO_BASE_URL=https://<staging host> EVAL_STUDIO_TOKEN=<Core JWT for the staging test org> \
  npm run test:eval -- test/eval/scan-timing.eval.ts
```

It calls the real API (3 scans at a time; the org cap is 25 scans a day, so run it once a day).

### Cost regression per mode (within 15% of A10)

`test/cost/a10-cost.test.ts`. The offline harness (`test/cost/journeys.ts`) prices a standard,
INSPIRE and TEMPLATE 30 s short at the adapters' list prices; it checks the reference modes add
no more than A10 says. **Known gap:** at list prices the harness standard short costs ~377p,
far above A10's £0.81–£1.15 (three 10 s Runway clips alone exceed it) — A10's estimates or the
Runway defaults need a product decision. The A14.2 gate itself is decided on **staging actuals**:

```sql
SELECT p.id, p."sourceType", p."referenceMode",
       jsonb_array_length(p."targetFormats") AS "formatCount",
       (SELECT max(COALESCE((f->>'durationSec')::numeric, (f->>'duration')::numeric))
          FROM jsonb_array_elements(p."targetFormats") f) AS "maxDurationSec",
       p."costActualPence"
FROM studio.video_projects p
WHERE p.state IN ('READY_FOR_REVIEW','APPROVED','PUBLISHED','PARTIALLY_PUBLISHED')
  AND p."createdAt" > now() - interval '14 days';
```

Save as `test/cost/fixtures/a10-actuals.json`:
`{ "capturedAt": "…", "environment": "staging", "projects": [ …rows… ] }`, then
`npx vitest run test/cost/a10-cost.test.ts` (or set `A10_ACTUALS_PATH`). Each A10 mode's median
must be inside its range ±15%.

## Daily provider canary (§20)

`.github/workflows/platform-canary.yml`, job `providers` (daily 05:30 UTC and manual): each AI
provider adapter's own read-only `healthCheck()` with a STAGING key
(`src/lib/studio/providers/canary.ts`, `test/canary/providers.canary.ts`). Every `Deprecation`
(RFC 9745), `Sunset` (RFC 8594) or `Link rel="deprecation"` header seen becomes a `::warning`
annotation; the platform job logs the same headers from the platform APIs. An adapter with no
unbilled endpoint would be reported "not probed" (none today; Hive was removed in 20.21).

Secrets (repository → Settings → Secrets): `CANARY_ANTHROPIC_API_KEY`, `CANARY_OPENAI_API_KEY`,
`CANARY_RUNWAY_API_KEY`, `CANARY_LUMA_API_KEY`, `CANARY_GOOGLE_GEMINI_API_KEY`, `CANARY_HEYGEN_API_KEY` + `CANARY_HEYGEN_AVATAR_ID`,
`CANARY_ELEVENLABS_API_KEY`, `CANARY_SHOTSTACK_API_KEY` (Shotstack stage key),
`CANARY_ASSEMBLYAI_API_KEY`, `CANARY_STORYBLOCKS_PUBLIC_KEY` +
`CANARY_STORYBLOCKS_PRIVATE_KEY`. Providers without secrets are skipped.

When a deprecation warning appears: read the provider's changelog at the `Link` target, open a
ticket with the sunset date, and follow runbooks/platform-api-change.md for the adapter change.

## Operator run (last step of 15.D10)

With staging keys, in this order: configure the canary secrets and run the workflow manually;
capture the Shotstack references and run the pixel diff; deliver H-03 and run the classifier
eval; deliver the 20-site fixture and run the scan timing; export A10 actuals after a week of
staging use and run the cost gate. Record each result in PROGRESS.md.
