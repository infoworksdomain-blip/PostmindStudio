import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { LANGUAGES } from '../languages';
import {
  ASSEMBLYAI_LANGUAGE_CODES,
  AssemblyAiAdapter,
  EU_BASE_URL,
  US_BASE_URL,
  assemblyAiLanguageCode,
} from './assemblyai';

// Contract from assemblyai.com/docs (read 2026-09-27), see assemblyai.ts header comment.

const NOW = Date.parse('2026-09-27T12:00:00Z');

function adapter(options: { region?: 'us' | 'eu' } = {}, ...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    aai: new AssemblyAiAdapter({
      apiKey: 'aai-key',
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
      ...options,
    }),
    requests: fake.requests,
  };
}

const transcriptionRequest = {
  capability: 'transcription' as const,
  organisationId: 'org-1',
  mediaUrl: 'https://cdn.example/audio.mp4',
  durationSec: 3600,
};

describe('AssemblyAiAdapter.submit', () => {
  it('posts to /v2/transcript with the raw key as the authorization header and { audio_url } body', async () => {
    const { aai, requests } = adapter({}, json({ id: 'transcript-1', status: 'queued' }));
    const submitted = await aai.submit(transcriptionRequest);
    expect(requests[0]).toMatchObject({
      url: `${US_BASE_URL}/v2/transcript`,
      method: 'POST',
      headers: { authorization: 'aai-key', 'content-type': 'application/json' },
      body: { audio_url: transcriptionRequest.mediaUrl },
    });
    // 3600s = 1h * $0.21/h * 0.75 = 15.75p → rounds to 16p
    expect(submitted).toEqual({
      providerJobId: 'transcript-1',
      estimatedCostPence: 16,
      estimatedReadyAt: new Date(NOW + (3600 / 4) * 1000),
    });
  });

  it('uses the EU base URL when region is "eu"', async () => {
    const { aai, requests } = adapter({ region: 'eu' }, json({ id: 't', status: 'queued' }));
    await aai.submit(transcriptionRequest);
    expect(requests[0]?.url).toBe(`${EU_BASE_URL}/v2/transcript`);
  });

  it('estimates a minimum 15s readiness window for very short audio', async () => {
    const { aai } = adapter({}, json({ id: 't', status: 'queued' }));
    const submitted = await aai.submit({ ...transcriptionRequest, durationSec: 8 });
    expect(submitted.estimatedReadyAt).toEqual(new Date(NOW + 15_000));
  });

  it('rejects unsupported capabilities with a non-retryable invalid_request, without calling the API', async () => {
    const { aai, requests } = adapter({});
    await expect(
      aai.submit({ capability: 'tts', organisationId: 'o', text: 'hi', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request', retryable: false });
    expect(requests).toHaveLength(0);
  });
});

describe('AssemblyAiAdapter.poll', () => {
  it.each(['queued', 'processing'] as const)('treats status %s as running', async (status) => {
    const { aai } = adapter({}, json({ id: 't', status }));
    await expect(aai.poll('t')).resolves.toEqual({ state: 'running' });
  });

  it('converts word timings from ms to seconds and reports cost from audio_duration on success', async () => {
    const { aai } = adapter(
      {},
      json({
        id: 't',
        status: 'completed',
        text: 'hello world',
        words: [{ text: 'hello', start: 0, end: 500, confidence: 0.9 }],
        audio_duration: 7200,
        language_code: 'en',
      }),
    );
    const polled = await aai.poll('t');
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: {
        metadata: {
          text: 'hello world',
          words: [{ text: 'hello', startSec: 0, endSec: 0.5 }],
          languageCode: 'en',
          audioDurationSec: 7200,
          // 7200s = 2h * $0.21/h * 0.75 = 31.5p → rounds to 32p
          costPence: 32,
        },
      },
    });
  });

  it('classifies a download/transcoding error message as non-retryable invalid_request', async () => {
    const { aai } = adapter(
      {},
      json({ id: 't', status: 'error', error: 'Download error: file could not be fetched' }),
    );
    await expect(aai.poll('t')).resolves.toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request', retryable: false },
    });
  });

  it('classifies an unrecognised error message as retryable provider_unavailable', async () => {
    const { aai } = adapter(
      {},
      json({ id: 't', status: 'error', error: 'internal server hiccup' }),
    );
    await expect(aai.poll('t')).resolves.toMatchObject({
      state: 'failed',
      error: { class: 'provider_unavailable', retryable: true },
    });
  });

  it('reports a 404 as retryable result_expired', async () => {
    const { aai } = adapter({}, json({ error: 'not found' }, 404));
    await expect(aai.poll('gone')).resolves.toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
  });
});

describe('AssemblyAiAdapter.cancel', () => {
  it('sends a DELETE request', async () => {
    const { aai, requests } = adapter({}, new Response(null, { status: 200 }));
    await aai.cancel('t');
    expect(requests[0]).toMatchObject({ url: `${US_BASE_URL}/v2/transcript/t`, method: 'DELETE' });
  });

  it('ignores a 404 on cancel', async () => {
    const { aai } = adapter({}, json({ error: 'gone' }, 404));
    await expect(aai.cancel('gone')).resolves.toBeUndefined();
  });

  it('propagates other cancel failures', async () => {
    const { aai } = adapter({}, json({ error: 'down' }, 503));
    await expect(aai.cancel('t')).rejects.toMatchObject({ errorClass: 'provider_unavailable' });
  });
});

describe('AssemblyAiAdapter.healthCheck', () => {
  it('is healthy when the probe transcript id returns 404 (proves auth + reachability)', async () => {
    const { aai } = adapter({}, json({ error: 'not found' }, 404));
    await expect(aai.healthCheck()).resolves.toEqual({ healthy: true });
  });

  it('is unhealthy on a 401', async () => {
    const { aai } = adapter({}, json({ error: 'bad key' }, 401));
    const result = await aai.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('auth');
  });
});

describe('AssemblyAiAdapter.estimateCostPence', () => {
  it('prices transcription by duration and 0 for other capabilities', () => {
    const { aai } = adapter({});
    expect(aai.estimateCostPence(transcriptionRequest)).toBe(16);
    expect(
      aai.estimateCostPence({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).toBe(0);
  });
});

describe('AssemblyAI language codes (15.C5)', () => {
  // Codes from https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages
  // (Universal-3.5 Pro list, read 2026-09-28).
  const DOCUMENTED = new Set([
    'en',
    'en_au',
    'en_uk',
    'en_us',
    'es',
    'fr',
    'de',
    'it',
    'pt',
    'ar',
    'hi',
    'zh',
  ]);

  it('maps every Studio language to a documented code', () => {
    for (const language of LANGUAGES) {
      const code = assemblyAiLanguageCode(language.code);
      expect(code, language.code).toBeDefined();
      expect(DOCUMENTED.has(code as string), `${language.code} → ${code}`).toBe(true);
    }
    expect(Object.keys(ASSEMBLYAI_LANGUAGE_CODES).sort()).toEqual(
      LANGUAGES.map((l) => l.code).sort(),
    );
    expect(assemblyAiLanguageCode('en-GB')).toBe('en_uk');
    expect(assemblyAiLanguageCode('en-us')).toBe('en_us');
    expect(assemblyAiLanguageCode('pt-BR')).toBe('pt');
    expect(assemblyAiLanguageCode('zh-Hans')).toBe('zh');
    expect(assemblyAiLanguageCode('xx')).toBeUndefined();
    expect(assemblyAiLanguageCode(undefined)).toBeUndefined();
  });

  it('sends language_code in the request body when the language is known', async () => {
    const { aai, requests } = adapter(
      {},
      json({ id: 't', status: 'queued' }),
      json({ id: 'u', status: 'queued' }),
    );
    await aai.submit({ ...transcriptionRequest, languageCode: 'ar' });
    expect(requests[0]?.body).toEqual({
      audio_url: transcriptionRequest.mediaUrl,
      language_code: 'ar',
    });
    await aai.submit({ ...transcriptionRequest, languageCode: 'klingon' });
    expect(requests[1]?.body).toEqual({ audio_url: transcriptionRequest.mediaUrl });
  });
});
