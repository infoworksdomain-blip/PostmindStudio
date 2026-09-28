# Retry and alerting recipe — Core → Studio internal calls

For the **PostMind Core team** (BACKLOG 14.10). Studio cannot see a call Core never made or gave up
on, so retries and alerts for these calls live in Core. This is the recipe Studio recommends; it
matches how the calls behave (see `openapi.json`).

## What is safe to retry

Every internal operation is **idempotent** on Studio's side:

| Operation | Why a repeat is harmless |
| --- | --- |
| `registerChannel` | Upsert on (organisationId, platform, platformAccountId): a repeat returns 200 with the same `channel.id`. |
| `disconnectChannel`, `disconnectChannelByAccount` | Disconnecting a disconnected channel returns 200 again. |
| `pushRefreshedTokens` | Stores the same token again. |
| `purgeOrganisation` | Re-applies the purge, keeps the first `graceUntil`, returns `repeated: true`. |

So a call whose response was lost (timeout, connection reset) can simply be sent again.

**Order matters for one channel:** a `registerChannel` retried *after* a later
`disconnectChannel` for the same account would reconnect it. Serialise calls per
(organisationId, platform, platformAccountId), for example one queue key per account, and drop a
queued register when a newer disconnect for the same account exists.

## Layer 1 — in-process retries (the client does this)

`client/studio-internal-client.ts`:

- Retries network errors, per-attempt timeouts (10 s) and HTTP 408, 425, 429, 500, 502, 503, 504.
- Waits `Retry-After` when Studio sends it (429 from the internal rate limit,
  `STUDIO_INTERNAL_RATE_LIMIT_PER_MIN`, default 600 a minute), clamped to 60 s. `Retry-After` is
  defined in RFC 9110 §10.2.3 (<https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3>): either
  delay-seconds or an HTTP-date; the client accepts both.
- Otherwise waits a random time between 0 and `min(30 s, 0.5 s × 2^(attempt−1))` ("full jitter",
  as described in the AWS Architecture Blog post *Exponential Backoff And Jitter*,
  <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>), so many Core
  workers do not retry in lockstep.
- Five attempts by default (about 15 s worst case without `Retry-After`).
- Does **not** retry 400, 401, 403, 404, 409, 413: they fail the same way again.
- Sends one `x-correlation-id` on every attempt of a call; Studio logs under it and echoes it.
  Log it in Core too, so one id finds the call on both sides.

## Layer 2 — durable retries (Core's job queue)

When the client throws `StudioInternalError` with `retryable: true` (retries exhausted), put the
call on Core's durable queue (whatever Core uses for Engagement's calls) and retry it for longer:
for example every 5, 15, 60 minutes, then hourly for 24 hours. After that, dead-letter it and
alert (below). Keep the payload encrypted at rest: `registerChannel` and `pushRefreshedTokens`
carry access tokens. Never log request bodies.

Non-retryable errors need a decision, not a retry:

| Status / code | Meaning | Core should |
| --- | --- | --- |
| `401 unauthorized` | Service tokens differ (rotation in progress, or misconfigured). | Alert immediately (every call will fail). During a planned rotation, hold and retry. |
| `404` on **every** path | Studio's internal API is disabled (`STUDIO_INTERNAL_SERVICE_TOKEN` unset / too short) or not routed. | Alert immediately. |
| `404 not_found` on `pushRefreshedTokens` (single) / result `not_found` (batch) | Studio never got the registration. | Call `registerChannel` with the full channel details. |
| `409 conflict` / result `revoked` | The channel was disconnected in Studio. | Stop refreshing it; only a new registration (user reconnects) revives it. |
| `400 validation_error` | Core sent a malformed body; `details.issues` lists paths and messages (never values). | Fix the caller; alert as a bug. |
| `413 payload_too_large` | Body over 64 KB. | Send smaller batches (≤ 100 channels already fits). |

## Layer 3 — alerting (in Core's monitoring)

Emit a counter per call outcome, for example
`studio_internal_calls_total{operation, outcome="ok|retried|failed_retryable|failed_permanent", status}`,
and page on:

| Alert | Condition (suggested) | Severity |
| --- | --- | --- |
| Studio internal API unreachable or refusing auth | any `401`, or `404` on every call, for 5 minutes | page |
| Calls dead-lettered | any call reaching the dead-letter queue | page |
| Purge not delivered | a `purgeOrganisation` not acknowledged (202) within 1 hour of the org deletion | page (data-protection obligation) |
| Retry backlog growing | durable-queue depth for Studio calls > 100 for 15 minutes | ticket |
| Refresh results `not_found` / `revoked` | > 1 % of a nightly batch | ticket (drift between Core and Studio) |

If Core runs Prometheus, the two paging rules look like this (the metric name is Core's choice):

```yaml
groups:
  - name: core-to-studio
    rules:
      - alert: StudioInternalAuthFailing
        # Every call in the window was a 401, or a 404 from a disabled / unrouted internal API.
        expr: |
          sum(increase(studio_internal_calls_total{status=~"401|404"}[5m])) > 0
          unless sum(increase(studio_internal_calls_total{status!~"401|404"}[5m])) > 0
        for: 5m
        labels: { severity: page }
      - alert: StudioInternalCallsDeadLettered
        expr: increase(studio_internal_calls_total{outcome="failed_retryable"}[15m]) > 0
        labels: { severity: page }
```

## Studio's side of the same failures

- Studio logs every rejected internal request (`studio internal request rejected`, with status
  and correlation id, never the body) and every 5xx (`studio internal api error`, also sent to
  Sentry). Its HTTP duration metrics carry the internal routes.
- Until Core ships list-channels (see README "What Studio needs from Core"), a call Core drops is
  invisible to Studio. Once it ships, Studio's daily `reconcile-channels` job detects and repairs
  missed disconnects and reports missed registrations.
- Runbook: `runbooks/platform-account-revocation.md` (symptoms per status code, token rotation).
