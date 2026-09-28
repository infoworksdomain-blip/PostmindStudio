# Monitoring deployment: Prometheus + Alertmanager (BACKLOG 14.3)

| | |
| --- | --- |
| **Metric** | `up{job=~"studio-(web|worker)"}`, `probe_success{job="studio-readiness"}`, and the smoke test below. |
| **Threshold** | Every target `up == 1`; the smoke test passes for `page` and `ticket`. |
| **Escalation** | DevOps. |

The alert rules (`ops/prometheus/studio-alerts.yml`) and routing (`ops/alertmanager/alertmanager.yml`)
were committed in Phase 12. This runbook deploys them.

## What is in the repo

- `docker-compose.monitoring.yml` — Prometheus `v2.55.1` and Alertmanager `v0.28.1` (the same
  versions CI validates with), plus the blackbox exporter `v0.28.0` for the readiness probe. It
  joins the app's Docker network (`STUDIO_NETWORK`, default `postmind-studio_default`, i.e. run the
  app with `docker compose -p postmind-studio -f docker-compose.prod.yml …`). The UIs are bound to
  `127.0.0.1` only (9090, 9093): there is no authentication on them, so use an SSH tunnel.
- `ops/prometheus/prometheus.yml` — scrape jobs `studio-web` (`/api/metrics` on every `web`
  replica), `studio-worker` (`:9464/metrics` on every worker service) and `studio-readiness`
  (blackbox `http_2xx` of `http://web:3010/api/health/ready`), all found through Docker DNS so
  scaling needs no config change. Bearer auth reads `/etc/prometheus/secrets/metrics-token`
  (`authorization.credentials_file`, the current form of `bearer_token_file`). Validated in CI
  (`ops-config`: `promtool check config`).
- `scripts/ops/alert-smoke.ts` — posts a synthetic alert per severity to Alertmanager's v2 API,
  checks each reached the right receiver, checks Alertmanager's own delivery counters, then
  resolves the alerts.

## Steps

1. **PagerDuty:** create (or reuse) the Studio service with an **Events API v2** integration and
   copy its integration (routing) key. **Slack:** create an incoming webhook for `#studio-alerts`.
2. On the host, next to the compose files (the `secrets/` folder is git-ignored):
   ```bash
   mkdir -p secrets
   printf '%s' "$METRICS_TOKEN"        > secrets/metrics-token          # the app's METRICS_TOKEN
   printf '%s' "<pagerduty routing key>" > secrets/pagerduty-routing-key
   printf '%s' "<slack webhook url>"     > secrets/slack-webhook-url
   chmod 0444 secrets/*   # the containers run as nobody (uid 65534)
   ```
   Or point `METRICS_TOKEN_FILE`, `PAGERDUTY_ROUTING_KEY_FILE`, `SLACK_WEBHOOK_URL_FILE` at files
   rendered by the secret manager. Never put the values in an env file or the repo.
3. Make sure the app runs with `METRICS_TOKEN` set (web and every worker), otherwise the worker
   metrics listener is off and `StudioTargetDown` fires.
4. Start it: `docker compose -f docker-compose.monitoring.yml up -d`
5. **Verify scraping:** open `http://127.0.0.1:9090/targets` (tunnel). `studio-web`,
   `studio-worker` (one target per worker replica), `studio-readiness`, `prometheus` and
   `alertmanager` are all UP. `http://127.0.0.1:9090/rules` shows the Studio rule groups.

## Smoke test

Tell the on-call first: `severity=page` really pages.

```bash
ALERTMANAGER_URL=http://127.0.0.1:9093 npx tsx scripts/ops/alert-smoke.ts                 # page + ticket
ALERTMANAGER_URL=http://127.0.0.1:9093 npx tsx scripts/ops/alert-smoke.ts --severity ticket  # Slack only
```

- **Routing:** each alert (`alertname=StudioAlertSmoke`, label `smoke_run=<id>`) must reach
  exactly `studio-page` (page) or `studio-ticket` (ticket): `GET /api/v2/alerts` receivers.
- **Delivery:** `alertmanager_notifications_total{integration="pagerduty"|"slack"}` must go up
  with no increase in `alertmanager_notifications_failed_total` (after `group_wait`: 10 s for page,
  30 s for ticket). `--no-delivery` checks routing only.
- Exit code 0 = PASS. The alerts are resolved at the end (`send_resolved`), which closes the
  PagerDuty incident and posts RESOLVED to Slack.
- A delivery FAIL for PagerDuty is usually a wrong routing key (HTTP 400 from Events API v2); for
  Slack, a revoked webhook (HTTP 404 / `no_service`). See `docker compose -f
  docker-compose.monitoring.yml logs alertmanager`.

## Changing things

- Rules or routing: edit `ops/`, let CI validate, then `docker compose -f
  docker-compose.monitoring.yml restart prometheus alertmanager` (the files are mounted read-only).
- Upgrading Prometheus or Alertmanager: change the image tag here **and** in the `ops-config` CI job
  together.

## On Render

`render.yaml` runs the stack as one private service per environment, `studio-monitoring-<env>`,
built from `ops/render/monitoring/Dockerfile`: the same Prometheus v2.55.1, Alertmanager v0.28.1 and
blackbox exporter v0.28.0, with the repo's unchanged `studio-alerts.yml`, `studio-slo.yml` and
`alertmanager.yml`. It stores data on a Render disk at `/data` (5 GB staging, 10 GB production).

- **Why a private service.** On Render, background workers cannot receive private-network traffic,
  so the queue workers are private services too, and Prometheus scrapes them. Each service's
  `<internal-host>-discovery` DNS name resolves to every running instance
  (https://render.com/docs/private-network), so each replica is its own target, as with Docker DNS.
- **Config.** `ops/render/monitoring/prometheus.yml.tmpl` has the same jobs (`studio-web`,
  `studio-worker`, `studio-readiness`) as `ops/prometheus/prometheus.yml`. At start,
  `entrypoint.sh` fills in the internal hostnames (`STUDIO_*_HOST`, from `fromService` `host`),
  writes `METRICS_TOKEN`, `PAGERDUTY_ROUTING_KEY` and `SLACK_WEBHOOK_URL` to the files the
  configs read (mode 0600), removes them from the environment, checks the result with
  `promtool check config`, and starts the three processes. If one exits, the service exits and
  Render restarts it.
- **Secrets.** `METRICS_TOKEN` comes from the `studio-metrics-<env>` group (generated by
  Render). The PagerDuty key and Slack webhook are asked for once, when the Blueprint is created.
  To rotate them, edit them on the service's **Environment** page.
- **The SLO rules are loaded too.** `docker-compose.monitoring.yml`'s `prometheus.yml` loads only
  `studio-alerts.yml`, not `studio-slo.yml`.
- **UIs.** They have no authentication and are not public. Use the service's **Shell**:
  `wget -qO- http://127.0.0.1:9090/api/v1/alerts`. Run the smoke test from the web service's Shell
  with `ALERTMANAGER_URL=http://<monitoring internal host>:9093`
  ([render-deploy.md](render-deploy.md) step 7).
- **Render platform metrics.** CPU, memory, disk and HTTP metrics are on each service's
  **Metrics** page. A Pro workspace can also stream them to an OpenTelemetry provider
  (https://render.com/docs/metrics-streams). That covers the platform, not Studio's own
  `studio_*` metrics, so it complements Prometheus rather than replacing it.
- **Unverified.** The monitoring image has not been built here (no Docker on the build machine).
  CI's `ops-config` job validates the rules and routing it copies. The first Render build is the
  image test.

**GAP:** not deployed in any environment yet — **DevOps** supplies the PagerDuty key and Slack
webhook, runs the steps above on staging then production, and records a passing smoke test.
