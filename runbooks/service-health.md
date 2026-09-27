# Service health alerts

Runbook for the availability and queue alerts in `ops/prometheus/studio-alerts.yml`. Each alert
links to its section here via `runbook_url`. Provider, cost and kill-switch alerts have their
own runbooks ([provider-outage.md](provider-outage.md), [cost-runaway.md](cost-runaway.md),
[kill-switch.md](kill-switch.md)).

| Alert | Severity | Threshold |
| --- | --- | --- |
| StudioTargetDown | page | a web or worker target unscrapeable for 2 min |
| StudioNotReady | page | `/api/health/ready` failing for 2 min |
| StudioJobFailureRateHigh | page | > 5% of final job outcomes failed over 10 min, for 10 min |
| StudioApiLatencyP95High | ticket | API p95 > 300 ms for 10 min (spec 17.1) |
| StudioQueueBacklog | ticket | > 500 waiting jobs on one queue for 10 min |
| StudioDeadLetterGrowing | ticket | > 20 new failed (dead-letter) jobs on one queue in 30 min |

## Target down

1. Check the orchestrator: is the pod/container running, restarting or OOM-killed?
2. If every web or worker target is down after a deploy, roll back ([rollback.md](rollback.md)).
3. If only the metrics endpoint is failing, check `METRICS_TOKEN` matches the scrape config (a
   wrong token answers 404, which Prometheus reports as down).

## Not ready

`/api/health/ready` reports `postgres` and `redis` separately (`up`/`down` + latency).

1. Postgres down: see [backup-recovery.md](backup-recovery.md); workers pause on DB errors and
   retry with backoff.
2. Redis down: queues stop; BullMQ reconnects automatically. Jobs in flight are retried; see
   [backup-recovery.md](backup-recovery.md) for the Redis section.

## API latency

1. Break the p95 down by route:
   `histogram_quantile(0.95, sum by (le, route) (rate(studio_http_request_duration_seconds_bucket[5m])))`.
2. A single slow route: look for a missing index or an unbounded query in its service.
3. Everything slow: check DB CPU/connections and whether the load test or a traffic spike is
   running. Scale web replicas (`docker-compose.prod.yml`).

## Job failures

1. Which job? `sum by (exported_job) (rate(studio_jobs_total{outcome="failed"}[10m]))`
   (Prometheus renames the metric's `job` label to `exported_job`).
2. Read the final error in the logs (`job attempt failed`, `final: true`) or Sentry.
3. Provider-shaped failures: [provider-outage.md](provider-outage.md). `cost_cap_paused`
   failures are deliberate: [cost-runaway.md](cost-runaway.md). `kill_switch_*`: someone engaged
   the switch ([kill-switch.md](kill-switch.md)).
4. After the cause is fixed, re-drive the failed work (Admin Centre → re-drive, or
   `scripts/ops/redrive.ts`).

## Queue backlog

1. Are workers for that queue running (`npm run worker -- <queue>`)? `StudioTargetDown` for the
   worker usually fires too.
2. Is a kill switch engaged? Held work waits by design.
3. Scale the queue's worker service; tune the 500 threshold per queue after the k6 run.

## Dead letter

Failed jobs are never auto-drained (spec 11.5). Inspect them, fix the cause, then re-drive.
The alert only measures growth; the absolute count is `studio_queue_jobs{state="failed"}`.
