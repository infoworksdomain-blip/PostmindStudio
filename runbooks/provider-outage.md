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
