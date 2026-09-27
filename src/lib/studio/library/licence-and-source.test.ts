import { describe, expect, it } from 'vitest';
import type { PipelineDeps } from '../pipeline/deps';
import { assertModeAllowed } from './blueprint';
import { parseCorpusBuckets } from './corpus-source';
import {
  allowedModes,
  ingestItemInput,
  licenseSourceFor,
  MAX_SOURCE_BYTES,
  NOT_REQUIRED_DEFAULT_SOURCE,
  readSource,
} from './ingest';
import { submitDecision } from './ingest-runs';

// Operator decision 2026-09-27: the corpus needs no licence (LicenseScenario NOT_REQUIRED).

const NOW = Date.parse('2026-09-27T12:00:00Z');

describe('NOT_REQUIRED licence scenario', () => {
  it('allows both TEMPLATE and INSPIRE, like LICENSED and OWNED', () => {
    expect(allowedModes('NOT_REQUIRED')).toEqual(['TEMPLATE', 'INSPIRE']);
    const license = { allowedModes: allowedModes('NOT_REQUIRED'), licenseExpires: null };
    expect(() => assertModeAllowed('TEMPLATE', license, NOW)).not.toThrow();
    expect(() => assertModeAllowed('INSPIRE', license, NOW)).not.toThrow();
  });

  it('keeps the restrictive gating for SCRAPED and expired licences', () => {
    const scraped = { allowedModes: allowedModes('SCRAPED'), licenseExpires: null };
    expect(() => assertModeAllowed('TEMPLATE', scraped, NOW)).toThrow(
      'TEMPLATE mode is not allowed',
    );
    expect(() => assertModeAllowed('INSPIRE', scraped, NOW)).not.toThrow();
    const expired = {
      allowedModes: allowedModes('LICENSED'),
      licenseExpires: new Date(NOW - 1_000),
    };
    expect(() => assertModeAllowed('INSPIRE', expired, NOW)).toThrow('expired');
    expect(() => assertModeAllowed('TEMPLATE', null, NOW)).toThrow('no licence record');
  });

  it('always records who decided and when as the licence source', () => {
    expect(licenseSourceFor('NOT_REQUIRED', undefined)).toBe(NOT_REQUIRED_DEFAULT_SOURCE);
    expect(NOT_REQUIRED_DEFAULT_SOURCE).toContain('2026-09-27');
    expect(licenseSourceFor('NOT_REQUIRED', 'Ops ticket 42')).toBe('Ops ticket 42');
    expect(licenseSourceFor('LICENSED', undefined)).toBeNull();
  });
});

describe('ingestItemInput', () => {
  const base = { licenseScenario: 'NOT_REQUIRED', tags: [] };

  it('accepts NOT_REQUIRED, https and s3 sources, sourceRef and language', () => {
    const parsed = ingestItemInput.parse({
      ...base,
      sourceUrl: 's3://postmind-corpus/a.mp4',
      sourceRef: 'ext-1',
      language: 'pt-BR',
    });
    expect(parsed).toMatchObject({ licenseScenario: 'NOT_REQUIRED', language: 'pt-BR' });
    expect(
      ingestItemInput.safeParse({ ...base, sourceUrl: 'https://a.example/v.mp4' }).success,
    ).toBe(true);
  });

  it('rejects other schemes and malformed languages', () => {
    for (const sourceUrl of ['file:///etc/passwd', 'ftp://x/y.mp4', 's3://bucket', 'nope'])
      expect(ingestItemInput.safeParse({ ...base, sourceUrl }).success).toBe(false);
    expect(
      ingestItemInput.safeParse({ ...base, sourceUrl: 'https://a/v.mp4', language: 'x!' }).success,
    ).toBe(false);
    expect(
      ingestItemInput.safeParse({ ...base, sourceUrl: 'https://a/v.mp4', licenseScenario: 'MAYBE' })
        .success,
    ).toBe(false);
  });
});

describe('readSource', () => {
  function deps(objects: Record<string, Uint8Array>, buckets: string | undefined) {
    const reads: string[] = [];
    const fetched: string[] = [];
    const d = {
      config: { corpusS3Buckets: parseCorpusBuckets(buckets) },
      storage: {
        size: async (bucket: string, key: string) => {
          const body = objects[`${bucket}/${key}`];
          if (!body) throw new Error('missing');
          return key.includes('huge') ? MAX_SOURCE_BYTES + 1 : body.byteLength;
        },
        readRange: async (bucket: string, key: string, start: number, end: number) => {
          reads.push(`${bucket}/${key}:${start}-${end}`);
          return (objects[`${bucket}/${key}`] as Uint8Array).slice(start, end + 1);
        },
      },
      scan: {
        pageFetch: (async (input: string | URL | Request) => {
          fetched.push(String(input));
          return new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'video/mp4' } });
        }) as typeof fetch,
      },
    } as unknown as PipelineDeps;
    return { d, reads, fetched };
  }

  it('reads an allow-listed s3 object with the storage client, not over HTTP', async () => {
    const { d, reads, fetched } = deps(
      { 'postmind-corpus/v/a.mp4': new Uint8Array([1, 2, 3]) },
      'postmind-corpus',
    );
    expect(await readSource(d, 's3://postmind-corpus/v/a.mp4')).toEqual(new Uint8Array([1, 2, 3]));
    expect(reads).toEqual(['postmind-corpus/v/a.mp4:0-2']);
    expect(fetched).toEqual([]);
  });

  it('refuses s3 buckets that are not allow-listed, oversized and empty objects', async () => {
    const objects = {
      'postmind-corpus/huge.mp4': new Uint8Array([1]),
      'postmind-corpus/empty.mp4': new Uint8Array([]),
      'other/a.mp4': new Uint8Array([1]),
    };
    await expect(readSource(deps(objects, undefined).d, 's3://other/a.mp4')).rejects.toThrow(
      's3:// sources are disabled',
    );
    const { d, reads } = deps(objects, 'postmind-corpus');
    await expect(readSource(d, 's3://other/a.mp4')).rejects.toThrow('not in STUDIO_CORPUS');
    await expect(readSource(d, 's3://postmind-corpus/huge.mp4')).rejects.toThrow('200 MB');
    await expect(readSource(d, 's3://postmind-corpus/empty.mp4')).rejects.toThrow('empty');
    expect(reads).toEqual([]);
  });

  it('still fetches https sources through the SSRF-guarded fetch', async () => {
    const { d, fetched } = deps({}, 'postmind-corpus');
    expect(await readSource(d, 'https://cdn.example/a.mp4')).toEqual(new Uint8Array([9, 9]));
    expect(fetched).toEqual(['https://cdn.example/a.mp4']);
    // The guard still refuses non-public addresses even with an allow-list configured.
    await expect(readSource(d, 'https://127.0.0.1/a.mp4')).rejects.toThrow();
  });
});

describe('submitDecision (resubmission of a source)', () => {
  it('enqueues new and in-flight sources under the stable job id', () => {
    expect(submitDecision(null)).toEqual({ action: 'enqueue', jobSuffix: '' });
    expect(submitDecision({ state: 'QUEUED', attempts: 0, libraryItemId: null })).toEqual({
      action: 'enqueue',
      jobSuffix: '',
    });
  });

  it('skips sources already ingested and retries failed ones under a fresh job id', () => {
    expect(submitDecision({ state: 'SUCCEEDED', attempts: 1, libraryItemId: 'lib_1' })).toEqual({
      action: 'skip',
      state: 'SUCCEEDED',
      libraryItemId: 'lib_1',
    });
    expect(
      submitDecision({ state: 'DUPLICATE', attempts: 1, libraryItemId: 'lib_2' }),
    ).toMatchObject({
      action: 'skip',
    });
    expect(submitDecision({ state: 'FAILED', attempts: 3, libraryItemId: null })).toEqual({
      action: 'enqueue',
      jobSuffix: '__retry3',
    });
  });
});
