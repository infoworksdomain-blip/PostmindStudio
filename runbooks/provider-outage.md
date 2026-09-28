# Provider outage during a generation window (priority risk 1)

| | |
| --- | --- |
| **Metric** | `studio_provider_circuit_state{provider}`: 0 closed, 1 half-open, 2 open. Breaker state is shared by every process through Redis (13.16); Admin Centre → **Providers** shows it with the last hour's error rate and today's spend. |
| **Threshold** | Any provider open (2) on any worker. |
| **Escalation** | On-call engineer, then the Eng Lead after 30 min, then the vendor account manager. |

## What happens automatically

- The router skips providers whose circuit is open and routes each shot to the next candidate for
  its `visualTreatment` (spec 6.4). For example, Runway fails over to Luma (AI clips: STANDARD
  tries luma → runway, PLUS/ENTERPRISE veo → runway → luma; Luma needs `LUMA_API_KEY`). AI
  avatars have only HeyGen until D-ID is built: a HeyGen outage fails avatar shots.
- Luma and HeyGen have no cancel endpoint. A job that times out keeps its `provider_jobs` row
  RUNNING with its cost reservation, because the provider may still finish and bill it. Such
  rows are expected after an outage; reconcile them against the provider dashboard.
- An open breaker half-opens after 5 minutes and lets one probe through, platform-wide.
- The breaker lives in Redis (`studio:breaker:<provider>` keys, DB 3), so five failures on any
  worker open it for all of them. If Redis is unavailable each process falls back to its own
  in-memory breaker (the pre-13.16 behaviour) and logs "circuit breaker: Redis unavailable";
  nothing needs doing — shared state returns with Redis. `STUDIO_CIRCUIT_BREAKER_STORE=memory`
  forces per-process state. To close a breaker by hand after a confirmed recovery:
  `redis-cli -n 3 DEL studio:breaker:<provider> studio:breaker:<provider>:failures`.
- In-flight provider jobs poll to completion or fail. Failed shots retry with backoff through
  BullMQ.
- Music (`elevenlabs-music`) is non-fatal: when it is down, disabled or refuses a prompt, videos
  render with narration only and `metadata.music.status` is `failed` (with the reason); nothing
  retries it for that run. Disabling it with the provider kill switch is safe at any time. A
  re-render after recovery generates the track (the Review screen shows the music status).
- Phase 15 fallbacks (Track C): Claude (text) falls back to OpenAI (`OPENAI_TEXT_MODEL`,
  Responses API); AssemblyAI (captions, word timing, the voice-consent check) falls back to
  OpenAI whisper-1; ElevenLabs Music falls back to a Storyblocks library track
  (`storyblocks-music`); STOCK_FOOTAGE shots use Storyblocks video, then Pexels video. All use
  keys already configured; a provider without its key is simply skipped.
- Rate windows (15.C3): with `STUDIO_PROVIDER_RATE_<ID>` set (e.g. `STUDIO_PROVIDER_RATE_PEXELS_VIDEO
  ="200/3600,org=50/3600"`), a job that finds the window full is moved to BullMQ's delayed set
  until a slot frees ("job deferred" in the logs). It is not a failure and uses no retry. When a
  provider starts answering 429 during an incident, lower its window instead of disabling it.
  To inspect: `redis-cli -n 3 ZCARD studio:prate:<provider>`. Redis down = no Studio-side limit
  (fail-open, warned once a minute).
- A voice clone whose consent check could not run (transcription down) stays PENDING_REVIEW;
  after recovery the owner (or support) calls `POST /api/studio/voice-profiles/:id/consent-check`.

## Steps

1. Confirm the outage. Check the provider's status page and look at `provider_jobs` errors in the
   logs (`providerId`, `errorClass`).
2. If there is no healthy fallback for a treatment, or the failover provider is also degraded,
   **disable the provider** with the kill switch:
   `{"level":"provider","target":"<providerId>","enabled":true}`. This stops the half-open probes
   from spending budget on a provider that is known to be down.
3. Watch `studio_queue_jobs{queue="studio-assets",state="waiting"}`. If the backlog grows beyond
   what the fallback provider's rate limits allow, tell customers that generations are delayed.
   Use the status page; comms are owned by Product.
4. On recovery, release the provider switch and confirm that `studio_provider_circuit_state`
   returns to 0.
5. Find projects that ended `FAILED` with provider errors during the window, and offer to
   regenerate them. The regenerate endpoints are idempotent.

## Verify

The shot success rate returns to baseline in `studio_jobs_total{job="generate-asset"}`.

**GAP:** there is no alert rule yet (see [README](README.md#gap-alerting)).

## Phase 15 — what customers see during a fallback (15.B9)

When the router passes over a preferred provider for a run-time reason (circuit open, kill
switch, over budget, too slow, no cost estimate) and a later candidate produces the output, the
project's `metadata.fallbacks[]` lists it and the review screen shows "We used a fallback provider
for the … of this video". Nothing to do beyond the outage itself; owners may regenerate the shot
once the preferred provider is healthy (the regenerate never reuses the fallback's asset).
Reused generations (15.B6, `provider_jobs.operation = '<capability>:reused'`, cost 0) are not
provider traffic and never trip the breaker.
