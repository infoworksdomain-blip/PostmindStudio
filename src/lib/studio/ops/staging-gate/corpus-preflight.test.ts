import { describe, expect, it } from 'vitest';
import type { ManifestRow } from '../../library/corpus-manifest';
import {
  evaluatePreflight,
  formatPreflight,
  preflightSections,
  preflightVerdict,
  s3ProbeRows,
  type PreflightInput,
} from './corpus-preflight';

const row = (line: number, url: string, category?: string): ManifestRow => ({
  line,
  url,
  tags: [],
  category,
});

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    mode: 'full',
    env: {
      STUDIO_LIBRARY_PLAN_TIER: 'ENTERPRISE',
      STUDIO_LIBRARY_CONCURRENCY: '8',
      STUDIO_CORPUS_S3_BUCKETS: 'postmind-corpus',
    },
    workers: 2,
    minutesPerVideo: 3,
    rows: [row(1, 'https://cdn.example.com/a.mp4'), row(2, 's3://postmind-corpus/b.mp4')],
    errors: [],
    categories: { ok: true, detail: '40 category slugs' },
    libraryBucket: { ok: true, detail: 'write + delete OK' },
    s3Probes: [{ url: 's3://postmind-corpus/b.mp4', ok: true, detail: '1000 bytes' }],
    ...overrides,
  };
}

const level = (checks: ReturnType<typeof evaluatePreflight>, name: string) =>
  checks.find((c) => c.name.startsWith(name))?.level;

describe('evaluatePreflight', () => {
  it('passes a ready full run', () => {
    const checks = evaluatePreflight(input());
    expect(preflightVerdict(checks)).toBe('PASS');
    expect(checks.find((c) => c.name === 'Worker concurrency')?.detail).toContain('16 slot(s)');
    expect(formatPreflight(checks, 'full')).toContain('PRE-FLIGHT PASSED');
  });

  it('fails a full run below ENTERPRISE but only warns for a sample', () => {
    const env = { ...input().env, STUDIO_LIBRARY_PLAN_TIER: 'STANDARD' };
    expect(level(evaluatePreflight(input({ env })), 'Caps tier')).toBe('FAIL');
    expect(level(evaluatePreflight(input({ env, mode: 'sample' })), 'Caps tier')).toBe('WARN');
    expect(
      level(evaluatePreflight(input({ env: { STUDIO_LIBRARY_PLAN_TIER: 'GOLD' } })), 'Caps tier'),
    ).toBe('FAIL');
  });

  it('warns about too few slots for a full run and too many for rate limits', () => {
    const few = evaluatePreflight(
      input({ env: { ...input().env, STUDIO_LIBRARY_CONCURRENCY: '2' }, workers: 1 }),
    );
    expect(level(few, 'Worker concurrency')).toBe('WARN');
    const many = evaluatePreflight(input({ workers: 4 }));
    expect(many.find((c) => c.name === 'Worker concurrency')?.detail).toContain('rate limits');
  });

  it('fails invalid manifest rows on a full run, warns on a sample', () => {
    const errors = [{ line: 3, url: 'http://x', error: 'http:// is refused' }];
    expect(level(evaluatePreflight(input({ errors })), 'Manifest')).toBe('FAIL');
    expect(level(evaluatePreflight(input({ errors, mode: 'sample' })), 'Manifest')).toBe('WARN');
    expect(level(evaluatePreflight(input({ rows: [] })), 'Manifest')).toBe('FAIL');
  });

  it('checks the library bucket, the allow-list and s3 read access', () => {
    expect(level(evaluatePreflight(input({ libraryBucket: null })), 'Library bucket')).toBe('FAIL');
    const outside = evaluatePreflight(
      input({ rows: [row(1, 's3://other-bucket/x.mp4')], s3Probes: [] }),
    );
    expect(level(outside, 'Corpus bucket allow-list')).toBe('FAIL');
    expect(level(outside, 'Corpus bucket read access')).toBe('WARN');
    const unreadable = evaluatePreflight(
      input({
        s3Probes: [{ url: 's3://postmind-corpus/b.mp4', ok: false, detail: 'AccessDenied' }],
      }),
    );
    expect(level(unreadable, 'Corpus bucket read access')).toBe('FAIL');
    expect(
      level(
        evaluatePreflight(
          input({ env: { ...input().env, STUDIO_CORPUS_S3_BUCKETS: 'Bad_Bucket' } }),
        ),
        'Corpus bucket allow-list',
      ),
    ).toBe('FAIL');
  });

  it('fails when the admin API is unreachable', () => {
    const checks = evaluatePreflight(input({ categories: { ok: false, detail: '401' } }));
    expect(preflightVerdict(checks)).toBe('FAIL');
    expect(formatPreflight(checks, 'sample')).toContain('PRE-FLIGHT FAILED');
  });
});

describe('s3ProbeRows', () => {
  it('spreads probes across the s3 rows', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i + 1, `s3://b/${i}.mp4`));
    const picked = s3ProbeRows([row(0, 'https://x/y.mp4'), ...rows], 10);
    expect(picked).toHaveLength(10);
    expect(picked[1]?.url).toBe('s3://b/10.mp4');
    expect(s3ProbeRows(rows.slice(0, 3))).toHaveLength(3);
  });
});

describe('preflightSections', () => {
  it('wraps the output with the verdict and next steps', () => {
    const [run, next] = preflightSections('PRE-FLIGHT PASSED', 0);
    expect(run?.verdict).toBe('PASS');
    expect(next?.lines[0]).toContain('--sample 100');
    expect(preflightSections('', 1)[0]?.verdict).toBe('FAIL');
  });
});
