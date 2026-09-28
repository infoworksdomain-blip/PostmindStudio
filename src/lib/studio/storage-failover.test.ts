import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../errors';
import type { AssetStorage } from './storage';
import { createFailoverStorage, failoverConfigFromEnv, isOutage } from './storage-failover';

// 15.E9 — spec 4.6 secondary-region storage fallback.

function fakeStorage(
  name: string,
  fail?: unknown,
): AssetStorage & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    objects,
    put: vi.fn(async ({ bucket, key, body }) => {
      if (fail) throw fail;
      objects.set(`${bucket}/${key}`, body.byteLength);
      return { bucket, key, url: `https://${name}/${bucket}/${key}` };
    }),
    signedUrl: vi.fn(async (bucket: string, key: string) => `https://${name}/${bucket}/${key}`),
    size: vi.fn(async (bucket: string, key: string) => {
      if (fail) throw fail;
      const n = objects.get(`${bucket}/${key}`);
      if (n === undefined) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return n;
    }),
    readRange: vi.fn(async () => new Uint8Array([1])),
    delete: vi.fn(async (bucket: string, key: string) => {
      objects.delete(`${bucket}/${key}`);
    }),
  };
}

const outage = Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } });
const denied = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
const config = { region: 'eu-west-1', buckets: new Map([['assets', 'assets-dr']]) };
const log = { warn: vi.fn() };

describe('failoverConfigFromEnv', () => {
  it('is off without S3_FALLBACK_REGION and maps configured buckets', () => {
    expect(failoverConfigFromEnv({})).toBeUndefined();
    const cfg = failoverConfigFromEnv({
      AWS_REGION: 'eu-west-2',
      S3_FALLBACK_REGION: 'eu-west-1',
      S3_BUCKET_ASSETS: 'assets',
      S3_FALLBACK_BUCKET_ASSETS: 'assets-dr',
      S3_BUCKET_RENDERS: 'renders',
    });
    expect([...(cfg?.buckets ?? [])]).toEqual([['assets', 'assets-dr']]);
  });

  it('rejects the same region, the same bucket, or no mapped bucket', () => {
    const base = { AWS_REGION: 'eu-west-2', S3_BUCKET_ASSETS: 'a' };
    expect(() => failoverConfigFromEnv({ ...base, S3_FALLBACK_REGION: 'eu-west-2' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      failoverConfigFromEnv({ ...base, S3_FALLBACK_REGION: 'x', S3_FALLBACK_BUCKET_ASSETS: 'a' }),
    ).toThrow(ConfigurationError);
    expect(() => failoverConfigFromEnv({ ...base, S3_FALLBACK_REGION: 'x' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('isOutage', () => {
  it('counts 5xx and network errors, not 4xx or missing keys', () => {
    expect(isOutage(outage)).toBe(true);
    expect(isOutage(Object.assign(new Error('socket'), { name: 'TimeoutError' }))).toBe(true);
    expect(isOutage(denied)).toBe(false);
    expect(isOutage(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(false);
    expect(isOutage('nope')).toBe(false);
  });
});

describe('createFailoverStorage', () => {
  const body = new Uint8Array([1, 2, 3]);

  it('writes to the primary when it is up', async () => {
    const primary = fakeStorage('p');
    const fallback = fakeStorage('f');
    const s = createFailoverStorage(primary, fallback, config, log);
    expect(await s.put({ bucket: 'assets', key: 'k', body, contentType: 'x' })).toMatchObject({
      bucket: 'assets',
    });
    expect(fallback.put).not.toHaveBeenCalled();
  });

  it('writes to the fallback bucket on an outage and records that bucket', async () => {
    const primary = fakeStorage('p', outage);
    const fallback = fakeStorage('f');
    const s = createFailoverStorage(primary, fallback, config, log);
    const stored = await s.put({ bucket: 'assets', key: 'k', body, contentType: 'x' });
    expect(stored.bucket).toBe('assets-dr');
    expect(fallback.objects.get('assets-dr/k')).toBe(3);
    // Reads of the recorded fallback location go straight to the fallback client.
    expect(await s.size('assets-dr', 'k')).toBe(3);
    expect(await s.signedUrl('assets-dr', 'k')).toContain('https://f/');
    expect(await s.signedUrl('assets', 'k')).toContain('https://p/');
  });

  it('does not fail over a 4xx or an unmapped bucket', async () => {
    const s = createFailoverStorage(fakeStorage('p', denied), fakeStorage('f'), config, log);
    await expect(s.put({ bucket: 'assets', key: 'k', body, contentType: 'x' })).rejects.toBe(
      denied,
    );
    const s2 = createFailoverStorage(fakeStorage('p', outage), fakeStorage('f'), config, log);
    await expect(s2.put({ bucket: 'renders', key: 'k', body, contentType: 'x' })).rejects.toBe(
      outage,
    );
  });

  it('reads try primary then the mapped fallback; delete clears both', async () => {
    const primary = fakeStorage('p');
    const fallback = fakeStorage('f');
    fallback.objects.set('assets-dr/k', 9);
    const s = createFailoverStorage(primary, fallback, config, log);
    expect(await s.size('assets', 'k')).toBe(9);
    await expect(s.size('renders', 'k')).rejects.toThrow('missing');
    await s.readRange('assets-dr', 'k', 0, 0);
    expect(fallback.readRange).toHaveBeenCalled();
    await s.delete('assets', 'k');
    expect(fallback.objects.has('assets-dr/k')).toBe(false);
    await s.delete('assets-dr', 'k');
    expect(fallback.delete).toHaveBeenCalledTimes(2);
  });
});
