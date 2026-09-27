import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ConfigurationError, ProviderError } from '../../errors';
import { ElevenLabsMusicAdapter, musicLengthMs } from './elevenlabs-music';

// Fixtures follow elevenlabs.io/docs/api-reference/music/compose: raw audio body with a
// `song-id` response header; 422 `{ detail: [{ loc, msg, type }] }`; and the quickstart's
// `{ detail: { status: 'bad_prompt', data: { prompt_suggestion } } }` refusal.
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);

function audio(headers: Record<string, string> = { 'song-id': 'song-123' }) {
  return new Response(MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg', ...headers } });
}

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  const { storage, objects } = memoryStorage();
  const adapter = new ElevenLabsMusicAdapter({
    apiKey: 'xi-key',
    storage,
    bucket: 'studio-assets-dev',
    usdToGbpRate: 0.75,
    fetchImpl: fake.fetch,
  });
  return { adapter, requests: fake.requests, objects };
}

const music = {
  capability: 'music' as const,
  organisationId: 'org-1',
  projectId: 'proj-1',
  prompt: 'Instrumental background music, no vocals. Mood: warm, upbeat.',
  durationSec: 30,
};

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('ElevenLabsMusicAdapter', () => {
  it('rejects unknown models at construction', () => {
    const { storage } = memoryStorage();
    expect(
      () =>
        new ElevenLabsMusicAdapter({
          apiKey: 'k',
          storage,
          bucket: 'b',
          usdToGbpRate: 0.75,
          model: 'suno_v4',
        }),
    ).toThrow(ConfigurationError);
  });

  it('posts the documented compose request (instrumental) and stores the MP3', async () => {
    const { adapter, requests, objects } = setup(audio());
    const submitted = await adapter.submit(music);
    expect(requests[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128',
      method: 'POST',
      headers: { 'xi-api-key': 'xi-key', 'content-type': 'application/json' },
      body: {
        prompt: music.prompt,
        music_length_ms: 30_000,
        model_id: 'music_v2_5',
        force_instrumental: true,
      },
    });
    expect(requests[0]?.body).not.toHaveProperty('composition_plan');
    // 0.5 min × $0.15 × 0.75 = 5.625p → 6p (rounded up)
    expect(submitted.estimatedCostPence).toBe(6);

    const polled = await adapter.poll(submitted.providerJobId);
    const metadata = polled.output?.metadata as {
      s3Key: string;
      songId: string;
      durationSec: number;
      costPence: number;
    };
    expect(metadata).toMatchObject({ songId: 'song-123', durationSec: 30, costPence: 6 });
    expect(polled.output?.url).toContain(metadata.s3Key);
    expect(metadata.s3Key).toContain('/providers/elevenlabs-music/');
    expect(objects.get(`studio-assets-dev/${metadata.s3Key}`)?.body).toEqual(MP3);
  });

  it('clamps length to the documented 3 s – 5 min range', async () => {
    expect(musicLengthMs(1)).toBe(3_000);
    expect(musicLengthMs(12.4)).toBe(12_400);
    expect(musicLengthMs(600)).toBe(300_000);
    const { adapter, requests } = setup(audio());
    await adapter.submit({ ...music, durationSec: 360 });
    expect((requests[0]?.body as { music_length_ms: number }).music_length_ms).toBe(300_000);
  });

  it('estimates cost from the documented per-minute price', () => {
    const { adapter } = setup();
    expect(adapter.estimateCostPence(music)).toBe(6);
    // 5 min × $0.15 × 0.75 = 56.25p → 57p
    expect(adapter.estimateCostPence({ ...music, durationSec: 900 })).toBe(57);
    expect(
      adapter.estimateCostPence({
        capability: 'tts',
        organisationId: 'o',
        text: 'x',
        voiceId: 'v',
      }),
    ).toBe(0);
  });

  it('maps bad_prompt to a non-retryable content_policy error', async () => {
    const { adapter } = setup(
      json(
        {
          detail: {
            status: 'bad_prompt',
            message: 'Prompt references copyrighted material',
            data: { prompt_suggestion: 'An upbeat pop instrumental' },
          },
        },
        400,
      ),
    );
    const err = await rejection(adapter.submit(music));
    expect(err).toMatchObject({ errorClass: 'content_policy', retryable: false });
    expect(err.message).toContain('bad_prompt');
  });

  it('maps a 422 validation body to invalid_request', async () => {
    const { adapter } = setup(
      json(
        {
          detail: [
            { loc: ['body', 'music_length_ms'], msg: 'must be ≥ 3000', type: 'value_error' },
          ],
        },
        422,
      ),
    );
    const err = await rejection(adapter.submit(music));
    expect(err).toMatchObject({ errorClass: 'invalid_request', retryable: false });
    expect(err.message).toContain('body.music_length_ms');
  });

  it.each([
    [401, { detail: { status: 'invalid_api_key', message: 'bad key' } }, 'auth', false],
    [
      402,
      { detail: { status: 'insufficient_credits', message: 'upgrade' } },
      'insufficient_credits',
      false,
    ],
    [429, { detail: { status: 'too_many_concurrent_requests' } }, 'rate_limited', true],
    [503, {}, 'provider_unavailable', true],
  ] as const)('maps HTTP %i to %s', async (status, body, errorClass, retryable) => {
    const { adapter } = setup(json(body, status));
    expect(await rejection(adapter.submit(music))).toMatchObject({ errorClass, retryable });
  });

  it('treats network timeouts as retryable', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const { adapter } = setup(timeout);
    expect(await rejection(adapter.submit(music))).toMatchObject({
      errorClass: 'timeout',
      retryable: true,
    });
  });

  it('rejects an empty audio body and bad input before calling the API', async () => {
    const { adapter } = setup(new Response(new Uint8Array(), { status: 200 }));
    expect(await rejection(adapter.submit(music))).toMatchObject({ errorClass: 'unknown' });
    const second = setup();
    expect(await rejection(second.adapter.submit({ ...music, prompt: '  ' }))).toMatchObject({
      errorClass: 'invalid_request',
    });
    expect(await rejection(second.adapter.submit({ ...music, durationSec: 0 }))).toMatchObject({
      errorClass: 'invalid_request',
    });
    expect(
      await rejection(
        second.adapter.submit({ capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' }),
      ),
    ).toMatchObject({ errorClass: 'invalid_request' });
    expect(second.requests).toHaveLength(0);
  });

  it('poll after cancel reports an expired result', async () => {
    const { adapter } = setup(audio());
    const { providerJobId } = await adapter.submit(music);
    await adapter.cancel(providerJobId);
    expect(await adapter.poll(providerJobId)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('health check uses the subscription endpoint', async () => {
    const ok = setup(json({ tier: 'creator' }));
    expect(await ok.adapter.healthCheck()).toEqual({ healthy: true });
    expect(ok.requests[0]?.url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    const bad = setup(json({ detail: { status: 'invalid_api_key', message: 'nope' } }, 401));
    expect(await bad.adapter.healthCheck()).toMatchObject({ healthy: false });
    const down = setup(new Error('ECONNRESET'));
    expect((await down.adapter.healthCheck()).reason).toContain('provider_unavailable');
  });
});
