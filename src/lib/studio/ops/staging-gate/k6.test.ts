import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors';
import {
  evaluateThresholds,
  k6RunArgs,
  k6Sections,
  missingK6Env,
  parseSummaryExport,
  succeededJobs,
  throughputBetween,
} from './k6';

const summary = (overrides: Record<string, Record<string, number>> = {}) => ({
  root_group: {},
  metrics: {
    http_req_duration: { avg: 80, 'p(50)': 60, 'p(95)': 210, 'p(99)': 900, max: 1500 },
    studio_read_latency: { avg: 70, 'p(95)': 190 },
    studio_errors: { passes: 0, fails: 1000, value: 0 },
    checks: { passes: 1000, fails: 0, value: 1 },
    http_reqs: { count: 1200, rate: 24.5 },
    iterations: { count: 240, rate: 4.8 },
    ...overrides,
  },
});

describe('parseSummaryExport', () => {
  it('keeps numeric stats and exposes a Rate metric value as rate', () => {
    const m = parseSummaryExport(summary());
    expect(m.http_req_duration?.['p(95)']).toBe(210);
    expect(m.studio_errors?.rate).toBe(0);
    expect(m.checks?.rate).toBe(1);
    // A Counter's own rate is kept as is.
    expect(m.http_reqs?.rate).toBe(24.5);
  });

  it('rejects a document without metrics', () => {
    expect(() => parseSummaryExport({})).toThrow(ValidationError);
    expect(() => parseSummaryExport(null)).toThrow(ValidationError);
  });
});

describe('evaluateThresholds', () => {
  it('passes a healthy run and marks absent optional metrics N/A', () => {
    const results = evaluateThresholds(parseSummaryExport(summary()));
    expect(results.every((r) => r.verdict === 'PASS' || r.verdict === 'N/A')).toBe(true);
    expect(results.find((r) => r.metric === 'studio_write_latency')?.verdict).toBe('N/A');
  });

  it('fails a p95 over 300 ms (spec 17.1), a high error rate and a missing required metric', () => {
    const m = parseSummaryExport(
      summary({
        http_req_duration: { 'p(95)': 340, 'p(99)': 900 },
        studio_errors: { passes: 5, fails: 995, value: 0.005 },
      }),
    );
    delete m.studio_read_latency;
    const failed = evaluateThresholds(m)
      .filter((r) => r.verdict === 'FAIL')
      .map((r) => `${r.metric} ${r.stat}`);
    expect(failed).toEqual([
      'http_req_duration p(95)',
      'studio_read_latency p(95)',
      'studio_errors rate',
    ]);
  });
});

describe('k6Sections', () => {
  const metrics = parseSummaryExport(summary());
  it('passes when thresholds hold and k6 exited 0', () => {
    const r = k6Sections({
      mode: 'smoke',
      exitCode: 0,
      results: evaluateThresholds(metrics),
      metrics,
    });
    expect(r.verdict).toBe('PASS');
    expect(r.sections[0]?.lines.join('\n')).toContain(
      '| http_req_duration | p(95) | < 300 ms | 210.0 ms',
    );
  });

  it('fails on k6 exit 99 (thresholds crossed) and explains other exit codes', () => {
    const results = evaluateThresholds(metrics);
    expect(k6Sections({ mode: 'full', exitCode: 99, results, metrics }).verdict).toBe('FAIL');
    const other = k6Sections({ mode: 'full', exitCode: 107, results, metrics });
    expect(other.sections[1]?.lines[0]).toContain('the run itself failed');
  });

  it('adds the throughput section when measured', () => {
    const r = k6Sections({
      mode: 'full',
      exitCode: 0,
      results: evaluateThresholds(metrics),
      metrics,
      throughput: throughputBetween({ 'publish-video': 10 }, { 'publish-video': 20 }, 3_600_000),
    });
    expect(r.sections[2]?.lines.join('\n')).toContain('Publications: 240/day');
  });
});

describe('queue throughput', () => {
  const text = [
    'studio_jobs_total{job="publish-video",outcome="succeeded"} 12',
    'studio_jobs_total{job="publish-video",outcome="failed"} 3',
    'studio_jobs_total{job="plan-project",outcome="succeeded"} 4',
    'studio_queue_jobs{queue="studio-publish",state="active"} 1',
  ].join('\n');

  it('reads succeeded job counters', () => {
    expect(succeededJobs(text)).toEqual({ 'publish-video': 12, 'plan-project': 4 });
  });

  it('computes per-hour and per-day rates, treating a counter reset as from zero', () => {
    const t = throughputBetween(
      { 'publish-video': 100, 'plan-project': 50 },
      { 'publish-video': 110, 'plan-project': 5 },
      30 * 60_000,
    );
    expect(t.perHour).toEqual({ 'publish-video': 20, 'plan-project': 10 });
    expect(t.publicationsPerDay).toBe(480);
    expect(t.projectsPerDay).toBe(240);
    expect(() => throughputBetween({}, {}, 0)).toThrow(ValidationError);
  });
});

describe('k6 invocation', () => {
  it('passes the mode with -e and keeps secrets out of argv', () => {
    const args = k6RunArgs('smoke', 'ops/results/x.json');
    expect(args).toEqual([
      'run',
      '--summary-export',
      'ops/results/x.json',
      '--include-system-env-vars',
      '-e',
      'RUN_MODE=smoke',
      'load-test/k6/studio-api.js',
    ]);
    expect(args.join(' ')).not.toContain('TOKEN');
  });

  it('lists missing required env', () => {
    expect(missingK6Env({ BASE_URL: 'https://s', STUDIO_TOKEN: ' ' })).toEqual(['STUDIO_TOKEN']);
    expect(missingK6Env({ BASE_URL: 'https://s', STUDIO_TOKEN: 't' })).toEqual([]);
  });
});
