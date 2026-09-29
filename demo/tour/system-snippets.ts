// Verbatim excerpts from the repository, shown on #/tour/system. Keep in step with the sources:
//   ops/prometheus/studio-alerts.yml, ops/alertmanager/alertmanager.yml,
//   load-test/k6/studio-api.js, docker-compose.prod.yml.

export const ALERT_RULES = `# ops/prometheus/studio-alerts.yml (excerpt — 14 rules in 5 groups)
groups:
  - name: studio-availability
    rules:
      - alert: StudioTargetDown
        expr: up{job=~"studio-(web|worker)"} == 0
        for: 2m
        labels:
          severity: page
        annotations:
          summary: 'Studio {{ $labels.job }} target {{ $labels.instance }} is down'
          runbook_url: …/runbooks/service-health.md#target-down

      - alert: StudioApiLatencyP95High
        # Spec 17.1: API (non-generation) p95 < 300 ms.
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(studio_http_request_duration_seconds_bucket{job="studio-web"}[5m]))
          ) > 0.3
        for: 10m
        labels:
          severity: ticket

  - name: studio-jobs
    rules:
      - alert: StudioJobFailureRateHigh
        # Final failures (after retries) over final outcomes; retries are not failures yet.
        expr: |
          sum(rate(studio_jobs_total{outcome="failed"}[10m]))
            /
          sum(rate(studio_jobs_total{outcome=~"succeeded|failed"}[10m]))
          > 0.05
        for: 10m
        labels:
          severity: page

  - name: studio-providers
    rules:
      - alert: StudioProviderCircuitOpen
        # Gauge encoding: 0 closed, 1 half-open, 2 open (shared via Redis since 13.16; max across processes).
        expr: max by (provider) (studio_provider_circuit_state) == 2
        for: 5m
        labels:
          severity: ticket

  - name: studio-cost
    rules:
      - alert: StudioGlobalCostCap
        # Platform-wide spend: 80% pages so someone can act before everything pauses at 100%.
        expr: sum by (threshold) (increase(studio_cost_alerts_total{scope="global_daily"}[15m])) > 0
        labels:
          severity: page

  - name: studio-kill-switch
    rules:
      - alert: StudioGlobalKillSwitchEngaged
        expr: max(studio_kill_switch_engaged{level="global"}) > 0
        labels:
          severity: page`;

export const ALERT_RULE_NAMES: { name: string; severity: 'page' | 'ticket'; group: string }[] = [
  { name: 'StudioTargetDown', severity: 'page', group: 'availability' },
  { name: 'StudioNotReady', severity: 'page', group: 'availability' },
  { name: 'StudioApiLatencyP95High', severity: 'ticket', group: 'availability' },
  { name: 'StudioJobFailureRateHigh', severity: 'page', group: 'jobs' },
  { name: 'StudioQueueBacklog', severity: 'ticket', group: 'jobs' },
  { name: 'StudioDeadLetterGrowing', severity: 'ticket', group: 'jobs' },
  { name: 'StudioProviderCircuitOpen', severity: 'ticket', group: 'providers' },
  { name: 'StudioProviderFailoverRateHigh', severity: 'ticket', group: 'providers' },
  { name: 'StudioProviderCircuitsOpenMultiple', severity: 'page', group: 'providers' },
  { name: 'StudioCostCapWarning', severity: 'ticket', group: 'cost' },
  { name: 'StudioCostCapReached', severity: 'ticket', group: 'cost' },
  { name: 'StudioGlobalCostCap', severity: 'page', group: 'cost' },
  { name: 'StudioGlobalKillSwitchEngaged', severity: 'page', group: 'kill switch' },
  { name: 'StudioKillSwitchLeftEngaged', severity: 'ticket', group: 'kill switch' },
];

export const ALERTMANAGER = `# ops/alertmanager/alertmanager.yml (excerpt)
route:
  receiver: studio-ticket
  group_by: [alertname, severity]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers:
        - severity="page"
      receiver: studio-page
      group_wait: 10s
      repeat_interval: 1h
    - matchers:
        - severity="ticket"
      receiver: studio-ticket

inhibit_rules:
  # A target that is down also trips latency / backlog tickets: page only for the root cause.
  - source_matchers:
      - alertname="StudioTargetDown"
    target_matchers:
      - severity="ticket"
    equal: [instance]
  # While the global kill switch is engaged, halted work is expected: silence job/queue noise.
  - source_matchers:
      - alertname="StudioGlobalKillSwitchEngaged"
    target_matchers:
      - alertname=~"StudioJobFailureRateHigh|StudioQueueBacklog|StudioDeadLetterGrowing"

receivers:
  - name: studio-page
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/pagerduty-routing-key
        send_resolved: true
        severity: critical
  - name: studio-ticket
    slack_configs:
      - api_url_file: /etc/alertmanager/secrets/slack-webhook-url
        channel: '#studio-alerts'
        send_resolved: true`;

export const K6_OPTIONS = `// load-test/k6/studio-api.js (excerpt)
const PROFILES = {
  smoke: { vus: 5, duration: '50s' },
  full: {
    stages: [
      { duration: '30s', target: TARGET_VUS }, // ramp
      { duration: '90s', target: TARGET_VUS }, // steady
      { duration: '20s', target: TARGET_VUS * 3 }, // 3x spike
      { duration: '60s', target: TARGET_VUS }, // recover
      { duration: '30s', target: 0 }, // ramp-down
    ],
  },
};

export const options = {
  ...(PROFILES[MODE] || PROFILES.smoke),
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<2000'],
    studio_read_latency: ['p(95)<300'],
    studio_write_latency: ['p(95)<500'],
    studio_errors: ['rate<0.001'],
    // Rate limiting is expected under the spike; anything else non-2xx counts as an error.
    checks: ['rate>0.999'],
  },
};`;

export const K6_RUN = `$ k6 run --env RUN_MODE=smoke --env BASE_URL=https://studio-staging.postmind.ai \\
    --env STUDIO_TOKEN=$STAGING_POSTMIND_JWT --env BUSINESS_ID=$LOADTEST_BUSINESS_ID \\
    load-test/k6/studio-api.js
# Writes are OFF unless WRITES=1; with writes on it creates DRAFT projects only and never
# calls /generate, so no provider spend. (Not yet run: needs staging — see Not built yet.)`;
