import { describe, expect, it } from 'vitest';
import { getMetrics, metricsAuthorised, routeLabel } from './metrics';

describe('getMetrics', () => {
  it('returns the same registry instance on repeated calls (process-wide singleton)', () => {
    const a = getMetrics();
    const b = getMetrics();
    expect(a).toBe(b);
    expect(a.registry).toBe(b.registry);
  });

  it("exposes the studio_* metric names via the registry's own metrics", async () => {
    const metrics = getMetrics();
    const text = await metrics.registry.metrics();
    expect(text).toContain('studio_http_request_duration_seconds');
    expect(text).toContain('studio_job_duration_seconds');
    expect(text).toContain('studio_jobs_total');
    expect(text).toContain('studio_queue_jobs');
    expect(text).toContain('studio_provider_circuit_state');
  });

  it('registers the service label on the registry', async () => {
    const metrics = getMetrics();
    const json = await metrics.registry.getMetricsAsJSON();
    expect(json.length).toBeGreaterThan(0);
  });
});

describe('routeLabel', () => {
  it('replaces a single path segment matching a route param with :paramName', () => {
    expect(routeLabel('/api/studio/projects/cmf1abc/renders', { id: 'cmf1abc' })).toBe(
      '/api/studio/projects/:id/renders',
    );
  });

  it('replaces multiple segments for multiple params', () => {
    expect(
      routeLabel('/api/studio/projects/proj-1/shots/shot-2', { id: 'proj-1', shotId: 'shot-2' }),
    ).toBe('/api/studio/projects/:id/shots/:shotId');
  });

  it('replaces every segment matching an array-valued param', () => {
    expect(routeLabel('/api/studio/a/b', { slug: ['a', 'b'] })).toBe('/api/studio/:slug/:slug');
  });

  it('matches a URI-encoded segment against its decoded param value', () => {
    expect(routeLabel('/api/studio/tags/hello%20world', { tag: 'hello world' })).toBe(
      '/api/studio/tags/:tag',
    );
  });

  it('falls back to comparing the raw segment when it has a malformed % escape', () => {
    expect(routeLabel('/api/studio/tags/100%', { tag: '100%' })).toBe('/api/studio/tags/:tag');
  });

  it('leaves segments untouched when there are no params', () => {
    expect(routeLabel('/api/studio/projects', {})).toBe('/api/studio/projects');
  });

  it('leaves segments untouched when they do not match any param value', () => {
    expect(routeLabel('/api/studio/projects/other-id', { id: 'proj-1' })).toBe(
      '/api/studio/projects/other-id',
    );
  });
});

describe('metricsAuthorised', () => {
  const TOKEN = 'super-secret-metrics-token';

  it('rejects when no token is configured', () => {
    expect(metricsAuthorised(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(metricsAuthorised(null, TOKEN)).toBe(false);
  });

  it('rejects a header without the Bearer scheme', () => {
    expect(metricsAuthorised(TOKEN, TOKEN)).toBe(false);
  });

  it('rejects a token that is too short', () => {
    expect(metricsAuthorised('Bearer short', TOKEN)).toBe(false);
  });

  it('rejects a token that is too long', () => {
    expect(metricsAuthorised(`Bearer ${TOKEN}-extra`, TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(metricsAuthorised(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it('accepts the correct token', () => {
    expect(metricsAuthorised(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('accepts the Bearer scheme case-insensitively', () => {
    expect(metricsAuthorised(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(metricsAuthorised(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });
});
