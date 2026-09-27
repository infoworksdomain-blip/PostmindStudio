# PostMind Studio runbooks

Operational runbooks for BACKLOG 12.4 (playbook §11). Each one follows the playbook's operational
format: **trigger metric → threshold → escalation → steps → verification**. Gaps are marked
**GAP**: something the runbook needs that does not exist yet. Close every GAP before GA.

| Runbook | Covers | SLO / threshold |
| --- | --- | --- |
| [kill-switch.md](kill-switch.md) | All four kill-switch levels, plus the timed rehearsal (12.2) | 60 s to halt |
| [rollback.md](rollback.md) | Reverting a bad deploy, plus the timed rehearsal (12.3) | 5 min |
| [deploy.md](deploy.md) | Building, migrating and releasing (12.6) | — |
| [backup-recovery.md](backup-recovery.md) | Postgres PITR, S3 versioning, Redis (playbook E-12) | — |
| [provider-outage.md](provider-outage.md) | Priority risk 1: provider outage mid-generation | 1+ breaker OPEN |
| [cost-runaway.md](cost-runaway.md) | Priority risk 2: per-org cost runaway | >80% of daily cap |
| [content-safety-miss.md](content-safety-miss.md) | Priority risk 3: unsafe content published | Any true miss |
| [platform-api-change.md](platform-api-change.md) | Priority risk 4: publishing API breaking change | 1+ adapter test failing |
| [corpus-search-quality.md](corpus-search-quality.md) | Priority risk 5: library search degradation | <80% relevant top-5 |
| [scan-blocked.md](scan-blocked.md) | Priority risk 6: website scan blocked by anti-bot measures | >10% failures on a customer |
| [platform-account-revocation.md](platform-account-revocation.md) | Priority risk 7: platform account revoked | Any account in warning state |
| [storage-cost.md](storage-cost.md) | Priority risk 8: storage cost balloon | >125% of forecast |

## Shared tools

- **Admin API** (platform staff token; the organisation must be in `STUDIO_PLATFORM_ORG_IDS`):
  - `GET|PUT /api/studio/admin/kill-switch`
  - `GET /api/studio/admin/cost`
  - `/api/studio/admin/library/**`

  The Admin Centre UI is at `/admin`.
- **Metrics** (Prometheus, private ingress, `Authorization: Bearer $METRICS_TOKEN`):
  - Web: `GET /api/metrics`.
  - Workers: `:9464/metrics` when `METRICS_TOKEN` is set.
  - Series:
    - `studio_http_request_duration_seconds{method,route,status}`
    - `studio_jobs_total{job,outcome}`
    - `studio_job_duration_seconds{job,outcome}`
    - `studio_queue_jobs{queue,state}`
    - `studio_provider_circuit_state{provider}`
- **Health checks:**
  - `GET /api/health` is liveness.
  - `GET /api/health/ready` checks Postgres and Redis and returns 503 when either is down.
- **Errors:** Sentry, enabled when `SENTRY_DSN` is set. It runs in both the web and the worker processes.
- **Logs:** structured pino JSON. Filter by `correlationId`, `organisationId` or `projectId`.
- **Load and rehearsal tooling:**
  - `load-test/k6/studio-api.js`
  - `scripts/ops/rehearse-kill-switch.ts`

## GAP: alerting

The metrics and thresholds above exist, but no Prometheus alert rules or paging integration are
committed yet. DevOps owns wiring these alert expressions in the ops monitoring stack:

- **Breaker open:** `max by (provider) (studio_provider_circuit_state) > 0`. Check the gauge
  encoding in `src/lib/studio/observability/metrics.ts`.
- **Queue backlog:** `sum by (queue) (studio_queue_jobs{state="waiting"})` above the per-queue
  baseline for 10 minutes.
- **Job failure rate:** `sum(rate(studio_jobs_total{outcome="failed"}[5m])) / sum(rate(studio_jobs_total[5m])) > 0.05`.
- **API latency SLO:** `histogram_quantile(0.95, sum by (le) (rate(studio_http_request_duration_seconds_bucket[5m]))) > 0.3`.
- **Readiness:** the load balancer target marks unhealthy on `/api/health/ready`.
