import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ConfigurationError } from '../../errors';
import { ShotstackAdapter } from './shotstack';

// Fixtures follow shotstack.io/docs/api (render envelope and status values).
const NOW = Date.parse('2026-09-27T12:00:00Z');

function setup(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    shotstack: new ShotstackAdapter({
      apiKey: 'ss-key',
      environment: 'stage',
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

const edit = {
  timeline: {
    tracks: [
      { clips: [{ asset: { type: 'video', src: 'https://s3/clip.mp4' }, start: 0, length: 5 }] },
    ],
  },
  output: { format: 'mp4', resolution: 'hd', aspectRatio: '9:16' },
};
const composition = {
  capability: 'composition' as const,
  organisationId: 'org-1',
  edit,
  outputDurationSec: 30,
};

describe('ShotstackAdapter', () => {
  it('estimates at the list price: $0.30 a rendered minute, whole seconds rounded down (20.25)', () => {
    const { shotstack } = setup();
    const at = (outputDurationSec: number) =>
      shotstack.estimateCostPence({ ...composition, outputDurationSec });
    expect(at(30)).toBe(12); // $0.15 → 11.25p → 12p
    expect(at(30.9)).toBe(12); // rounded down to 30 s
    expect(at(60)).toBe(23); // $0.30 → 22.5p → 23p
    expect(at(180)).toBe(68); // $0.90 → 67.5p → 68p
    expect(at(0.4)).toBe(1); // at least one second
    expect(
      shotstack.estimateCostPence({
        capability: 'tts',
        organisationId: 'o',
        text: 'x',
        voiceId: 'v',
      }),
    ).toBe(0);
  });

  it('only accepts the documented environments', () => {
    expect(
      () => new ShotstackAdapter({ apiKey: 'k', environment: 'prod', usdToGbpRate: 0.75 }),
    ).toThrow(ConfigurationError);
  });

  it('POSTs the edit to /render and returns the render id', async () => {
    const { shotstack, requests } = setup(
      json(
        {
          success: true,
          message: 'Created',
          response: { message: 'Render Successfully Queued', id: 'r-1' },
        },
        201,
      ),
    );
    const submitted = await shotstack.submit(composition);
    expect(requests[0]).toMatchObject({
      url: 'https://api.shotstack.io/edit/stage/render',
      method: 'POST',
      headers: { 'x-api-key': 'ss-key' },
      body: edit,
    });
    expect(submitted).toEqual({
      providerJobId: 'r-1',
      estimatedCostPence: 12, // 20.25: 0.5 min × $0.30 = $0.15 × 0.75 = 11.25p, rounded up
      estimatedReadyAt: new Date(NOW + 120_000),
    });
  });

  it('fails retryably when the create response has no id', async () => {
    const { shotstack } = setup(json({ success: true, message: 'Created', response: {} }, 201));
    await expect(shotstack.submit(composition)).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('surfaces the API error message', async () => {
    const { shotstack } = setup(
      json(
        { success: false, message: 'Bad Request', response: { error: 'Invalid timeline' } },
        400,
      ),
    );
    await expect(shotstack.submit(composition)).rejects.toMatchObject({
      errorClass: 'invalid_request',
      message: 'Invalid timeline',
    });
  });

  it.each(['queued', 'fetching', 'preprocessing', 'rendering', 'generating', 'saving'])(
    'treats %s as running',
    async (status) => {
      const { shotstack, requests } = setup(
        json({ success: true, message: 'OK', response: { id: 'r-1', status } }),
      );
      await expect(shotstack.poll('r-1')).resolves.toEqual({ state: 'running' });
      expect(requests[0]?.url).toBe('https://api.shotstack.io/edit/stage/render/r-1?data=false');
    },
  );

  it('returns the render URL when done', async () => {
    const { shotstack } = setup(
      json({
        success: true,
        message: 'OK',
        response: { id: 'r-1', status: 'done', url: 'https://cdn.shotstack/r-1.mp4', duration: 30 },
      }),
    );
    await expect(shotstack.poll('r-1')).resolves.toMatchObject({
      state: 'succeeded',
      output: {
        url: 'https://cdn.shotstack/r-1.mp4',
        metadata: { renderId: 'r-1', durationSec: 30 },
      },
    });
  });

  it('reports failed renders with the provider error', async () => {
    const { shotstack } = setup(
      json({
        success: true,
        message: 'OK',
        response: { id: 'r-1', status: 'failed', error: 'Asset 404' },
      }),
    );
    await expect(shotstack.poll('r-1')).resolves.toMatchObject({
      state: 'failed',
      error: { message: 'Asset 404' },
    });
  });

  it('cancel is a documented no-op (Shotstack has no cancel endpoint)', async () => {
    const { shotstack, requests } = setup();
    await expect(shotstack.cancel('r-1')).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('health check calls GET /templates', async () => {
    const ok = setup(json({ success: true, message: 'OK', response: { templates: [] } }));
    await expect(ok.shotstack.healthCheck()).resolves.toEqual({ healthy: true });
    expect(ok.requests[0]?.url).toBe('https://api.shotstack.io/edit/stage/templates');
    const bad = setup(json({ success: false, message: 'Forbidden' }, 403));
    expect((await bad.shotstack.healthCheck()).reason).toContain('auth');
  });

  it('rejects non-composition requests', async () => {
    const { shotstack } = setup();
    await expect(
      shotstack.submit({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(
      shotstack.estimateCostPence({
        capability: 'tts',
        organisationId: 'o',
        text: 't',
        voiceId: 'v',
      }),
    ).toBe(0);
  });
});
