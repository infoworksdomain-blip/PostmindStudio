import { afterEach, describe, expect, it } from 'vitest';
import { GET as ready } from '../../src/app/api/health/ready/route';
import { GET as metrics } from '../../src/app/api/metrics/route';
import { getMetrics } from '../../src/lib/studio/observability/metrics';

// BACKLOG 11.5 / 11.7: readiness reports each dependency; /api/metrics is hidden without a
// token, rejects a wrong one, and serves Prometheus text with the right one.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('health and metrics endpoints', { timeout: 30_000 }, () => {
  const saved = { token: process.env.METRICS_TOKEN, redis: process.env.REDIS_URL };

  afterEach(() => {
    process.env.METRICS_TOKEN = saved.token;
  });

  it('reports database and redis readiness', async () => {
    if (!process.env.REDIS_URL) process.env.REDIS_URL = 'redis://127.0.0.1:6399/3'; // nothing listens
    const res = await ready();
    const body = (await res.json()) as { ok: boolean; checks: Record<string, { status: string }> };
    expect(body.checks.database?.status).toBe('up');
    expect(['up', 'down']).toContain(body.checks.redis?.status);
    expect(res.status).toBe(body.ok ? 200 : 503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(body)).not.toMatch(/redis:\/\/|postgres/);
  });

  it('guards the Prometheus endpoint with METRICS_TOKEN', async () => {
    delete process.env.METRICS_TOKEN;
    expect((await metrics(new Request('http://x/api/metrics'))).status).toBe(404);
    process.env.METRICS_TOKEN = 'scrape-secret-123';
    const wrong = await metrics(
      new Request('http://x/api/metrics', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(404);
    getMetrics().httpDuration.observe(
      { method: 'GET', route: '/api/studio/projects', status: '200' },
      0.05,
    );
    const ok = await metrics(
      new Request('http://x/api/metrics', {
        headers: { authorization: 'Bearer scrape-secret-123' },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    const text = await ok.text();
    expect(text).toContain('studio_http_request_duration_seconds_bucket');
    expect(text).toContain('route="/api/studio/projects"');
    expect(text).toContain('studio_process_cpu_user_seconds_total');
  });
});
