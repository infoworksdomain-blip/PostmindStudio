# Provider outage during a generation window (priority risk 1)

| | |
| --- | --- |
| **Metric** | `studio_provider_circuit_state{provider}`: 0 closed, 1 half-open, 2 open. Breaker state is shared by every process through Redis (13.16); Admin Centre → **Providers** shows it with the last hour's error rate and today's spend. Failovers: `studio_provider_passed_over_total{provider,reason}` / `studio_provider_selected_total{provider}` (17.4). |
| **Threshold** | A provider open (2) for more than 5 minutes, or passed over in more than 20% of the routings that reach it (see [Alerts](#alerts)). |
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

## Provider account problems: key, credits, usage limits (20.11)

A provider answering "no credits", "usage limit reached", "payment required" or "API key
refused" is not an outage: retrying cannot help until someone fixes the account. Since 20.11:

- The provider is **held** out of routing at once (no five-failure count): until the time the
  provider states (Anthropic: "You will regain access on 2026-10-01 at 00:00 UTC"), otherwise for
  15 minutes; then one half-open trial. The running operation fails over to the next provider in
  the same job (e.g. Claude → OpenAI for text, Runway → Luma for clips), each with its own
  `provider_jobs` row (`errorClass` `account_limit`, `insufficient_credits` or `auth`).
- Admin Centre → **Providers** shows "Held: <problem> until <time> UTC" and the provider's own
  message. Redis fields: `studio:breaker:<provider>` `holdClass`, `holdReason`, `holdUntil`.
- One staff notification (kind `provider_alert`) per provider, class and UTC day, also posted
  to `OPS_ALERT_WEBHOOK_URL` when set; one more when a capability has no provider left.
- Customers never see the provider's text: the job fails with `service_unavailable` ("Our AI
  service is temporarily unavailable … our team has been alerted", 11 locales) and is not retried.
- Classified from the providers' documented errors: Anthropic 400 "You have reached your
  specified (workspace) API usage limits", 429 `enforced_spend_limit_reached`, 402
  `billing_error`, 401/403; OpenAI 429 `insufficient_quota`, `credit_balance_exhausted`,
  `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
  `organization_usage_limit_exceeded`, 401; every HTTP adapter: 401/403 auth, 402 credits
  (Luma, ElevenLabs, HeyGen, Hive V3 405 and HeyGen quota codes as documented per adapter).

To fix: top up or raise the limit in the provider console (Anthropic: Settings → Billing →
Spend limits; OpenAI: Billing), or rotate the key. Then release the hold at once instead of
waiting: `redis-cli -n 3 DEL studio:breaker:<provider> studio:breaker:<provider>:failures`.
Customers retry the failed scan or generation themselves.

Two capabilities degrade instead of failing the video (20.19):

- **Avatar presenter (HeyGen / D-ID).** When no `avatar_video` provider is available (account
  problem or hold, provider kill switch, open breaker, nothing configured) an `AI_AVATAR` shot is
  made as a regular generated clip (`text_to_video`: Runway / Luma) that illustrates its
  narration; the narration and shot length are kept. The shot's `providerRouting.visual` and the
  asset's metadata carry `degradedFrom: "avatar_video"` and `degradedReason`; the project's
  `metadata.degradedShots` lists them and the review screen tells the customer "The presenter
  wasn’t available for this video, so those moments use video clips instead." A content refusal
  or invalid request still fails the shot. HeyGen's undocumented `MOVIO_PAYMENT_*` failure codes
  (production 2026-10-02: `MOVIO_PAYMENT_INSUFFICIENT_CREDIT`) count as `insufficient_credits`.
- **Content safety (Hive).** With no content-safety provider (no key, or the key rejected / out
  of balance and held) the render is not passed: the run pauses for a Trust & Safety review
  (Admin Centre → Safety) instead of failing with a block nobody can lift. Each paused video
  needs a staff decision until a working Hive key is set, so fix the key first.

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

## Alerts

Rules in `ops/prometheus/studio-alerts.yml` (group `studio-providers`), promtool-tested in
`ops/prometheus/tests/studio-alerts.test.yml`:

- **StudioProviderCircuitOpen** (warning, `severity: ticket`) — `max by (provider)
  (studio_provider_circuit_state) == 2` for 5 minutes: the breaker has stayed open past its first
  half-open probe.
- **StudioProviderFailoverRateHigh** (warning, 17.4) — over 15 minutes, more than 20% of the
  routing decisions that reached a provider passed it over for a provider-side reason
  (`circuit_open`, `too_slow`, `no_cost_estimate`), with at least 10 such failovers, for 10
  minutes. It catches a breaker that flaps between open and half-open without ever staying open
  for 5 minutes. Kill-switch disables (`provider_disabled`, step 2 below) and cost caps
  (`over_budget`, cost-runaway.md) are not counted. The router increments
  `studio_provider_passed_over_total{provider,reason}` for every candidate it skips for a run-time
  reason and `studio_provider_selected_total{provider}` for the one it picks
  (providers/router.ts); a provider this deployment does not configure is never counted.
  `sum by (provider, reason) (rate(studio_provider_passed_over_total[15m]))` shows why.
- **StudioProviderCircuitsOpenMultiple** (page) — two or more breakers open at once.

Work any of them with the steps above.

## Phase 15 — what customers see during a fallback (15.B9)

When the router passes over a preferred provider for a run-time reason (circuit open, kill
switch, over budget, too slow, no cost estimate) and a later candidate produces the output, the
project's `metadata.fallbacks[]` lists it and the review screen shows "We used a fallback provider
for the … of this video". Nothing to do beyond the outage itself; owners may regenerate the shot
once the preferred provider is healthy (the regenerate never reuses the fallback's asset).
Reused generations (15.B6, `provider_jobs.operation = '<capability>:reused'`, cost 0) are not
provider traffic and never trip the breaker.
