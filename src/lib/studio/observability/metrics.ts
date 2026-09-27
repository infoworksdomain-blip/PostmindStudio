import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';

// BACKLOG 11.5 — Prometheus metrics (prom-client 15: the successor @prometheus-io/client needs
// Node 22+). One registry per process: the API serves it at /api/metrics, the worker process on
// its own port. Labels are bounded: routes use the matched template (routeLabel), job names are a closed set.

export interface StudioMetrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  jobDuration: Histogram<'job' | 'outcome'>;
  jobs: Counter<'job' | 'outcome'>;
  queueDepth: Gauge<'queue' | 'state'>;
  breakerState: Gauge<'provider'>;
  /** Spec 12.5: cost alerts raised (each (scope, id, period, threshold) once — cost/alerts.ts). */
  costAlerts: Counter<'scope' | 'threshold'>;
  /** Kill-switch flags engaged per level (sampled from system_flags at scrape time). */
  killSwitchEngaged: Gauge<'level'>;
}

/** Every (scope, threshold) a cost alert can have (cost/caps.ts thresholds per scope). */
export const COST_ALERT_SERIES: ReadonlyArray<{ scope: string; threshold: string }> = [
  ...['80', '90', '100'].map((threshold) => ({ scope: 'project', threshold })),
  ...['org_daily', 'org_provider_daily', 'global_daily'].flatMap((scope) =>
    ['80', '100'].map((threshold) => ({ scope, threshold })),
  ),
];

function build(): StudioMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'postmind-studio' });
  collectDefaultMetrics({ register: registry, prefix: 'studio_' });
  const metrics = {
    registry,
    httpDuration: new Histogram({
      name: 'studio_http_request_duration_seconds',
      help: 'API request duration (spec 17.1: p95 < 300 ms for non-generation calls)',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10],
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'studio_job_duration_seconds',
      help: 'Queue job attempt duration',
      labelNames: ['job', 'outcome'],
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
      registers: [registry],
    }),
    jobs: new Counter({
      name: 'studio_jobs_total',
      help: 'Queue job attempts by outcome (succeeded | retrying | failed)',
      labelNames: ['job', 'outcome'],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: 'studio_queue_jobs',
      help: 'BullMQ jobs per queue and state (sampled at scrape time)',
      labelNames: ['queue', 'state'],
      registers: [registry],
    }),
    breakerState: new Gauge({
      name: 'studio_provider_circuit_state',
      help: 'Provider circuit breaker in this process: 0 closed, 1 half-open, 2 open',
      labelNames: ['provider'],
      registers: [registry],
    }),
    costAlerts: new Counter({
      name: 'studio_cost_alerts_total',
      help: 'Cost alerts raised by scope (project | org_daily | org_provider_daily | global_daily) and threshold percent',
      labelNames: ['scope', 'threshold'],
      registers: [registry],
    }),
    killSwitchEngaged: new Gauge({
      name: 'studio_kill_switch_engaged',
      help: 'Kill-switch flags currently engaged per level (sampled from system_flags at scrape)',
      labelNames: ['level'],
      registers: [registry],
    }),
  };
  // Pre-create the cost-alert series at 0: Prometheus' increase() cannot see the first increment
  // of a series that appears already at 1 (ops/prometheus/studio-alerts.yml relies on this).
  for (const labels of COST_ALERT_SERIES) metrics.costAlerts.inc(labels, 0);
  return metrics;
}

const globalForMetrics = globalThis as unknown as { studioMetrics?: StudioMetrics };

/** Process-wide metrics (kept on globalThis so dev hot-reload doesn't double-register). */
export function getMetrics(): StudioMetrics {
  globalForMetrics.studioMetrics ??= build();
  return globalForMetrics.studioMetrics;
}

/**
 * Route label from the matched route's parameters: /projects/abc/renders with {id: 'abc'} →
 * /projects/:id/renders. Only paths Next.js matched to a route reach here, so labels are
 * bounded by the route templates — never by what a caller puts in the URL.
 */
export function routeLabel(pathname: string, params: Record<string, string | string[]>): string {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) values.set(v, name);
  }
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // malformed escape: compare raw
      }
      const name = values.get(decoded) ?? values.get(segment);
      return name ? `:${name}` : segment;
    })
    .join('/');
}

export const BREAKER_VALUE: Record<string, number> = { closed: 0, half_open: 1, open: 2 };

/** Scrape auth: Bearer METRICS_TOKEN (the endpoint is also meant for private ingress only). */
export function metricsAuthorised(header: string | null, token: string | undefined): boolean {
  if (!token) return false;
  const presented = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
