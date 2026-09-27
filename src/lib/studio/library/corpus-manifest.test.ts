import { describe, expect, it } from 'vitest';
import {
  AUTO_CATEGORY,
  categoryDistribution,
  categorySlugsFromTree,
  chunk,
  emptyState,
  formatFromPath,
  loadState,
  parseCsv,
  parseManifest,
  pendingRows,
  seededRandom,
  stateCounts,
  stratifiedSample,
  urlProblem,
  validateRows,
  withRowStates,
  type ManifestRow,
} from './corpus-manifest';

const CATEGORIES = new Set(['lifestyle', 'lifestyle/food/baking', 'business/e-commerce/fashion']);

const row = (line: number, overrides: Partial<ManifestRow> = {}): ManifestRow => ({
  line,
  url: `https://cdn.example/v/${line}.mp4`,
  tags: [],
  ...overrides,
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF, newlines in quotes and a BOM', () => {
    const text =
      '﻿url,title\r\nhttps://a/1.mp4,"Hello, ""world"""\r\nhttps://a/2.mp4,"two\nlines"\n';
    expect(parseCsv(text)).toEqual([
      ['url', 'title'],
      ['https://a/1.mp4', 'Hello, "world"'],
      ['https://a/2.mp4', 'two\nlines'],
    ]);
  });

  it('skips blank lines and rejects an unterminated quote', () => {
    expect(parseCsv('url\n\n  \nhttps://a/1.mp4')).toEqual([['url'], ['https://a/1.mp4']]);
    expect(() => parseCsv('url,title\nhttps://a,"oops')).toThrow('unterminated');
  });
});

describe('parseManifest', () => {
  it('reads CSV with header aliases and pipe-separated tags', () => {
    const csv = [
      'Source_URL,Title,Tags,Category_Slug,External_ID,Lang',
      's3://corpus-bucket/a.mp4,Dawn bake,bread|Bakery ; morning,lifestyle/food/baking,ext-1,en',
      'https://cdn.example/b.mp4,,,,,',
    ].join('\n');
    const { rows, errors } = parseManifest(csv, 'csv');
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        url: 's3://corpus-bucket/a.mp4',
        title: 'Dawn bake',
        tags: ['bread', 'Bakery', 'morning'],
        category: 'lifestyle/food/baking',
        sourceRef: 'ext-1',
        language: 'en',
      },
      { line: 3, url: 'https://cdn.example/b.mp4', tags: [] },
    ]);
  });

  it('reports CSV rows with too many fields and a header without url', () => {
    expect(parseManifest('url,title\nhttps://a/1.mp4,t,extra', 'csv').errors).toEqual([
      { line: 2, error: 'has 3 fields, header has 2' },
    ]);
    expect(() => parseManifest('title\nx', 'csv')).toThrow('"url" column');
    expect(() => parseManifest('', 'csv')).toThrow('empty');
  });

  it('reads JSONL (tags as an array) and reports bad lines', () => {
    const jsonl = [
      '{"url":"https://cdn.example/a.mp4","tags":["a","b"],"sourceRef":42}',
      '',
      'not json',
      '[1,2]',
      '{"sourceUrl":"https://cdn.example/b.mp4","language":"pt-BR"}',
    ].join('\n');
    const { rows, errors } = parseManifest(jsonl, 'jsonl');
    expect(rows).toEqual([
      { line: 1, url: 'https://cdn.example/a.mp4', tags: ['a', 'b'], sourceRef: '42' },
      { line: 5, url: 'https://cdn.example/b.mp4', tags: [], language: 'pt-BR' },
    ]);
    expect(errors).toEqual([
      { line: 3, error: 'invalid JSON' },
      { line: 4, error: 'not a JSON object' },
    ]);
  });

  it('picks the format from the file extension', () => {
    expect(formatFromPath('corpus.CSV')).toBe('csv');
    expect(formatFromPath('corpus.jsonl')).toBe('jsonl');
    expect(formatFromPath('corpus.ndjson')).toBe('jsonl');
    expect(() => formatFromPath('corpus.xlsx')).toThrow('.csv or .jsonl');
  });
});

describe('validateRows', () => {
  it('accepts https and s3 sources only', () => {
    expect(urlProblem('https://cdn.example/a.mp4')).toBeNull();
    expect(urlProblem('s3://corpus-bucket/dir/a.mp4')).toBeNull();
    expect(urlProblem('http://cdn.example/a.mp4')).toMatch('only https');
    expect(urlProblem('ftp://x/a.mp4')).toMatch('only https');
    expect(urlProblem('s3://Bad_Bucket/a.mp4')).toMatch('bucket');
    expect(urlProblem('s3://bucket')).toMatch('s3://bucket/key');
    expect(urlProblem('https://user:pw@cdn.example/a.mp4')).toMatch('credentials');
    expect(urlProblem('nope')).toBe('not a valid URL');
  });

  it('flags duplicates, unknown categories and bad fields with their line numbers', () => {
    const rows = [
      row(2, { category: 'lifestyle/food/baking', sourceRef: 'r1' }),
      row(3, { url: 'https://cdn.example/v/33.mp4' }),
      row(4, { url: 'https://cdn.example/v/33.mp4' }),
      row(5, { sourceRef: 'r1' }),
      row(6, { category: 'nope/nope' }),
      row(7, { url: '' }),
      row(8, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
      row(9, { language: 'english!' }),
      row(10, { title: 'x'.repeat(201) }),
    ];
    const { valid, errors } = validateRows(rows, CATEGORIES);
    expect(valid.map((r) => r.line)).toEqual([2, 3]);
    expect(errors).toEqual([
      { line: 4, url: 'https://cdn.example/v/33.mp4', error: 'duplicate of line 3' },
      { line: 5, url: 'https://cdn.example/v/5.mp4', error: 'sourceRef duplicates line 2' },
      { line: 6, url: 'https://cdn.example/v/6.mp4', error: 'unknown category slug "nope/nope"' },
      { line: 7, error: 'missing url' },
      { line: 8, url: 'https://cdn.example/v/8.mp4', error: 'more than 20 tags' },
      {
        line: 9,
        url: 'https://cdn.example/v/9.mp4',
        error: 'language "english!" is not a code such as en or pt-BR',
      },
      { line: 10, url: 'https://cdn.example/v/10.mp4', error: 'title is longer than 200' },
    ]);
  });

  it('flattens the categories tree into slugs', () => {
    const tree = [
      { slug: 'a', children: [{ slug: 'a/b', children: [{ slug: 'a/b/c', children: [] }] }] },
      { slug: 'd' },
    ];
    expect([...categorySlugsFromTree(tree)]).toEqual(['a', 'a/b', 'a/b/c', 'd']);
  });
});

describe('stratifiedSample', () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => row(i + 1, { category: 'lifestyle/food/baking' })),
    ...Array.from({ length: 30 }, (_, i) =>
      row(i + 61, { category: 'business/e-commerce/fashion' }),
    ),
    ...Array.from({ length: 9 }, (_, i) => row(i + 91)),
    row(100, { category: 'education/tutorials/x' }),
  ];

  it('takes n rows proportionally per top-level category, including tiny strata', () => {
    const sample = stratifiedSample(rows, 20, seededRandom(1));
    expect(sample).toHaveLength(20);
    expect(new Set(sample.map((r) => r.url)).size).toBe(20);
    const dist = Object.fromEntries(categoryDistribution(sample));
    expect(dist).toEqual({ lifestyle: 12, business: 6, [AUTO_CATEGORY]: 1, education: 1 });
  });

  it('is reproducible with the same seed and differs with another', () => {
    const a = stratifiedSample(rows, 10, seededRandom(7)).map((r) => r.line);
    const b = stratifiedSample(rows, 10, seededRandom(7)).map((r) => r.line);
    const c = stratifiedSample(rows, 10, seededRandom(8)).map((r) => r.line);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toEqual([...a].sort((x, y) => x - y));
  });

  it('returns everything when n covers the manifest', () => {
    expect(stratifiedSample(rows.slice(0, 5), 100, seededRandom(1))).toHaveLength(5);
  });
});

describe('batches and resumable state', () => {
  it('chunks into batches of at most 100', () => {
    const sizes = chunk(Array.from({ length: 250 }, (_, i) => i)).map((b) => b.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('keeps accepted and skipped rows out of the next run, retries rejected ones', () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const at = '2026-09-27T00:00:00Z';
    const state = withRowStates(emptyState('m.csv'), {
      [row(1).url]: { status: 'accepted', runId: 'a', at },
      [row(2).url]: { status: 'skipped', runId: 'b', at },
      [row(3).url]: { status: 'rejected', error: 'HTTP 400', at },
    });
    expect(pendingRows(rows, state).map((r) => r.line)).toEqual([3, 4]);
    expect(stateCounts(state)).toEqual({ accepted: 1, skipped: 1, rejected: 1 });
  });

  it('loads a saved state file and refuses anything else', () => {
    const saved = JSON.parse(JSON.stringify(emptyState('m.csv'))) as unknown;
    expect(loadState(saved, 'm.csv')).toEqual({ version: 1, manifest: 'm.csv', rows: {} });
    expect(() => loadState({ rows: {} }, 'm.csv')).toThrow('state file');
    expect(() => loadState(null, 'm.csv')).toThrow('state file');
  });
});
