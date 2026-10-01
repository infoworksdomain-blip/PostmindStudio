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
  /**
   * 17.4: a router candidate passed over for a run-time reason (circuit_open, provider_disabled,
   * over_budget, too_slow, no_cost_estimate), and a candidate selected. Their ratio per provider
   * is its failover rate (ops/prometheus/studio-alerts.yml StudioProviderFailoverRateHigh).
   */
  providerPassedOver: Counter<'provider' | 'reason'>;
  providerSelected: Counter<'provider'>;
  /** Spec 12.5: cost alerts raised (each (scope, id, period, threshold) once — cost/alerts.ts). */
  costAlerts: Counter<'scope' | 'threshold'>;
  /** Kill-switch flags engaged per level (sampled from system_flags at scrape time). */
  killSwitchEngaged: Gauge<'level'>;
  /** 15.D9 / spec 17.1: generate call → READY_FOR_REVIEW, by kind (observability/slo.ts). */
  generationDuration: Histogram<'kind'>;
  /** 15.D9 / spec 17.1: approve (or the publication's due time) → platform live. */
  publishLatency: Histogram<'platform'>;
  /** 15.D9 / spec 17.1: publishedAt → first analytics sample stored. */
  analyticsFirstMetric: Histogram<'platform'>;
  /** 15.D9 / spec 3.5: publications by final outcome (first_attempt | after_retry | failed). */
  publications: Counter<'platform' | 'outcome'>;
  /** 15.D9 / spec 3.5: rendered videos through the quality gate (pass | fail). */
  qualityGate: Counter<'result'>;
  /** 20.15: library read-through cache lookups by cache (list, detail, …) and hit | miss | error. */
  libraryCache: Counter<'cache' | 'result'>;
}

/** 15.D9 kinds of generation (observability/slo.ts generationKind). */
export const GENERATION_KINDS = ['short_form', 'long_form', 'slideshow'] as const;
export const PUBLICATION_OUTCOMES = ['first_attempt', 'after_retry', 'failed'] as const;
export const QUALITY_RESULTS = ['pass', 'fail'] as const;

/** Every (scope, threshold) a cost alert can have (cost/caps.ts thresholds per scope). */
export const COST_ALERT_SERIES: ReadonlyArray<{ scope: string; threshold: string }> = [
  ...['80', '90', '100'].map((threshold) => ({ scope: 'project', threshold })),
  ...['org_daily', 'org_monthly', 'org_provider_daily', 'global_daily'].flatMap((scope) =>
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
    providerPassedOver: new Counter({
      name: 'studio_provider_passed_over_total',
      help: 'Router candidates passed over for a run-time reason (circuit_open | provider_disabled | over_budget | too_slow | no_cost_estimate | account_unavailable)',
      labelNames: ['provider', 'reason'],
      registers: [registry],
    }),
    providerSelected: new Counter({
      name: 'studio_provider_selected_total',
      help: 'Router decisions by the provider selected',
      labelNames: ['provider'],
      registers: [registry],
    }),
    costAlerts: new Counter({
      name: 'studio_cost_alerts_total',
      help: 'Cost alerts raised by scope (project | org_daily | org_monthly | org_provider_daily | global_daily) and threshold percent',
      labelNames: ['scope', 'threshold'],
      registers: [registry],
    }),
    killSwitchEngaged: new Gauge({
      name: 'studio_kill_switch_engaged',
      help: 'Kill-switch flags currently engaged per level (sampled from system_flags at scrape)',
      labelNames: ['level'],
      registers: [registry],
    }),
    // 15.D9 SLO histograms. Every spec 17.1 threshold is a bucket boundary so the recording
    // rules (ops/prometheus/studio-slo.yml) can read the exact share under it.
    generationDuration: new Histogram({
      name: 'studio_generation_seconds',
      help: 'Generate call to READY_FOR_REVIEW by kind (spec 17.1: short p50 < 4 min / p95 < 10 min; long-form p50 < 15 min / p95 < 40 min)',
      labelNames: ['kind'],
      buckets: [60, 120, 180, 240, 300, 450, 600, 900, 1200, 1800, 2400, 3600, 5400],
      registers: [registry],
    }),
    publishLatency: new Histogram({
      name: 'studio_publish_latency_seconds',
      help: 'Approve (or scheduled time, if later) to platform live (spec 17.1: p95 < 3 min)',
      labelNames: ['platform'],
      buckets: [10, 30, 60, 90, 120, 180, 300, 600, 1800, 3600],
      registers: [registry],
    }),
    analyticsFirstMetric: new Histogram({
      name: 'studio_analytics_first_metric_seconds',
      help: 'publishedAt to the first analytics sample (spec 17.1: within 5 min)',
      labelNames: ['platform'],
      buckets: [30, 60, 120, 180, 300, 600, 1800, 3600],
      registers: [registry],
    }),
    publications: new Counter({
      name: 'studio_publications_total',
      help: 'Publications by final outcome: first_attempt | after_retry | failed (spec 3.5: first attempt 98%+)',
      labelNames: ['platform', 'outcome'],
      registers: [registry],
    }),
    qualityGate: new Counter({
      name: 'studio_quality_gate_renders_total',
      help: 'Renders evaluated by the quality gate: pass | fail (spec 3.5: 92%+ pass)',
      labelNames: ['result'],
      registers: [registry],
    }),
    libraryCache: new Counter({
      name: 'studio_library_cache_total',
      help: 'Library cache lookups by cache and result (hit | miss | error); 20.15',
      labelNames: ['cache', 'result'],
      registers: [registry],
    }),
  };
  // Pre-create the cost-alert series at 0: Prometheus' increase() cannot see the first increment
  // of a series that appears already at 1 (ops/prometheus/studio-alerts.yml relies on this).
  for (const labels of COST_ALERT_SERIES) metrics.costAlerts.inc(labels, 0);
  for (const result of QUALITY_RESULTS) metrics.qualityGate.inc({ result }, 0);
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
