import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import type { ActorVideoRequest } from './interface';
import { KlingAdapter, klingOptionsFromEnv } from './kling';

// BACKLOG 21.4 — Kling 3.0 actor clips WITH native audio, opt-in (KLING_UGC_ACTOR=1). Shapes from
// https://kling.ai/document-api/apiReference/model/textToVideo (settings.audio "native") and the
// price from https://kling.ai/document-api/pricing/base/video (0.9 units/s at 720p), 2026-10-04.

const actor: ActorVideoRequest = {
  capability: 'actor_video',
  organisationId: 'org-1',
  prompt: 'Selfie video of a man around forty at a desk.',
  spokenLine: 'This "one" app saves me an hour a day.',
  languageCode: 'en-GB',
  durationSec: 6,
  aspectRatio: '9:16',
  productImageUrl: 'https://cdn.example/product.png',
  seed: 7,
};

function adapter(actorVideo: boolean, replies: Parameters<typeof fakeFetch> = []) {
  const fake = fakeFetch(...replies);
  return {
    kling: new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: 'FAKE-kling' },
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => 0,
      ...(actorVideo && { actorVideo: true }),
    }),
    requests: fake.requests,
  };
}

describe('Kling actor clips (21.4, opt-in)', () => {
  it('KLING_UGC_ACTOR: 1 turns it on, 0 or empty leaves it off, anything else is an error', () => {
    expect(klingOptionsFromEnv({ KLING_UGC_ACTOR: '1' })).toEqual({ actorVideo: true });
    expect(klingOptionsFromEnv({ KLING_UGC_ACTOR: '0' })).toEqual({});
    expect(klingOptionsFromEnv({})).toEqual({});
    expect(() => klingOptionsFromEnv({ KLING_UGC_ACTOR: 'yes' })).toThrow(ConfigurationError);
  });

  it('off by default: no actor_video capability and the router hint says no', () => {
    const { kling } = adapter(false);
    expect(kling.capabilities).not.toContain('actor_video');
    expect(kling.supportsRequest(actor)).toBe(false);
  });

  it('on: text-to-video with native audio, the line quoted, no product image sent', async () => {
    const { kling, requests } = adapter(true, [
      json({ code: 0, data: { id: 'task_1', status: 'submitted' } }),
    ]);
    expect(kling.capabilities).toContain('actor_video');
    const submitted = await kling.submit(actor);
    expect(requests[0]).toMatchObject({
      url: 'https://api-singapore.klingai.com/text-to-video/kling-3.0',
      body: {
        prompt:
          'Selfie video of a man around forty at a desk.\nThe person speaks directly to the camera and says: "This \'one\' app saves me an hour a day."',
        settings: {
          multi_shot: false,
          audio: 'native',
          resolution: '720p',
          duration: 6,
          aspect_ratio: '9:16',
        },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('product.png');
    // 0.9 units × $0.14 = $0.126/s × 6 s = $0.756 × 0.75 = 56.7 → 57p.
    expect(submitted.estimatedCostPence).toBe(57);
  });
});
