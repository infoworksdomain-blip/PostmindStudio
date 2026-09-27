import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { HiveAdapter, summariseHiveOutput } from './hive';

// Fixtures follow docs.thehive.ai V2 task response shape.
const scanResponse = {
  id: 'task-1',
  code: 200,
  status: [
    {
      status: { code: '0', message: 'SUCCESS' },
      response: {
        output: [
          {
            time: 0,
            classes: [
              { class: 'general_nsfw', score: 0.01 },
              { class: 'no_blood', score: 0.99 },
            ],
          },
          {
            time: 1,
            classes: [
              { class: 'general_nsfw', score: 0.02 },
              { class: 'gun_in_hand', score: 0.7 },
            ],
          },
        ],
      },
    },
  ],
};

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    hive: new HiveAdapter({ apiKey: 'hv', usdToGbpRate: 0.75, fetchImpl: fake.fetch }),
    requests: fake.requests,
  };
}

const request = {
  capability: 'content_safety' as const,
  organisationId: 'org-1',
  mediaUrl: 'https://s3.example/render.mp4?sig=1',
  durationSec: 30,
};

describe('summariseHiveOutput', () => {
  it('keeps the max score per class and lists flagged non-"no_" frames', () => {
    expect(summariseHiveOutput(scanResponse)).toEqual({
      framesAnalysed: 2,
      maxScores: { general_nsfw: 0.02, no_blood: 0.99, gun_in_hand: 0.7 },
      flaggedFrames: [{ time: 1, class: 'gun_in_hand', score: 0.7 }],
    });
    expect(summariseHiveOutput({})).toEqual({
      framesAnalysed: 0,
      maxScores: {},
      flaggedFrames: [],
    });
  });
});

describe('HiveAdapter', () => {
  it('posts the URL as a form field with token auth and returns the scan', async () => {
    const { hive, requests } = setup(json(scanResponse));
    const { providerJobId, estimatedCostPence } = await hive.submit(request);
    expect(requests[0]?.url).toBe('https://api.thehive.ai/api/v2/task/sync');
    expect(requests[0]?.headers.authorization).toBe('token hv');
    expect((requests[0]?.body as FormData).get('url')).toBe(request.mediaUrl);
    expect(estimatedCostPence).toBe(1); // 2 frames * $0.003
    const polled = await hive.poll(providerJobId);
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: { metadata: { framesAnalysed: 2 } },
    });
  });

  it('refuses videos over the 90s sync limit without calling Hive', async () => {
    const { hive, requests } = setup();
    await expect(hive.submit({ ...request, durationSec: 91 })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  it('reports non-success task status and empty output as retryable failures', async () => {
    const bad = setup(json({ status: [{ status: { code: '1', message: 'ERROR' } }] }));
    const r1 = await bad.hive.poll((await bad.hive.submit(request)).providerJobId);
    expect(r1).toMatchObject({ state: 'failed', error: { retryable: true } });
    const empty = setup(json({ status: [{ status: { code: '0' }, response: { output: [] } }] }));
    const r2 = await empty.hive.poll((await empty.hive.submit(request)).providerJobId);
    expect(r2).toMatchObject({ state: 'failed', error: { message: 'Hive returned no frames' } });
  });

  it.each([
    [429, 'rate_limited', true],
    [503, 'provider_unavailable', true],
    [403, 'auth', false],
  ])('maps HTTP %i to %s', async (status, errorClass, retryable) => {
    const { hive } = setup(json({ message: 'nope' }, status));
    await expect(hive.submit(request)).rejects.toMatchObject({ errorClass, retryable });
  });

  it('estimates cost at 1 frame per second and rejects other capabilities', async () => {
    const { hive } = setup();
    expect(hive.estimateCostPence(request)).toBe(7); // 30 * $0.003 * 0.75 = 6.75p
    await expect(
      hive.submit({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(
      hive.estimateCostPence({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).toBe(0);
  });

  it('health reports configuration without a billed probe; cancel drops results', async () => {
    const { hive } = setup(json(scanResponse));
    expect((await hive.healthCheck()).healthy).toBe(true);
    expect((await new HiveAdapter({ apiKey: '', usdToGbpRate: 1 }).healthCheck()).healthy).toBe(
      false,
    );
    const { providerJobId } = await hive.submit(request);
    await hive.cancel(providerJobId);
    expect((await hive.poll(providerJobId)).error?.class).toBe('result_expired');
  });
});
