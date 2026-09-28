# PostMind Studio runbooks

Operational runbooks for BACKLOG 12.4 (playbook §11). Each one follows the playbook's operational
format: **trigger metric → threshold → escalation → steps → verification**. Gaps are marked
**GAP**: something the runbook needs that does not exist yet. Close every GAP before GA.

| Runbook | Covers | SLO / threshold |
| --- | --- | --- |
| [kill-switch.md](kill-switch.md) | All four kill-switch levels, the per-platform publishing halt, re-drive after release, and the timed rehearsal (12.2) | 60 s to halt |
| [rollback.md](rollback.md) | Reverting a bad deploy, plus the timed rehearsal (12.3) | 5 min |
| [deploy.md](deploy.md) | Building, migrating and releasing (12.6) | — |
| [backup-recovery.md](backup-recovery.md) | Postgres PITR, S3 versioning, Redis (playbook E-12) | — |
| [provider-outage.md](provider-outage.md) | Priority risk 1: provider outage mid-generation | 1+ breaker OPEN |
| [cost-runaway.md](cost-runaway.md) | Priority risk 2: cost runaway — project / org / provider / global caps, pause, alerts | 80% alert, 90% project pause, 100% daily pause |
| [service-health.md](service-health.md) | Availability and queue alerts: target down, not ready, job failures, API latency, backlog, dead letter | per alert |
| [content-safety-miss.md](content-safety-miss.md) | Priority risk 3: unsafe content published | Any true miss |
| [review-publish-automation.md](review-publish-automation.md) | Auto-approve for trusted creators, auto-publish on approval, templates | Any auto-approved takedown |
| [platform-api-change.md](platform-api-change.md) | Priority risk 4: publishing API breaking change | 1+ adapter test failing |
| [corpus-ingestion.md](corpus-ingestion.md) | Library corpus: sample run → operator review → full 50k run, monitoring, failures, throughput and cost (9.2 / 9.3) | >5% failures over 1 h |
| [corpus-search-quality.md](corpus-search-quality.md) | Priority risk 5: library search degradation | <80% relevant top-5 |
| [scan-blocked.md](scan-blocked.md) | Priority risk 6: website scan blocked by anti-bot measures | >10% failures on a customer |
| [platform-account-revocation.md](platform-account-revocation.md) | Priority risk 7: platform account revoked | Any account in warning state |
| [storage-cost.md](storage-cost.md) | Priority risk 8: storage cost balloon | >125% of forecast |
| [notifications-email.md](notifications-email.md) | Notification email delivery status and the pending Core-vs-Studio sending decision (13.33) | Any `failed` once live |
| [slo-and-launch-readiness.md](slo-and-launch-readiness.md) | Spec 17.1 SLO / spec 3.5 acceptance alerts, A14.2 launch-readiness checks (overlay pixel diff, classifier eval, scan timing, A10 cost gate) and the daily provider canary (15.D9 / 15.D10) | per alert |

## Shared tools

- **Admin API** (platform staff token; the organisation must be in `STUDIO_PLATFORM_ORG_IDS`):
  - `GET|PUT /api/studio/admin/kill-switch` (four levels plus the per-platform publishing halt)
  - `POST /api/studio/admin/redrive` (bulk re-drive of kill-switched or stuck work; dry run by
    default; capability `studio:admin:redrive`)
  - `GET /api/studio/admin/cost`
  - `GET /api/studio/admin/cost/caps` (today's spend against every cap + cost alerts, 7 days)
  - `/api/studio/admin/library/**` (incl. `GET …/library/ingest/status`; corpus tool
    `scripts/ops/ingest-corpus.ts`, see corpus-ingestion.md)

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
    - `studio_cost_alerts_total{scope,threshold}` (every series pre-created at 0)
    - `studio_kill_switch_engaged{level}` (web only; sampled from `system_flags` at scrape)
- **Health checks:**
  - `GET /api/health` is liveness.
  - `GET /api/health/ready` checks Postgres and Redis and returns 503 when either is down.
- **Errors:** Sentry, enabled when `SENTRY_DSN` is set. It runs in both the web and the worker processes.
- **Logs:** structured pino JSON. Filter by `correlationId`, `organisationId` or `projectId`.
- **Load and rehearsal tooling:**
  - `load-test/k6/studio-api.js`
  - `scripts/ops/rehearse-kill-switch.ts`
  - `scripts/ops/redrive.ts` (re-drive CLI; dry run unless `--apply`)

## Alerting

Alert rules and paging are committed (Phase 12) and validated in CI (`ops-config` job:
`promtool check rules`, `promtool test rules`, `amtool check-config` and a routing test):

- `ops/prometheus/studio-alerts.yml` — rule groups availability, jobs, providers, cost and kill
  switch. Every alert has `severity` (`page` or `ticket`) and a `runbook_url` into this folder.
- `ops/prometheus/tests/studio-alerts.test.yml` — promtool unit tests (target down, global cost
  cap incl. the first alert of a process, job failure rate).
- `ops/prometheus/studio-slo.yml` + `tests/studio-slo.test.yml` (15.D9) — spec 17.1 latency SLO
  and spec 3.5 acceptance recording rules and alerts (slo-and-launch-readiness.md).
- `ops/alertmanager/alertmanager.yml` — `severity=page` → PagerDuty, `severity=ticket` → Slack
  `#studio-alerts`. The PagerDuty routing key and Slack webhook URL are read from files
  (`/etc/alertmanager/secrets/pagerduty-routing-key`, `/etc/alertmanager/secrets/slack-webhook-url`)
  mounted by the deployment — never committed.

Scrape jobs the rules assume: `studio-web` (`/api/metrics` on each web replica), `studio-worker`
(`:9464/metrics` on each worker) and `studio-readiness` (a blackbox-exporter `http_2xx` probe of
`/api/health/ready`). All need `Authorization: Bearer $METRICS_TOKEN` except the blackbox probe.

In-app notifications (spec 14.4) are separate from paging: `GET /api/studio/notifications`
(bell in the app header) and, optionally, a signed webhook (`STUDIO_NOTIFY_WEBHOOK_URL`) for
cost 80% / 100% / paused, generation complete, approval pending > 2 h and publication failed.

## GAP: remaining alerting work

- **Not wired in any environment yet:** DevOps must add the scrape jobs above, load the rule file
  into Prometheus, deploy Alertmanager with the two secret files, and create the PagerDuty
  service / Slack channel. Nothing here has paged a human yet.
- **Thresholds are starting points:** the 500-job backlog and 5% failure rate need tuning after
  the k6 run (BACKLOG 12.1) and the first weeks of real traffic.
- **Email** delivery waits for an operator decision (notifications-email.md). Opted-in email is
  recorded as `pending_setup`; the webhook is the bridge until then.
