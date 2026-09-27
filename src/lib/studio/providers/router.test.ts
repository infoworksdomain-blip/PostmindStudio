import { describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import { createProviderRegistry } from './registry';
import { planCandidates, routeProvider, type BudgetChecker, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';

const allow: BudgetChecker = { hasBudget: async () => true };

function deps(
  adapters: StubAdapter[],
  overrides: Partial<Parameters<typeof routeProvider>[1]> = {},
) {
  return {
    registry: createProviderRegistry(adapters),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
    budget: allow,
    now: () => 0,
    ...overrides,
  };
}

const aiClip = (planTier: RouteInput['planTier'], extra: Partial<RouteInput> = {}): RouteInput => ({
  need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 8 },
  planTier,
  organisationId: 'org-1',
  projectId: 'proj-1',
  request: {
    capability: 'text_to_video',
    organisationId: 'org-1',
    projectId: 'proj-1',
    prompt: 'p',
    durationSec: 8,
    aspectRatio: '9:16',
  },
  ...extra,
});

describe('planCandidates (spec 6.4 / 6.5)', () => {
  it.each([
    ['BASIC', ['fal', 'replicate']],
    ['STANDARD', ['luma', 'runway', 'kling']],
    ['PLUS', ['veo', 'runway', 'kling']],
    ['ENTERPRISE', ['veo', 'runway', 'kling']],
  ] as const)('AI_CLIP on %s tries %o', (tier, ids) => {
    expect(
      planCandidates({ kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 4 }, tier),
    ).toEqual({
      capability: 'text_to_video',
      providerIds: ids,
    });
  });

  it('routes AI_CLIP with a source frame to image_to_video', () => {
    expect(
      planCandidates(
        { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 4, hasSourceImage: true },
        'STANDARD',
      ).capability,
    ).toBe('image_to_video');
  });

  it.each([
    [false, 'BASIC', ['d-id', 'heygen']],
    [false, 'STANDARD', ['d-id', 'heygen']],
    [false, 'PLUS', ['heygen', 'd-id']],
    [true, 'BASIC', ['heygen']],
  ] as const)('AI_AVATAR custom=%s tier=%s tries %o', (custom, tier, ids) => {
    expect(
      planCandidates(
        {
          kind: 'shot',
          visualTreatment: 'AI_AVATAR',
          durationSec: 5,
          brandHasCustomAvatar: custom,
        },
        tier,
      ).providerIds,
    ).toEqual(ids);
  });

  it.each([
    ['STOCK_FOOTAGE', 'stock_footage', ['storyblocks', 'pexels']],
    ['IMAGE_STILL', 'text_to_image', ['openai', 'fal']],
  ] as const)('%s → %s %o', (treatment, capability, ids) => {
    expect(
      planCandidates({ kind: 'shot', visualTreatment: treatment, durationSec: 3 }, 'PLUS'),
    ).toEqual({
      capability,
      providerIds: ids,
    });
  });

  it.each(['MOTION_GRAPHICS', 'USER_UPLOAD', 'TEXT_CARD', 'TRANSITION'] as const)(
    '%s has no generation provider',
    (treatment) => {
      expect(() =>
        planCandidates({ kind: 'shot', visualTreatment: treatment, durationSec: 2 }, 'PLUS'),
      ).toThrow(ValidationError);
    },
  );

  it.each([
    ['text_generation', ['anthropic', 'openai']],
    ['tts', ['elevenlabs', 'azure-speech']],
    ['music', ['elevenlabs-music', 'replicate', 'storyblocks']],
    ['composition', ['shotstack', 'creatomate']],
    ['content_safety', ['hive', 'sightengine']],
  ] as const)('capability %s tries %o', (capability, ids) => {
    expect(planCandidates({ kind: 'capability', capability }, 'BASIC').providerIds).toEqual(ids);
  });
});

describe('routeProvider', () => {
  it('skips unconfigured candidates and picks the first usable one', async () => {
    const runway = new StubAdapter('runway', ['text_to_video', 'image_to_video']);
    const decision = await routeProvider(aiClip('STANDARD'), deps([runway]));
    expect(decision.providerId).toBe('runway');
    expect(decision.adapter).toBe(runway);
    expect(decision.candidates).toEqual([
      { providerId: 'luma', skipped: 'not_configured' },
      { providerId: 'runway' },
    ]);
  });

  it('skips providers that lack the needed capability', async () => {
    const luma = new StubAdapter('luma', ['image_to_video']);
    const runway = new StubAdapter('runway', ['text_to_video']);
    const decision = await routeProvider(aiClip('STANDARD'), deps([luma, runway]));
    expect(decision.candidates[0]).toEqual({
      providerId: 'luma',
      skipped: 'capability_unsupported',
    });
    expect(decision.providerId).toBe('runway');
  });

  it('falls back when the first choice has an open circuit breaker', async () => {
    const luma = new StubAdapter('luma', ['text_to_video']);
    const runway = new StubAdapter('runway', ['text_to_video']);
    const d = deps([luma, runway]);
    for (let i = 0; i < 5; i += 1) d.breaker.recordFailure('luma');
    const decision = await routeProvider(aiClip('STANDARD'), d);
    expect(decision.providerId).toBe('runway');
    expect(decision.candidates[0]).toEqual({ providerId: 'luma', skipped: 'circuit_open' });
  });

  it('skips a provider disabled by the level-4 kill switch', async () => {
    const luma = new StubAdapter('luma', ['text_to_video']);
    const runway = new StubAdapter('runway', ['text_to_video']);
    const killSwitch = {
      check: vi.fn(async ({ providerId }: { providerId?: string }): Promise<KillSwitchStatus> =>
        providerId === 'luma'
          ? { killed: true, level: 'provider', key: 'studio.disabledProvider.luma' }
          : { killed: false },
      ),
    };
    const decision = await routeProvider(aiClip('STANDARD'), deps([luma, runway], { killSwitch }));
    expect(decision.candidates[0]).toEqual({ providerId: 'luma', skipped: 'provider_disabled' });
  });

  it('skips over-budget providers using the adapter cost estimate', async () => {
    const luma = new StubAdapter('luma', ['text_to_video'], { costPence: 500 });
    const runway = new StubAdapter('runway', ['text_to_video'], { costPence: 50 });
    const budget: BudgetChecker = {
      hasBudget: vi.fn(async ({ estimatedCostPence }) => estimatedCostPence < 100),
    };
    const request = {
      capability: 'text_to_video' as const,
      organisationId: 'org-1',
      prompt: 'p',
      durationSec: 8,
      aspectRatio: '9:16' as const,
    };
    const decision = await routeProvider(
      aiClip('STANDARD', { request }),
      deps([luma, runway], { budget }),
    );
    expect(decision.candidates[0]).toEqual({ providerId: 'luma', skipped: 'over_budget' });
    expect(budget.hasBudget).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'luma', estimatedCostPence: 500, projectId: 'proj-1' }),
    );
  });

  it('skips providers too slow for the deadline', async () => {
    const luma = new StubAdapter('luma', ['text_to_video'], { typicalLatencySec: 600 });
    const runway = new StubAdapter('runway', ['text_to_video'], { typicalLatencySec: 60 });
    const decision = await routeProvider(
      aiClip('STANDARD', { deadline: new Date(120_000) }),
      deps([luma, runway]),
    );
    expect(decision.candidates[0]).toEqual({ providerId: 'luma', skipped: 'too_slow' });
    expect(decision.providerId).toBe('runway');
  });

  it('raises NO_PROVIDER_AVAILABLE with every skip reason when all candidates fail', async () => {
    const runway = new StubAdapter('runway', ['text_to_video']);
    const d = deps([runway]);
    for (let i = 0; i < 5; i += 1) d.breaker.recordFailure('runway');
    const err = (await routeProvider(aiClip('STANDARD'), d).catch(
      (e: unknown) => e,
    )) as NoProviderAvailableError;
    expect(err).toBeInstanceOf(NoProviderAvailableError);
    expect(err.details).toEqual({
      capability: 'text_to_video',
      candidates: [
        { providerId: 'luma', skipped: 'not_configured' },
        { providerId: 'runway', skipped: 'circuit_open' },
        { providerId: 'kling', skipped: 'not_configured' },
      ],
    });
  });

  it('fails closed on providers that cannot estimate cost', async () => {
    const runway = new StubAdapter('runway', ['text_to_video']);
    Object.defineProperty(runway, 'estimateCostPence', { value: undefined });
    const err = (await routeProvider(aiClip('STANDARD'), deps([runway])).catch(
      (e: unknown) => e,
    )) as NoProviderAvailableError;
    expect(err.details?.candidates).toContainEqual({
      providerId: 'runway',
      skipped: 'no_cost_estimate',
    });
  });

  it('records the decision time for providerRouting snapshots', async () => {
    const anthropic = new StubAdapter('anthropic', ['text_generation']);
    const decision = await routeProvider(
      {
        need: { kind: 'capability', capability: 'text_generation' },
        planTier: 'BASIC',
        organisationId: 'o',
        request: { capability: 'text_generation', organisationId: 'o', system: 's', prompt: 'p' },
      },
      deps([anthropic], { now: () => Date.parse('2026-09-27T12:00:00Z') }),
    );
    expect(decision).toMatchObject({
      providerId: 'anthropic',
      capability: 'text_generation',
      decidedAt: '2026-09-27T12:00:00.000Z',
    });
  });
});
