import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { storyblocksAuth } from '../images/stock';
import { StoryblocksAudioAdapter, sfxKeywords } from './storyblocks-audio';

// Fixtures follow documentation.storyblocks.com: GET /api/v2/audio/search
// → { total_results, results: [{ id, title, type, duration, durationMs }] } and
// GET /api/v2/audio/stock-item/download/:id → { MP3, WAV }.

const NOW = 1_790_000_000_000;
const request = {
  capability: 'sfx' as const,
  organisationId: 'org_1',
  projectId: 'prj_1',
  query: 'Whoosh!',
  maxDurationSec: 3,
};
const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  const { storage, objects } = memoryStorage();
  const adapter = new StoryblocksAudioAdapter({
    publicKey: 'pub',
    privateKey: 'priv',
    storage,
    bucket: 'assets',
    fetchImpl: fake.fetch,
    now: () => NOW,
  });
  return { adapter, requests: fake.requests, objects };
}

describe('sfxKeywords', () => {
  it('reduces a cue to plain search words', () => {
    expect(sfxKeywords('  Cash-register "DING"!! ')).toBe('cash-register ding');
    expect(sfxKeywords('<script>')).toBe('script');
    expect(sfxKeywords('!!!')).toBe('');
  });
});

describe('StoryblocksAudioAdapter', () => {
  it('searches SFX with HMAC auth, downloads the MP3 and stores it', async () => {
    const { adapter, requests, objects } = setup(
      json({
        total_results: 2,
        results: [
          { id: 1, title: 'Bed', type: 'music' },
          { id: 148396, title: 'Fast Whoosh', type: 'sfx', durationMs: 1200 },
        ],
      }),
      json({ MP3: 'https://cdn.storyblocks.example/a.mp3', WAV: 'https://cdn.example/a.wav' }),
      mp3(),
    );
    const submitted = await adapter.submit(request);
    expect(submitted.estimatedCostPence).toBe(0);
    const search = new URL(requests[0]!.url);
    expect(search.origin + search.pathname).toBe('https://api.storyblocks.com/api/v2/audio/search');
    const auth = storyblocksAuth(
      { publicKey: 'pub', privateKey: 'priv' },
      '/api/v2/audio/search',
      NOW,
    );
    expect(search.searchParams.get('HMAC')).toBe(auth.get('HMAC'));
    expect(search.searchParams.get('APIKEY')).toBe('pub');
    expect(search.searchParams.get('keywords')).toBe('whoosh');
    expect(search.searchParams.get('content_type')).toBe('sfx');
    expect(search.searchParams.get('max_duration')).toBe('3');
    expect(search.searchParams.get('user_id')).toBe('org_1');
    expect(search.searchParams.get('project_id')).toBe('prj_1');
    expect(requests[1]!.url).toContain('/api/v2/audio/stock-item/download/148396?');
    expect(requests[2]!.url).toBe('https://cdn.storyblocks.example/a.mp3');

    const polled = await adapter.poll(submitted.providerJobId);
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: {
        metadata: {
          stockItemId: '148396',
          title: 'Fast Whoosh',
          durationSec: 1.2,
          bytes: 3,
          costPence: 0,
        },
      },
    });
    expect(objects.size).toBe(1);
  });

  it('reports no match as a non-retryable failure', async () => {
    const { adapter } = setup(json({ total_results: 0, results: [] }));
    const polled = await adapter.poll((await adapter.submit(request)).providerJobId);
    expect(polled).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request', retryable: false },
    });
  });

  it('refuses empty cues, other capabilities, non-https links and oversize files', async () => {
    const { adapter, requests } = setup();
    await expect(adapter.submit({ ...request, query: '!!' })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(
      adapter.submit({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(0);

    const http = setup(
      json({ results: [{ id: 5, type: 'sfx' }] }),
      json({ MP3: 'http://x/a.mp3' }),
    );
    await expect(http.adapter.submit(request)).rejects.toThrow('no MP3 download link');

    const big = setup(
      json({ results: [{ id: 5, type: 'sfx' }] }),
      json({ MP3: 'https://x/a.mp3' }),
      new Response('x', { status: 200, headers: { 'content-length': String(20 * 1024 * 1024) } }),
    );
    await expect(big.adapter.submit(request)).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
  });

  it('stops streaming an oversize download before buffering it fully (no content-length header)', async () => {
    // Regression: the size cap must be enforced while streaming, not only after the whole body
    // has been read into memory — otherwise a host that omits (or lies about) content-length can
    // exhaust memory with an unbounded response.
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(1); // 4 MiB per chunk, no content-length
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 12 MiB total, over the 10 MiB SFX cap
        controller.close();
      },
    });
    const oversized = setup(
      json({ results: [{ id: 5, type: 'sfx' }] }),
      json({ MP3: 'https://x/a.mp3' }),
      new Response(stream, { status: 200 }),
    );
    await expect(oversized.adapter.submit(request)).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
  });

  it.each([
    [429, 'rate_limited', true],
    [401, 'auth', false],
    [503, 'provider_unavailable', true],
  ])('maps search HTTP %i to %s', async (status, errorClass, retryable) => {
    const { adapter } = setup(new Response('no', { status }));
    await expect(adapter.submit(request)).rejects.toMatchObject({ errorClass, retryable });
  });

  it('maps a failed download and network errors', async () => {
    const dl = setup(
      json({ results: [{ id: 5, type: 'sfx' }] }),
      json({ MP3: 'https://x/a.mp3' }),
      new Response('gone', { status: 404 }),
    );
    await expect(dl.adapter.submit(request)).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    const net = setup(Object.assign(new Error('socket'), { name: 'TimeoutError' }));
    await expect(net.adapter.submit(request)).rejects.toMatchObject({ errorClass: 'timeout' });
  });

  it('health-checks with a one-result search; cancel drops results', async () => {
    const ok = setup(json({ results: [] }));
    expect(await ok.adapter.healthCheck()).toEqual({ healthy: true });
    const bad = setup(new Response('no', { status: 401 }));
    expect((await bad.adapter.healthCheck()).healthy).toBe(false);
    const { adapter } = setup(json({ results: [] }));
    const { providerJobId } = await adapter.submit(request);
    await adapter.cancel(providerJobId);
    expect((await adapter.poll(providerJobId)).error?.class).toBe('result_expired');
    expect(adapter.estimateCostPence(request)).toBe(0);
  });
});
