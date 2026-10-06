import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { NO_ON_SCREEN_TEXT } from './dialogue';
import type { ActorVideoRequest } from './interface';
import {
  actorDuration,
  actorReferenceUrls,
  DEFAULT_VEO_MODEL,
  MAX_REFERENCE_IMAGES,
  VeoAdapter,
  withDialogue,
} from './veo';

// BACKLOG 21.4 — Veo 3.1 actor clips (UGC). Request shapes follow
// https://ai.google.dev/gemini-api/docs/veo (read 2026-10-04): dialogue in quotes, `referenceImages`
// [{ image, referenceType: "asset" }] with 8 s and allow_adult, `seed`. No real API is called.

const KEY = 'FAKE-gemini-key-0123456789';
const OP = 'models/veo-3.1-fast-generate-preview/operations/actor123';
const running = { name: OP, metadata: {} };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function adapter(
  replies: Parameters<typeof fakeFetch>,
  options: Partial<ConstructorParameters<typeof VeoAdapter>[0]> = {},
) {
  const fake = fakeFetch(...replies);
  return {
    veo: new VeoAdapter({
      apiKey: KEY,
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => 0,
      ...options,
    }),
    requests: fake.requests,
  };
}

const actor: ActorVideoRequest = {
  capability: 'actor_video',
  organisationId: 'org-1',
  prompt: 'Vertical selfie-style video of a woman around thirty in a kitchen.',
  spokenLine: 'Honestly, this "little" jar changed my mornings.',
  languageCode: 'en-GB',
  durationSec: 6,
  aspectRatio: '9:16',
  seed: 4242,
};

describe('Veo actor clips (21.4)', () => {
  it('quotes the spoken line in the documented dialogue form, then forbids on-screen text', () => {
    expect(withDialogue(' Scene. ', '  Hi   "there" ')).toBe(
      `Scene.\nThe person speaks directly to the camera and says: "Hi 'there'"\n${NO_ON_SCREEN_TEXT}`,
    );
  });

  it('21.4c: the actor prompt ENDS with the no-text instruction, after the line', async () => {
    const { veo } = adapter([]);
    const body = (await veo.buildBody(actor)) as { instances: Array<{ prompt: string }> };
    const prompt = body.instances[0]?.prompt ?? '';
    expect(prompt.endsWith(NO_ON_SCREEN_TEXT)).toBe(true);
    expect(prompt.indexOf('says: "')).toBeLessThan(prompt.indexOf(NO_ON_SCREEN_TEXT));
    // A prompt change only: no negativePrompt (Veo 3.1 documents none, read 2026-10-06).
    expect(JSON.stringify(body)).not.toContain('negativePrompt');
  });

  it('declares actor_video and supports English lines of 1–8 s only', () => {
    const { veo } = adapter([]);
    expect(veo.capabilities).toContain('actor_video');
    expect(veo.supportsRequest(actor)).toBe(true);
    expect(veo.supportsRequest({ ...actor, languageCode: 'en-US' })).toBe(true);
    expect(veo.supportsRequest({ ...actor, languageCode: 'fr' })).toBe(false);
    expect(veo.supportsRequest({ ...actor, durationSec: 9 })).toBe(false);
    expect(veo.supportsRequest({ ...actor, spokenLine: '   ' })).toBe(false);
    expect(veo.supportsRequest({ ...actor, spokenLine: 'x'.repeat(301) })).toBe(false);
  });

  it('text-to-video actor clip: line in quotes, 9:16, next length up, the seed, no person value', async () => {
    const { veo, requests } = adapter([json(running)]);
    const submitted = await veo.submit(actor);
    expect(requests[0]).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_VEO_MODEL}:predictLongRunning`,
      method: 'POST',
      headers: { 'x-goog-api-key': KEY },
      body: {
        instances: [
          {
            prompt: `Vertical selfie-style video of a woman around thirty in a kitchen.\nThe person speaks directly to the camera and says: "Honestly, this 'little' jar changed my mornings."\n${NO_ON_SCREEN_TEXT}`,
          },
        ],
        parameters: {
          aspectRatio: '9:16',
          durationSeconds: 6,
          resolution: '720p',
          seed: 4242,
          sampleCount: 1,
        },
      },
    });
    const body = requests[0]?.body as { parameters: Record<string, unknown> };
    expect(body.parameters).not.toHaveProperty('personGeneration');
    expect(submitted.providerJobId).toBe(OP);
    // Fast 720p $0.10/s × 6 s × 0.75 = 45p.
    expect(submitted.estimatedCostPence).toBe(45);
  });

  it('with the product image: an asset reference image, 8 s and allow_adult', async () => {
    const { veo, requests } = adapter([
      new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
      json(running),
    ]);
    await veo.submit({ ...actor, productImageUrl: 'https://cdn.example/product.png' });
    expect(requests[0]?.url).toBe('https://cdn.example/product.png');
    expect(requests[1]?.body).toMatchObject({
      instances: [
        {
          referenceImages: [
            {
              image: {
                bytesBase64Encoded: Buffer.from(png).toString('base64'),
                mimeType: 'image/png',
              },
              referenceType: 'asset',
            },
          ],
        },
      ],
      parameters: { durationSeconds: 8, personGeneration: 'allow_adult' },
    });
  });

  it('21.4a: the actor portrait goes first as an asset reference, then the product; 8 s, allow_adult, 9:16', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { veo, requests } = adapter([
      new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
      new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
      json(running),
    ]);
    const submitted = await veo.submit({
      ...actor,
      actorImageUrl: 'https://cdn.example/actor.jpg',
      productImageUrl: 'https://cdn.example/product.png',
    });
    expect(requests.map((r) => r.url).slice(0, 2)).toEqual([
      'https://cdn.example/actor.jpg',
      'https://cdn.example/product.png',
    ]);
    expect(requests[2]?.body).toEqual({
      instances: [
        {
          prompt: expect.stringContaining('says: "'),
          referenceImages: [
            {
              image: {
                bytesBase64Encoded: Buffer.from(jpeg).toString('base64'),
                mimeType: 'image/jpeg',
              },
              referenceType: 'asset',
            },
            {
              image: {
                bytesBase64Encoded: Buffer.from(png).toString('base64'),
                mimeType: 'image/png',
              },
              referenceType: 'asset',
            },
          ],
        },
      ],
      parameters: {
        aspectRatio: '9:16',
        durationSeconds: 8,
        resolution: '720p',
        personGeneration: 'allow_adult',
        seed: 4242,
        sampleCount: 1,
      },
    });
    // 8 s × $0.10 × 0.75 = 60p, the same as with the product alone.
    expect(submitted.estimatedCostPence).toBe(60);
  });

  it('21.4a: the actor portrait alone is one reference (8 s) and stays within the 3 allowed', async () => {
    const { veo, requests } = adapter([
      new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
      json(running),
    ]);
    await veo.submit({ ...actor, actorImageUrl: 'https://cdn.example/actor.png' });
    const body = requests[1]?.body as {
      instances: Array<{ referenceImages: unknown[] }>;
      parameters: Record<string, unknown>;
    };
    expect(body.instances[0]?.referenceImages).toHaveLength(1);
    expect(body.parameters).toMatchObject({ durationSeconds: 8, personGeneration: 'allow_adult' });
    expect(
      actorReferenceUrls({ actorImageUrl: 'https://a', productImageUrl: 'https://p' }).length,
    ).toBeLessThanOrEqual(MAX_REFERENCE_IMAGES);
  });

  it('21.4a: Veo Lite documents no reference images, so a referenced actor clip is not offered to it', () => {
    const lite = adapter([], { model: 'veo-3.1-lite-generate-preview' }).veo;
    expect(lite.supportsRequest(actor)).toBe(true);
    expect(lite.supportsRequest({ ...actor, actorImageUrl: 'https://cdn.example/a.png' })).toBe(
      false,
    );
  });

  it('a failed portrait download stops before Veo is called', async () => {
    const { veo, requests } = adapter([new Response('gone', { status: 404 })]);
    await expect(
      veo.submit({ ...actor, actorImageUrl: 'https://cdn.example/actor.png' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(requests).toHaveLength(1);
  });

  it('prices the clip length Veo renders (8 s with a reference) at the list price', () => {
    const { veo } = adapter([]);
    expect(actorDuration({ durationSec: 4 })).toBe(4);
    expect(actorDuration({ durationSec: 4, productImageUrl: 'https://x/p.png' })).toBe(8);
    expect(actorDuration({ durationSec: 4, actorImageUrl: 'https://x/a.png' })).toBe(8);
    expect(veo.estimateCostPence({ ...actor, actorImageUrl: 'https://x/a.png' })).toBe(60);
    expect(veo.estimateCostPence({ ...actor, durationSec: 4 })).toBe(30);
    expect(veo.estimateCostPence({ ...actor, productImageUrl: 'https://x/p.png' })).toBe(60);
    const standard = adapter([], { model: 'veo-3.1-generate-preview' }).veo;
    expect(standard.estimateCostPence({ ...actor, productImageUrl: 'https://x/p.png' })).toBe(240);
  });

  it('refuses an unsupported actor request before calling Veo', async () => {
    const { veo, requests } = adapter([]);
    await expect(veo.submit({ ...actor, languageCode: 'de' })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    expect(requests).toHaveLength(0);
  });

  it('classifies a safety refusal of a celebrity likeness as content_policy (not retried)', async () => {
    const { veo } = adapter([
      json(
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'The prompt could not be submitted: it may depict a celebrity.',
          },
        },
        400,
      ),
    ]);
    const err = await veo.submit(actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ errorClass: 'content_policy', retryable: false });
  });

  it('a finished actor clip reports native audio (the narration)', async () => {
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/a1:download?alt=media';
    const { veo } = adapter([
      json({
        name: OP,
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } },
      }),
    ]);
    const polled = await veo.poll(OP);
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: { url: uri, metadata: { audio: 'native', watermark: 'SynthID' } },
    });
  });
});
