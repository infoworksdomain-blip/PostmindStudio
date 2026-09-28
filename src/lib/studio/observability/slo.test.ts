import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMetrics } from './metrics';
import {
  generationKind,
  generationSeconds,
  generationStartMetadata,
  observeFirstAnalyticsSample,
  recordPublished,
  recordPublishFailed,
  recordQualityGateOutcome,
} from './slo';

// BACKLOG 15.D9 — SLO helpers against the process registry (reset between tests).

const metrics = getMetrics();
const T0 = Date.parse('2026-09-28T10:00:00Z');

async function value(name: string, labels: Record<string, string>): Promise<number | undefined> {
  // Histogram samples are named <base>_count / _sum / _bucket under the base metric.
  const base = name.replace(/_(count|sum)$/, '');
  const data = await metrics.registry.getSingleMetric(base)?.get();
  return data?.values.find(
    (v) =>
      ((v as { metricName?: string }).metricName ?? base) === name &&
      Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  )?.value;
}

const shortProject = (metadata: unknown) => ({
  sourceType: 'BRIEF',
  targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
  metadata: metadata as never,
});

beforeEach(() => {
  metrics.generationDuration.reset();
  metrics.publishLatency.reset();
  metrics.analyticsFirstMetric.reset();
  metrics.publications.reset();
  metrics.qualityGate.reset();
});

describe('metric registration', () => {
  it('exports the 15.D9 series with the SLO thresholds as bucket boundaries', async () => {
    const text = await metrics.registry.metrics();
    for (const name of [
      'studio_generation_seconds',
      'studio_publish_latency_seconds',
      'studio_analytics_first_metric_seconds',
      'studio_publications_total',
      'studio_quality_gate_renders_total',
    ]) {
      expect(text).toContain(name);
    }
    metrics.generationDuration.observe({ kind: 'short_form' }, 1);
    metrics.publishLatency.observe({ platform: 'tiktok' }, 1);
    metrics.analyticsFirstMetric.observe({ platform: 'tiktok' }, 1);
    const after = await metrics.registry.metrics();
    for (const le of ['240', '600', '900', '2400'])
      expect(after).toContain(`studio_generation_seconds_bucket{le="${le}"`);
    expect(after).toContain('studio_publish_latency_seconds_bucket{le="180"');
    expect(after).toContain('studio_analytics_first_metric_seconds_bucket{le="300"');
  });
});

describe('generationKind', () => {
  it('derives slideshow, long-form and short-form from the project fields', () => {
    expect(generationKind({ sourceType: 'SLIDESHOW', targetFormats: [] })).toBe('slideshow');
    expect(
      generationKind({
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'youtube', duration: 360 }],
      }),
    ).toBe('long_form');
    expect(
      generationKind({
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', duration: 30 }],
      }),
    ).toBe('short_form');
    expect(generationKind({ sourceType: 'BRIEF', targetFormats: null })).toBe('short_form');
  });
});

describe('generationSeconds', () => {
  const meta = { runId: 'run_1', ...generationStartMetadata('run_1', T0) };

  it('measures from the generate call of the current run', () => {
    expect(generationSeconds(meta, T0 + 150_000)).toBe(150);
  });

  it('ignores runs that did not start at a generate call, missing starts and clock skew', () => {
    expect(generationSeconds({ ...meta, runId: 'run_2' }, T0 + 1_000)).toBeNull();
    expect(generationSeconds({ runId: 'run_1' }, T0)).toBeNull();
    expect(generationSeconds(null, T0)).toBeNull();
    expect(generationSeconds(meta, T0 - 1)).toBeNull();
    expect(
      generationSeconds({ runId: 'r', generationStart: { runId: 'r', at: 'nope' } }, T0),
    ).toBeNull();
  });
});

describe('recordQualityGateOutcome', () => {
  const meta = { runId: 'run_1', ...generationStartMetadata('run_1', T0) };

  it('counts each render and observes generation time when every render passed', async () => {
    recordQualityGateOutcome(
      { project: shortProject(meta), passed: [true, true], moved: true, now: T0 + 200_000 },
      metrics,
    );
    expect(await value('studio_quality_gate_renders_total', { result: 'pass' })).toBe(2);
    expect(await value('studio_generation_seconds_count', { kind: 'short_form' })).toBe(1);
    expect(await value('studio_generation_seconds_sum', { kind: 'short_form' })).toBe(200);
  });

  it('counts failures without a generation observation', async () => {
    recordQualityGateOutcome(
      { project: shortProject(meta), passed: [true, false], moved: true, now: T0 + 1_000 },
      metrics,
    );
    expect(await value('studio_quality_gate_renders_total', { result: 'pass' })).toBe(1);
    expect(await value('studio_quality_gate_renders_total', { result: 'fail' })).toBe(1);
    expect(await value('studio_generation_seconds_count', { kind: 'short_form' })).toBeUndefined();
  });

  it('records nothing for a superseded run', async () => {
    recordQualityGateOutcome(
      { project: shortProject(meta), passed: [true], moved: false, now: T0 + 1_000 },
      metrics,
    );
    expect(await value('studio_quality_gate_renders_total', { result: 'pass' })).toBeUndefined();
  });
});

describe('recordPublished', () => {
  const base = {
    platform: 'tiktok',
    retryCount: 0,
    createdAt: new Date(T0),
    scheduledFor: null as Date | null,
  };

  it('counts a first-attempt success and observes approve → live latency', async () => {
    recordPublished({ ...base, state: 'SCHEDULED' }, T0 + 90_000, metrics);
    expect(
      await value('studio_publications_total', { platform: 'tiktok', outcome: 'first_attempt' }),
    ).toBe(1);
    expect(await value('studio_publish_latency_seconds_sum', { platform: 'tiktok' })).toBe(90);
  });

  it('counts a BullMQ retry or an earlier failure as after_retry', async () => {
    recordPublished({ ...base, state: 'PUBLISHING' }, T0 + 1_000, metrics);
    recordPublished({ ...base, state: 'SCHEDULED', retryCount: 1 }, T0 + 1_000, metrics);
    expect(
      await value('studio_publications_total', { platform: 'tiktok', outcome: 'after_retry' }),
    ).toBe(2);
  });

  it('measures a scheduled post from its scheduled time', async () => {
    const scheduledFor = new Date(T0 + 3_600_000);
    recordPublished({ ...base, state: 'SCHEDULED', scheduledFor }, T0 + 3_630_000, metrics);
    expect(await value('studio_publish_latency_seconds_sum', { platform: 'tiktok' })).toBe(30);
    // Published before it was due (clock skew): counted, no latency observation.
    recordPublished({ ...base, state: 'SCHEDULED', scheduledFor }, T0, metrics);
    expect(await value('studio_publish_latency_seconds_count', { platform: 'tiktok' })).toBe(1);
  });
});

describe('recordPublishFailed', () => {
  const logger = { warn: vi.fn() };

  it('counts a final failure under the publication platform', async () => {
    const db = { videoPublication: { findUnique: vi.fn().mockResolvedValue({ platform: 'x' }) } };
    await recordPublishFailed({ db: db as never, logger }, 'pub_1', metrics);
    expect(await value('studio_publications_total', { platform: 'x', outcome: 'failed' })).toBe(1);
  });

  it('never throws when the lookup fails', async () => {
    const db = {
      videoPublication: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) },
    };
    await expect(
      recordPublishFailed({ db: db as never, logger }, 'pub_1', metrics),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('observeFirstAnalyticsSample', () => {
  const publication = { id: 'pub_1', platform: 'youtube', publishedAt: new Date(T0) };
  const logger = { warn: vi.fn() };
  const dbWith = (count: number | Error) => ({
    videoAnalytic: {
      count:
        count instanceof Error
          ? vi.fn().mockRejectedValue(count)
          : vi.fn().mockResolvedValue(count),
    },
  });

  it('observes publishedAt → now for the first sample only', async () => {
    await observeFirstAnalyticsSample(
      { db: dbWith(0) as never, logger },
      publication,
      T0 + 120_000,
      metrics,
    );
    await observeFirstAnalyticsSample(
      { db: dbWith(2) as never, logger },
      publication,
      T0 + 999_000,
      metrics,
    );
    expect(
      await value('studio_analytics_first_metric_seconds_count', { platform: 'youtube' }),
    ).toBe(1);
    expect(await value('studio_analytics_first_metric_seconds_sum', { platform: 'youtube' })).toBe(
      120,
    );
  });

  it('logs and carries on when the count fails', async () => {
    await expect(
      observeFirstAnalyticsSample(
        { db: dbWith(new Error('boom')) as never, logger },
        publication,
        T0,
        metrics,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
