import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';

// BACKLOG 11.5 — Prometheus metrics (prom-client 15: the successor @prometheus-io/client needs
// Node 22+). One registry per process: the API serves it at /api/metrics, the worker process on
// its own port. Labels are bounded: routes are normalised (ids → :id), job names are a closed set.

export interface StudioMetrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  jobDuration: Histogram<'job' | 'outcome'>;
  jobs: Counter<'job' | 'outcome'>;
  queueDepth: Gauge<'queue' | 'state'>;
  breakerState: Gauge<'provider'>;
}

function build(): StudioMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'postmind-studio' });
  collectDefaultMetrics({ register: registry, prefix: 'studio_' });
  return {
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
  };
}

const globalForMetrics = globalThis as unknown as { studioMetrics?: StudioMetrics };

/** Process-wide metrics (kept on globalThis so dev hot-reload doesn't double-register). */
export function getMetrics(): StudioMetrics {
  globalForMetrics.studioMetrics ??= build();
  return globalForMetrics.studioMetrics;
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|c[a-z0-9]{20,}|[A-Za-z0-9_-]{24,}|\d+)$/;

/** /api/studio/projects/cmf1…/renders → /api/studio/projects/:id/renders */
export function normaliseRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
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
