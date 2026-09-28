import { ValidationError } from '../../errors';

// BACKLOG 14.3 — logic for scripts/ops/alert-smoke.ts, free of I/O so it is unit tested.
// Alertmanager API v2 (api/v2/openapi.yaml, prometheus/alertmanager v0.28.1):
//   POST /api/v2/alerts            body: postableAlerts = [{ labels, annotations, startsAt,
//                                  endsAt, generatorURL }]; 200 on success
//   GET  /api/v2/alerts?filter=…   gettableAlert[] with receivers: [{ name }] and status.state
// Delivery is confirmed from Alertmanager's own counters on GET /metrics:
//   alertmanager_notifications_total{integration="pagerduty"|"slack"}
//   alertmanager_notifications_failed_total{integration=…,reason=…}
// Receivers and integrations come from ops/alertmanager/alertmanager.yml.

export const SMOKE_ALERTNAME = 'StudioAlertSmoke';

export const EXPECTED_ROUTES = {
  page: { receiver: 'studio-page', integration: 'pagerduty' },
  ticket: { receiver: 'studio-ticket', integration: 'slack' },
} as const;

export type Severity = keyof typeof EXPECTED_ROUTES;

export interface PostableAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
}

export interface GettableAlert {
  labels: Record<string, string>;
  receivers: { name: string }[];
  status: { state: string };
}

export function parseSeverities(value: string | undefined): Severity[] {
  const raw = (value ?? 'page,ticket').split(',').map((s) => s.trim());
  const bad = raw.filter((s) => !(s in EXPECTED_ROUTES));
  if (bad.length || raw.length === 0) {
    throw new ValidationError(`--severity takes page, ticket or page,ticket (got ${value})`);
  }
  return [...new Set(raw)] as Severity[];
}

/** One synthetic alert per severity, tagged with a run id so this run's alerts can be found. */
export function buildSmokeAlerts(
  runId: string,
  severities: Severity[],
  nowMs: number,
  options: { ttlMs?: number; resolved?: boolean } = {},
): PostableAlert[] {
  const endsAt = options.resolved ? nowMs : nowMs + (options.ttlMs ?? 10 * 60_000);
  return severities.map((severity) => ({
    labels: { alertname: SMOKE_ALERTNAME, severity, smoke_run: runId, service: 'postmind-studio' },
    annotations: {
      summary: `Studio alerting smoke test (${severity}) — run ${runId}. Safe to acknowledge.`,
      runbook_url:
        'https://github.com/infoworksdomain-blip/PostmindStudio/blob/main/runbooks/monitoring-deploy.md#smoke-test',
    },
    startsAt: new Date(nowMs - 1_000).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    generatorURL: 'https://studio.postmind.ai/ops/alert-smoke',
  }));
}

/** GET /api/v2/alerts filter for this run (repeatable `filter` query parameter). */
export function alertsQuery(runId: string): string {
  const filters = [`alertname="${SMOKE_ALERTNAME}"`, `smoke_run="${runId}"`];
  return filters.map((f) => `filter=${encodeURIComponent(f)}`).join('&');
}

export interface RoutingResult {
  severity: Severity;
  found: boolean;
  receivers: string[];
  ok: boolean;
}

/** Did each severity's alert reach exactly its expected receiver? */
export function checkRouting(
  alerts: GettableAlert[],
  runId: string,
  severities: Severity[],
): RoutingResult[] {
  return severities.map((severity) => {
    const alert = alerts.find(
      (a) => a.labels.smoke_run === runId && a.labels.severity === severity,
    );
    const receivers = (alert?.receivers ?? []).map((r) => r.name).sort();
    return {
      severity,
      found: Boolean(alert),
      receivers,
      ok: receivers.length === 1 && receivers[0] === EXPECTED_ROUTES[severity].receiver,
    };
  });
}

export type NotificationCounters = Record<string, { total: number; failed: number }>;

const SAMPLE =
  /^(alertmanager_notifications(?:_failed)?_total)\{([^}]*)\}\s+([0-9.eE+-]+)(?:\s+\d+)?$/;

/** Sums alertmanager_notifications[_failed]_total per integration from a /metrics body. */
export function parseNotificationCounters(metrics: string): NotificationCounters {
  const out: NotificationCounters = {};
  for (const line of metrics.split('\n')) {
    const m = SAMPLE.exec(line.trim());
    if (!m) continue;
    const integration = /(?:^|,)integration="([^"]*)"/.exec(m[2] ?? '')?.[1];
    if (!integration) continue;
    const entry = (out[integration] ??= { total: 0, failed: 0 });
    const value = Number(m[3]);
    if (m[1] === 'alertmanager_notifications_total') entry.total += value;
    else entry.failed += value;
  }
  return out;
}

export interface DeliveryResult {
  severity: Severity;
  integration: string;
  sent: number;
  failed: number;
  ok: boolean;
}

/** Notifications attempted / failed per expected integration between two scrapes. */
export function deliveryDelta(
  before: NotificationCounters,
  after: NotificationCounters,
  severities: Severity[],
): DeliveryResult[] {
  return severities.map((severity) => {
    const integration = EXPECTED_ROUTES[severity].integration;
    const b = before[integration] ?? { total: 0, failed: 0 };
    const a = after[integration] ?? { total: 0, failed: 0 };
    const sent = a.total - b.total;
    const failed = a.failed - b.failed;
    return { severity, integration, sent, failed, ok: sent > 0 && failed === 0 };
  });
}

export function formatSmokeReport(
  runId: string,
  routing: RoutingResult[],
  delivery: DeliveryResult[] | null,
): string {
  const lines = [`Alertmanager smoke test, run ${runId}`];
  for (const r of routing) {
    const expected = EXPECTED_ROUTES[r.severity].receiver;
    lines.push(
      `  routing  ${r.severity.padEnd(6)} → ${r.found ? r.receivers.join(', ') || '(none)' : 'NOT FOUND'}` +
        `  expected ${expected}  ${r.ok ? 'PASS' : 'FAIL'}`,
    );
  }
  if (delivery) {
    for (const d of delivery) {
      lines.push(
        `  delivery ${d.severity.padEnd(6)} → ${d.integration}: sent ${d.sent}, failed ${d.failed}  ${d.ok ? 'PASS' : 'FAIL'}`,
      );
    }
  } else lines.push('  delivery not checked (--no-delivery)');
  return lines.join('\n');
}
