import { describe, expect, it } from 'vitest';
import { seededRandom, type ManifestRow } from './corpus-manifest';
import {
  DEFAULT_MINUTES_PER_VIDEO,
  estimate,
  formatErrors,
  formatEstimate,
  formatReviewReport,
  parseCorpusArgs,
  pickRandom,
} from './corpus-report';
import { NOT_REQUIRED_DEFAULT_SOURCE } from './ingest';

describe('parseCorpusArgs', () => {
  it('defaults to a dry run with the operator-decision licence source', () => {
    expect(parseCorpusArgs(['corpus.csv'])).toEqual({
      manifest: 'corpus.csv',
      apply: false,
      seed: 1,
      concurrency: 2,
      queueConcurrency: 2,
      workers: 1,
      minutesPerVideo: DEFAULT_MINUTES_PER_VIDEO,
      licenseSource: NOT_REQUIRED_DEFAULT_SOURCE,
      waitMinutes: 180,
      reportOnly: false,
    });
  });

  it('parses sample, apply, state and numeric options', () => {
    const args = parseCorpusArgs([
      'c.jsonl',
      '--sample',
      '100',
      '--seed',
      '7',
      '--apply',
      '--state',
      's.json',
      '--queue-concurrency',
      '8',
      '--workers',
      '3',
      '--minutes-per-video',
      '2.5',
      '--license-source',
      'Operator (J. Smith) 2026-09-27: owned',
    ]);
    expect(args).toMatchObject({
      manifest: 'c.jsonl',
      sample: 100,
      seed: 7,
      apply: true,
      statePath: 's.json',
      queueConcurrency: 8,
      workers: 3,
      minutesPerVideo: 2.5,
      licenseSource: 'Operator (J. Smith) 2026-09-27: owned',
    });
  });

  it('rejects bad input', () => {
    expect(() => parseCorpusArgs([])).toThrow('usage');
    expect(() => parseCorpusArgs(['c.csv', '--sample', '0'])).toThrow('positive');
    expect(() => parseCorpusArgs(['c.csv', '--sample', '1.5'])).toThrow('whole number');
    expect(() => parseCorpusArgs(['c.csv', '--state'])).toThrow('needs a value');
    expect(() => parseCorpusArgs(['c.csv', '--bogus'])).toThrow('unknown option');
    expect(() => parseCorpusArgs(['c.csv', 'd.csv'])).toThrow('unexpected argument');
    expect(() => parseCorpusArgs(['c.csv', '--concurrency', '20'])).toThrow('at most 8');
  });
});

describe('estimate', () => {
  it('prices the corpus at £0.02–£0.05 per video and divides time by job slots', () => {
    const e = estimate(50_000, { minutesPerVideo: 3, queueConcurrency: 8, workers: 2 });
    expect(e).toEqual({
      videos: 50_000,
      costLowGbp: 1_000,
      costHighGbp: 2_500,
      slots: 16,
      hours: 156.3,
    });
    expect(formatEstimate(e, 3)).toContain('£1000.00–£2500.00');
    expect(formatEstimate(e, 3)).toContain('~156.3 h (~6.5 days) at 16 concurrent job slot(s)');
  });

  it('matches the default single worker at concurrency 2', () => {
    expect(estimate(100, { minutesPerVideo: 3, queueConcurrency: 2, workers: 1 })).toMatchObject({
      costLowGbp: 2,
      costHighGbp: 5,
      hours: 2.5,
    });
  });
});

describe('reports', () => {
  it('lists invalid rows, capped', () => {
    expect(formatErrors([])).toBe('No invalid rows.');
    const many = Array.from({ length: 25 }, (_, i) => ({ line: i + 2, error: 'bad' }));
    const text = formatErrors(many);
    expect(text).toContain('25 invalid row(s)');
    expect(text).toContain('… and 5 more');
  });

  it('picks without replacement', () => {
    const picked = pickRandom([1, 2, 3, 4, 5], 3, seededRandom(3));
    expect(new Set(picked).size).toBe(3);
    expect(pickRandom([1, 2], 10, Math.random)).toHaveLength(2);
  });

  it('summarises a sample run with links for the operator to review', () => {
    const rows: ManifestRow[] = Array.from({ length: 14 }, (_, i) => ({
      line: i + 2,
      url: `https://cdn.example/${i}.mp4`,
      tags: [],
      title: `Video ${i}`,
      category: i < 8 ? 'lifestyle/food' : 'business/retail',
      sourceRef: `ext-${i}`,
    }));
    const runIdByUrl = new Map(rows.map((r, i) => [r.url, `run${i}`]));
    const runs = rows.map((_, i) => ({
      runId: `run${i}`,
      sourceRef: null,
      state: i === 13 ? 'FAILED' : i === 12 ? 'RUNNING' : i === 11 ? 'DUPLICATE' : 'SUCCEEDED',
      libraryItemId: i >= 12 ? null : `lib_${i}`,
      errorReason: i === 13 ? 'Source returned HTTP 404' : null,
    }));
    const report = formatReviewReport({
      studioUrl: 'https://studio.test/',
      rows,
      runs,
      runIdByUrl,
      random: seededRandom(1),
      timedOut: true,
    });
    expect(report).toContain('SAMPLE REVIEW — 14 submitted');
    expect(report).toContain('ingested ok: 12   failed: 1   still running: 1');
    expect(report).toContain('stopped waiting');
    expect(report).toMatch(/lifestyle\s+8/);
    expect(report).toMatch(/business\s+4/);
    expect(report).toContain('line 15: Source returned HTTP 404 (https://cdn.example/13.mp4)');
    const links = report.split('\n').filter((l) => l.includes('https://studio.test/library/lib_'));
    expect(links).toHaveLength(10);
    expect(links[0]).toMatch(/\[ext-\d+\]$/);
  });
});
