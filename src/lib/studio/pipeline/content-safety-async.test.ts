import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIVE_ASYNC_TIMEOUT_MS,
  hashCallbackToken,
  hiveCallbackUrl,
  newCallbackToken,
  parseCallbackBaseUrl,
  parseHiveTimeoutMs,
  recordHiveCallback,
} from './content-safety-async';

// Unit parts of BACKLOG 13.25; the submit → callback → resume flow runs on real Postgres in
// test/golden/a4-media.test.ts and the webhook route in test/api/a4-media-analytics.test.ts.

describe('configuration', () => {
  it('accepts an https origin (http only for localhost)', () => {
    expect(parseCallbackBaseUrl(undefined)).toBeUndefined();
    expect(parseCallbackBaseUrl(' ')).toBeUndefined();
    expect(parseCallbackBaseUrl('https://studio.postmind.ai/some/path')).toBe(
      'https://studio.postmind.ai',
    );
    expect(parseCallbackBaseUrl('http://localhost:3010')).toBe('http://localhost:3010');
    expect(() => parseCallbackBaseUrl('http://studio.postmind.ai')).toThrow('https');
    expect(() => parseCallbackBaseUrl('studio')).toThrow('absolute URL');
  });

  it('reads the callback timeout in minutes', () => {
    expect(parseHiveTimeoutMs(undefined)).toBe(DEFAULT_HIVE_ASYNC_TIMEOUT_MS);
    expect(parseHiveTimeoutMs('30')).toBe(30 * 60_000);
    expect(() => parseHiveTimeoutMs('0')).toThrow('HIVE_ASYNC_TIMEOUT_MIN');
    expect(() => parseHiveTimeoutMs('1.5')).toThrow('HIVE_ASYNC_TIMEOUT_MIN');
    expect(() => parseHiveTimeoutMs('2000')).toThrow('HIVE_ASYNC_TIMEOUT_MIN');
  });
});

describe('callback tokens', () => {
  it('are 256-bit, URL-safe, unique and stored only as a SHA-256', () => {
    const a = newCallbackToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCallbackToken()).not.toBe(a);
    expect(hashCallbackToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCallbackToken(a)).not.toContain(a);
  });

  it('builds the webhook URL on the public origin', () => {
    expect(hiveCallbackUrl('https://studio.example', 'abc')).toBe(
      'https://studio.example/api/studio/webhooks/hive?token=abc',
    );
  });
});

describe('recordHiveCallback', () => {
  const deps = (task: unknown) => ({
    db: {
      contentSafetyTask: {
        findUnique: async () => task,
        updateMany: async () => ({ count: 1 }),
      },
    } as never,
    queue: { add: async () => undefined },
    now: () => 0,
  });

  it('404s for malformed or unknown tokens without touching the queue', async () => {
    await expect(recordHiveCallback(deps(null), { token: null, body: {} })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      recordHiveCallback(deps(null), { token: newCallbackToken(), body: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a body that is not a task object', async () => {
    const task = { id: 't', providerTaskId: null };
    await expect(
      recordHiveCallback(deps(task), { token: newCallbackToken(), body: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
