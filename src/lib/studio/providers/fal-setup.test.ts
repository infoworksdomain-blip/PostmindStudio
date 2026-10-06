import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import {
  createFalModelAdapter,
  FalAdapter,
  falJobId,
  falOptionsFromEnv,
  parseFalJobId,
  parseFalVideoModels,
} from './fal';
import { classifyFalErrorType, classifyFalHttpError, falErrorMessage } from './fal-errors';
import type { FalVideoModelKey } from './fal-models';
import type { TextToVideoRequest } from './interface';
import { createProviderRegistry } from './registry';
import { routeProvider, type RouteInput } from './router';

// 24.1: fal job ids, error mapping, env opt-in, the one-model script entry point and routing.
const REQ_ID = '764cabcf-b745-4b3e-ae38-1200304cf45b';

function adapter(models: FalVideoModelKey[]) {
  return { fal: new FalAdapter({ apiKey: 'fal-key', usdToGbpRate: 0.75, models }) };
}

const t2v: TextToVideoRequest = {
  capability: 'text_to_video',
  organisationId: 'org-1',
  prompt: 'Steam rising from fresh bread',
  durationSec: 5,
  aspectRatio: '9:16',
  resolution: '720p',
};

const submitted = (endpoint: string) => ({
  request_id: REQ_ID,
  status_url: `https://queue.fal.run/${endpoint}/requests/${REQ_ID}/status`,
});

describe('fal helpers', () => {
  it('round-trips job ids and rejects anything else', () => {
    expect(parseFalJobId(falJobId('veo-3.1-lite', 'i2v', REQ_ID))).toEqual({
      model: 'veo-3.1-lite',
      mode: 'i2v',
      requestId: REQ_ID,
    });
    expect(parseFalJobId(`sora:t2v:${REQ_ID}`)).toBeUndefined();
    expect(parseFalJobId(`minimax-h3-max:x2v:${REQ_ID}`)).toBeUndefined();
    expect(parseFalJobId('minimax-h3-max:t2v:../../x')).toBeUndefined();
  });

  it('classifies error types and messages', () => {
    expect(classifyFalErrorType('content_policy_violation')).toEqual({
      class: 'content_policy',
      retryable: false,
    });
    expect(classifyFalErrorType('runner_disconnected').class).toBe('provider_unavailable');
    expect(classifyFalErrorType('bad_request').class).toBe('invalid_request');
    expect(classifyFalErrorType(undefined, 'Insufficient balance').class).toBe(
      'insufficient_credits',
    );
    expect(classifyFalErrorType('something_new', 'odd')).toEqual({
      class: 'unknown',
      retryable: false,
    });
    expect(classifyFalHttpError(500, { detail: 'boom' })).toBeUndefined();
    expect(falErrorMessage('plain')).toBe('plain');
    expect(falErrorMessage({ error: 'e' })).toBe('e');
    expect(falErrorMessage(42)).toBeUndefined();
  });

  it('parses STUDIO_FAL_VIDEO_MODELS strictly', () => {
    expect(parseFalVideoModels(undefined)).toEqual([]);
    expect(parseFalVideoModels(' ltx-2.3-fast , minimax-h3-max ')).toEqual([
      'ltx-2.3-fast',
      'minimax-h3-max',
    ]);
    expect(() => parseFalVideoModels('sora-2')).toThrow(ConfigurationError);
    expect(() => parseFalVideoModels('ltx-2.3-fast,ltx-2.3-fast')).toThrow(/twice/);
  });

  it('is off without models and needs FAL_KEY once models are listed', () => {
    expect(falOptionsFromEnv({ FAL_KEY: 'k' })).toBeUndefined();
    expect(() => falOptionsFromEnv({ STUDIO_FAL_VIDEO_MODELS: 'ltx-2.3-fast' })).toThrow(/FAL_KEY/);
    expect(falOptionsFromEnv({ STUDIO_FAL_VIDEO_MODELS: 'ltx-2.3-fast', FAL_KEY: ' k ' })).toEqual({
      apiKey: 'k',
      models: ['ltx-2.3-fast'],
    });
    expect(() => new FalAdapter({ apiKey: 'k', usdToGbpRate: 1, models: [] })).toThrow(
      ConfigurationError,
    );
  });

  it('createFalModelAdapter targets one model directly (scripts, bake-offs)', async () => {
    const fake = fakeFetch(json(submitted('fal-ai/veo3.1/lite')));
    const fal = createFalModelAdapter('veo-3.1-lite', {
      usdToGbpRate: 0.75,
      env: { FAL_KEY: 'script-key' },
      fetchImpl: fake.fetch,
    });
    expect(fal.models).toEqual(['veo-3.1-lite']);
    await fal.submit({ ...t2v, durationSec: 4 });
    expect(fake.requests[0]).toMatchObject({
      url: 'https://queue.fal.run/fal-ai/veo3.1/lite',
      headers: { authorization: 'Key script-key' },
      body: { duration: '4s', aspect_ratio: '9:16' },
    });
    expect(() => createFalModelAdapter('ltx-2.3-fast', { usdToGbpRate: 1, env: {} })).toThrow(
      /FAL_KEY/,
    );
  });
});

describe('router with the opt-in fal adapter', () => {
  const routeDeps = (fal?: FalAdapter) => ({
    registry: createProviderRegistry(fal ? [fal] : []),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
    budget: { hasBudget: async () => true },
    now: () => 0,
  });
  const clip = (planTier: RouteInput['planTier'], request: TextToVideoRequest): RouteInput => ({
    need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: request.durationSec },
    planTier,
    organisationId: 'org-1',
    request,
  });

  it('routes BASIC clips to fal after Seedance, Kling and Veo when enabled', async () => {
    const decision = await routeProvider(
      clip('BASIC', t2v),
      routeDeps(adapter(['ltx-2.3-fast']).fal),
    );
    expect(decision.providerId).toBe('fal');
    expect(decision.candidates.map((c) => c.providerId)).toEqual([
      'seedance',
      'kling',
      'veo',
      'fal',
    ]);
  });

  it('keeps fal last on paid tiers and skips it when unregistered', async () => {
    const decision = await routeProvider(
      clip('PLUS', t2v),
      routeDeps(adapter(['minimax-h3-max']).fal),
    );
    expect(decision.candidates.at(-1)).toEqual({ providerId: 'fal' });
    await expect(routeProvider(clip('PLUS', t2v), routeDeps())).rejects.toMatchObject({
      details: {
        candidates: expect.arrayContaining([{ providerId: 'fal', skipped: 'not_configured' }]),
      },
    });
  });

  it('skips fal when no enabled model fits the shot', async () => {
    await expect(
      routeProvider(
        clip('BASIC', { ...t2v, aspectRatio: '1:1' }),
        routeDeps(adapter(['ltx-2.3-fast']).fal),
      ),
    ).rejects.toMatchObject({
      details: {
        candidates: expect.arrayContaining([
          { providerId: 'fal', skipped: 'capability_unsupported' },
        ]),
      },
    });
  });
});
