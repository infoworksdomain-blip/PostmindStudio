# Provider outage during a generation window (priority risk 1)

| | |
| --- | --- |
| **Metric** | `studio_provider_circuit_state{provider}`: 0 closed, 1 half-open, 2 open. The gauge is per process. |
| **Threshold** | Any provider open (2) on any worker. |
| **Escalation** | On-call engineer, then the Eng Lead after 30 min, then the vendor account manager. |

## What happens automatically

- The router skips providers whose circuit is open and routes each shot to the next candidate for
  its `visualTreatment` (spec 6.4). For example, Runway fails over to Luma.
- An open breaker half-opens after 5 minutes and lets probes through.
- In-flight provider jobs poll to completion or fail. Failed shots retry with backoff through
  BullMQ.

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
