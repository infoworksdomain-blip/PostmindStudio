import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ConfigurationError } from '../../errors';
import { ElevenLabsAdapter } from './elevenlabs';

// Fixtures follow elevenlabs.io/docs/api-reference/text-to-speech/convert: raw audio body,
// `character-cost` / `request-id` response headers, `{ detail: { code, message } }` errors.
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

function audio(
  headers: Record<string, string> = { 'character-cost': '40', 'request-id': 'req-1' },
) {
  return new Response(MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg', ...headers } });
}

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  const { storage, objects } = memoryStorage();
  const adapter = new ElevenLabsAdapter({
    apiKey: 'xi-key',
    storage,
    bucket: 'studio-assets-dev',
    usdToGbpRate: 0.75,
    fetchImpl: fake.fetch,
  });
  return { adapter, requests: fake.requests, objects };
}

const tts = {
  capability: 'tts' as const,
  organisationId: 'org-1',
  projectId: 'proj-1',
  text: 'Fresh bread, every morning, from our family oven.',
  voiceId: 'voice/abc',
  languageCode: 'en',
};

describe('ElevenLabsAdapter', () => {
  it('rejects unknown models at construction', () => {
    const { storage } = memoryStorage();
    expect(
      () =>
        new ElevenLabsAdapter({
          apiKey: 'k',
          storage,
          bucket: 'b',
          usdToGbpRate: 0.75,
          model: 'eleven_turbo_v2',
        }),
    ).toThrow(ConfigurationError);
  });

  it('posts the documented TTS request and stores the MP3', async () => {
    const { adapter, requests, objects } = setup(audio());
    const submitted = await adapter.submit(tts);
    expect(requests[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fabc?output_format=mp3_44100_128',
      method: 'POST',
      headers: { 'xi-api-key': 'xi-key' },
      body: { text: tts.text, model_id: 'eleven_multilingual_v2', language_code: 'en' },
    });
    // 40 chars billed * $0.10/1k * 0.75 = 0.3p → 1p
    expect(submitted.estimatedCostPence).toBe(1);

    const polled = await adapter.poll(submitted.providerJobId);
    const metadata = polled.output?.metadata as {
      s3Key: string;
      characters: number;
      requestId: string;
    };
    expect(metadata).toMatchObject({ characters: 40, requestId: 'req-1' });
    expect(polled.output?.url).toContain(metadata.s3Key);
    expect(objects.get(`studio-assets-dev/${metadata.s3Key}`)?.body).toEqual(MP3);
  });

  it('falls back to text length when character-cost is absent', async () => {
    const { adapter } = setup(audio({}));
    const { providerJobId } = await adapter.submit({ ...tts, languageCode: undefined });
    const metadata = (await adapter.poll(providerJobId)).output?.metadata as { characters: number };
    expect(metadata.characters).toBe(tts.text.length);
  });

  it('rejects empty or over-limit text without calling the API', async () => {
    const { adapter, requests } = setup();
    await expect(adapter.submit({ ...tts, text: '' })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(adapter.submit({ ...tts, text: 'x'.repeat(10_001) })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    [
      json({ detail: { code: 'insufficient_credits', message: 'no credits' } }, 402),
      'insufficient_credits',
      false,
    ],
    [
      json({ detail: { status: 'quota_exceeded', message: 'quota' } }, 401),
      'insufficient_credits',
      false,
    ],
    [
      json({ detail: { code: 'concurrent_limit_exceeded', message: 'busy' } }, 429),
      'rate_limited',
      true,
    ],
    [json({ detail: { code: 'invalid_api_key', message: 'bad' } }, 401), 'auth', false],
    [json({ detail: 'Validation failed' }, 422), 'invalid_request', false],
  ])('classifies API errors (%#)', async (reply, errorClass, retryable) => {
    const { adapter } = setup(reply);
    await expect(adapter.submit(tts)).rejects.toMatchObject({ errorClass, retryable });
  });

  it('treats an empty audio body as a retryable failure', async () => {
    const { adapter } = setup(new Response(new Uint8Array(), { status: 200 }));
    await expect(adapter.submit(tts)).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('maps timeouts on the request', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const { adapter } = setup(timeout);
    await expect(adapter.submit(tts)).rejects.toMatchObject({
      errorClass: 'timeout',
      retryable: true,
    });
  });

  it('checks health via the subscription endpoint', async () => {
    const ok = setup(json({ tier: 'creator', status: 'active' }));
    await expect(ok.adapter.healthCheck()).resolves.toEqual({ healthy: true });
    expect(ok.requests[0]?.url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    const bad = setup(json({ detail: { code: 'invalid_api_key', message: 'bad' } }, 401));
    expect((await bad.adapter.healthCheck()).reason).toContain('auth');
    const down = setup(new TypeError('fetch failed'));
    expect((await down.adapter.healthCheck()).healthy).toBe(false);
  });

  it('estimates cost from text length and rejects other capabilities', async () => {
    const { adapter } = setup();
    expect(adapter.estimateCostPence({ ...tts, text: 'x'.repeat(2000) })).toBe(15); // $0.20 → 15p
    await expect(
      adapter.submit({ capability: 'embedding', organisationId: 'o', input: ['x'], dimensions: 1 }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});
