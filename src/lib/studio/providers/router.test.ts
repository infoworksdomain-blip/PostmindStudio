import { describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import { HeyGenAdapter } from './heygen';
import { LumaAdapter } from './luma';
import { RunwayAdapter } from './runway';
import { VeoAdapter } from './veo';
import { KlingAdapter } from './kling';
import { createProviderRegistry } from './registry';
import { planCandidates, routeProvider, type BudgetChecker, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';
import type { ProviderAdapter } from './interface';

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
    ['STANDARD', ['kling', 'veo', 'runway', 'luma']],
    ['PLUS', ['kling', 'veo', 'runway', 'luma']],
    ['ENTERPRISE', ['kling', 'veo', 'runway', 'luma']],
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
    ['STOCK_FOOTAGE', 'stock_footage', ['storyblocks-video', 'pexels-video']],
    ['IMAGE_STILL', 'text_to_image', ['openai', 'fal', 'ideogram']],
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
    ['music', ['elevenlabs-music', 'storyblocks-music', 'replicate']],
    ['transcription', ['assemblyai', 'openai']],
    ['composition', ['shotstack', 'creatomate']],
    ['content_safety', []],
  ] as const)('capability %s tries %o', (capability, ids) => {
    expect(planCandidates({ kind: 'capability', capability }, 'BASIC').providerIds).toEqual(ids);
  });
});

describe('routeProvider', () => {
  it('skips unconfigured candidates and picks the first usable one', async () => {
    const veo = new StubAdapter('veo', ['text_to_video', 'image_to_video']);
    const decision = await routeProvider(aiClip('STANDARD'), deps([veo]));
    expect(decision.providerId).toBe('veo');
    expect(decision.adapter).toBe(veo);
    expect(decision.candidates).toEqual([
      { providerId: 'kling', skipped: 'not_configured' },
      { providerId: 'veo' },
    ]);
  });

  it('skips providers that lack the needed capability', async () => {
    const kling = new StubAdapter('kling', ['image_to_video']);
    const veo = new StubAdapter('veo', ['text_to_video']);
    const decision = await routeProvider(aiClip('STANDARD'), deps([kling, veo]));
    expect(decision.candidates[0]).toEqual({
      providerId: 'kling',
      skipped: 'capability_unsupported',
    });
    expect(decision.providerId).toBe('veo');
  });

  it('falls back when the first choice has an open circuit breaker', async () => {
    const kling = new StubAdapter('kling', ['text_to_video']);
    const veo = new StubAdapter('veo', ['text_to_video']);
    const d = deps([kling, veo]);
    for (let i = 0; i < 5; i += 1) d.breaker.recordFailure('kling');
    const decision = await routeProvider(aiClip('STANDARD'), d);
    expect(decision.providerId).toBe('veo');
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'circuit_open' });
  });

  it('skips a provider disabled by the level-4 kill switch', async () => {
    const kling = new StubAdapter('kling', ['text_to_video']);
    const veo = new StubAdapter('veo', ['text_to_video']);
    const killSwitch = {
      check: vi.fn(async ({ providerId }: { providerId?: string }): Promise<KillSwitchStatus> =>
        providerId === 'kling'
          ? { killed: true, level: 'provider', key: 'studio.disabledProvider.kling' }
          : { killed: false },
      ),
    };
    const decision = await routeProvider(aiClip('STANDARD'), deps([kling, veo], { killSwitch }));
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'provider_disabled' });
  });

  it('skips over-budget providers using the adapter cost estimate', async () => {
    const kling = new StubAdapter('kling', ['text_to_video'], { costPence: 500 });
    const veo = new StubAdapter('veo', ['text_to_video'], { costPence: 50 });
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
      deps([kling, veo], { budget }),
    );
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'over_budget' });
    expect(budget.hasBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'kling',
        estimatedCostPence: 500,
        projectId: 'proj-1',
      }),
    );
  });

  it('skips providers too slow for the deadline', async () => {
    const kling = new StubAdapter('kling', ['text_to_video'], { typicalLatencySec: 600 });
    const veo = new StubAdapter('veo', ['text_to_video'], { typicalLatencySec: 60 });
    const decision = await routeProvider(
      aiClip('STANDARD', { deadline: new Date(120_000) }),
      deps([kling, veo]),
    );
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'too_slow' });
    expect(decision.providerId).toBe('veo');
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
        { providerId: 'kling', skipped: 'not_configured' },
        { providerId: 'veo', skipped: 'not_configured' },
        { providerId: 'runway', skipped: 'circuit_open' },
        { providerId: 'luma', skipped: 'not_configured' },
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

// BACKLOG 13.32 — real Luma / HeyGen adapters behind the router (no network: routing only uses
// capabilities, cost estimates and latency).
describe('Luma and HeyGen fallbacks', () => {
  const noFetch = (() => {
    throw new Error('routing must not call the provider');
  }) as unknown as typeof fetch;
  const runway = () => new RunwayAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: noFetch });
  const luma = () => new LumaAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: noFetch });
  const heygen = () =>
    new HeyGenAdapter({
      apiKey: 'k',
      defaultAvatarId: 'look',
      usdToGbpRate: 0.75,
      fetchImpl: noFetch,
    });
  const real = (adapters: ProviderAdapter[]) => ({
    ...deps([]),
    registry: createProviderRegistry(adapters),
  });
  const openBreaker = async (d: ReturnType<typeof real>, id: string) => {
    for (let i = 0; i < 5; i += 1) await d.breaker.recordFailure(id);
  };

  it.each(['PLUS', 'ENTERPRISE'] as const)(
    '%s: Runway breaker open → Luma takes the clip',
    async (tier) => {
      const d = real([runway(), luma()]);
      await openBreaker(d, 'runway');
      const decision = await routeProvider(aiClip(tier), d);
      expect(decision.providerId).toBe('luma');
      expect(decision.candidates).toEqual([
        { providerId: 'kling', skipped: 'not_configured' },
        { providerId: 'veo', skipped: 'not_configured' },
        { providerId: 'runway', skipped: 'circuit_open' },
        { providerId: 'luma' },
      ]);
    },
  );

  it('PLUS: Runway healthy stays first; Luma is only the fallback', async () => {
    const decision = await routeProvider(aiClip('PLUS'), real([runway(), luma()]));
    expect(decision.providerId).toBe('runway');
  });

  it('STANDARD: a shot regenerated on Runway falls back to Luma when Runway is broken', async () => {
    const d = real([runway(), luma()]);
    await openBreaker(d, 'runway');
    const decision = await routeProvider(aiClip('STANDARD', { preferredProviderId: 'runway' }), d);
    expect(decision.providerId).toBe('luma');
    expect(decision.candidates[0]).toEqual({ providerId: 'runway', skipped: 'circuit_open' });
  });

  it('playbook rehearsal: Runway disabled by the kill switch → Luma', async () => {
    const d = {
      ...real([runway(), luma()]),
      killSwitch: {
        check: vi.fn(async ({ providerId }: { providerId?: string }): Promise<KillSwitchStatus> =>
          providerId === 'runway'
            ? { killed: true, level: 'provider', key: 'studio.disabledProvider.runway' }
            : { killed: false },
        ),
      },
    };
    const decision = await routeProvider(aiClip('PLUS'), d);
    expect(decision.providerId).toBe('luma');
    expect(decision.candidates).toContainEqual({
      providerId: 'runway',
      skipped: 'provider_disabled',
    });
  });

  it('routes image-to-video clips to Luma too', async () => {
    const d = real([runway(), luma()]);
    await openBreaker(d, 'runway');
    const decision = await routeProvider(
      aiClip('PLUS', {
        need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 8, hasSourceImage: true },
        request: {
          capability: 'image_to_video',
          organisationId: 'org-1',
          prompt: 'p',
          imageUrl: 'https://cdn.example/f.png',
          durationSec: 8,
          aspectRatio: '9:16',
        },
      }),
      d,
    );
    expect(decision).toMatchObject({ providerId: 'luma', capability: 'image_to_video' });
  });

  it('no provider left when both Runway and Luma are broken', async () => {
    const d = real([runway(), luma()]);
    await openBreaker(d, 'runway');
    await openBreaker(d, 'luma');
    await expect(routeProvider(aiClip('PLUS'), d)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it.each([
    ['STANDARD', [{ providerId: 'd-id', skipped: 'not_configured' }, { providerId: 'heygen' }]],
    ['PLUS', [{ providerId: 'heygen' }]],
  ] as const)('AI_AVATAR on %s is served by HeyGen', async (tier, candidates) => {
    const decision = await routeProvider(
      {
        need: { kind: 'shot', visualTreatment: 'AI_AVATAR', durationSec: 6 },
        planTier: tier,
        organisationId: 'org-1',
        request: {
          capability: 'avatar_video',
          organisationId: 'org-1',
          audioUrl: 'https://assets.example/v.mp3',
          durationSec: 6,
          aspectRatio: '9:16',
        },
      },
      real([heygen()]),
    );
    expect(decision.providerId).toBe('heygen');
    expect(decision.candidates).toEqual(candidates);
  });
});

// BACKLOG 20.24 — operator-approved AI_CLIP order on every paid tier: Kling 3.0 → Veo 3.1 →
// Runway → Luma (Seedance goes in front once its PR lands). Veo renders at most 8 s and Kling
// 3–15 s, so long shots skip Veo; any account, breaker or kill-switch problem moves on.
describe('AI_CLIP order kling → veo → runway → luma (20.24)', () => {
  const noFetch = (() => {
    throw new Error('routing must not call the provider');
  }) as unknown as typeof fetch;
  const runway = () => new RunwayAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: noFetch });
  const luma = () => new LumaAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: noFetch });
  const veo = () => new VeoAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: noFetch });
  const kling = () =>
    new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: 'k' },
      usdToGbpRate: 0.75,
      fetchImpl: noFetch,
    });
  const all = () => [kling(), veo(), runway(), luma()];
  const real = (adapters: ProviderAdapter[]) => ({
    ...deps([]),
    registry: createProviderRegistry(adapters),
  });
  const openBreaker = async (d: ReturnType<typeof real>, id: string) => {
    for (let i = 0; i < 5; i += 1) await d.breaker.recordFailure(id);
  };
  const killOnly = (ids: string[]) => ({
    check: vi.fn(async ({ providerId }: { providerId?: string }): Promise<KillSwitchStatus> =>
      providerId && ids.includes(providerId)
        ? { killed: true, level: 'provider', key: `studio.disabledProvider.${providerId}` }
        : { killed: false },
    ),
  });
  const shot = (durationSec: number): RouteInput =>
    aiClip('PLUS', {
      need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec },
      request: {
        capability: 'text_to_video',
        organisationId: 'org-1',
        prompt: 'p',
        durationSec,
        aspectRatio: '9:16',
      },
    });

  it.each(['STANDARD', 'PLUS', 'ENTERPRISE'] as const)(
    '%s: everything healthy → Kling takes the clip',
    async (tier) => {
      const decision = await routeProvider(aiClip(tier), real(all()));
      expect(decision.providerId).toBe('kling');
      expect(decision.candidates).toEqual([{ providerId: 'kling' }]);
    },
  );

  it.each(['STANDARD', 'PLUS', 'ENTERPRISE'] as const)(
    '%s: Kling open → Veo; Kling and Veo open → Runway; then Luma',
    async (tier) => {
      const d = real(all());
      await openBreaker(d, 'kling');
      expect((await routeProvider(aiClip(tier), d)).providerId).toBe('veo');
      await openBreaker(d, 'veo');
      expect((await routeProvider(aiClip(tier), d)).providerId).toBe('runway');
      await openBreaker(d, 'runway');
      const decision = await routeProvider(aiClip(tier), d);
      expect(decision.providerId).toBe('luma');
      expect(decision.candidates).toEqual([
        { providerId: 'kling', skipped: 'circuit_open' },
        { providerId: 'veo', skipped: 'circuit_open' },
        { providerId: 'runway', skipped: 'circuit_open' },
        { providerId: 'luma' },
      ]);
    },
  );

  it('a Kling account problem (20.11 exclusion) fails over to Veo at once', async () => {
    const decision = await routeProvider(
      aiClip('STANDARD', { excludeProviderIds: ['kling'] }),
      real(all()),
    );
    expect(decision.providerId).toBe('veo');
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'account_unavailable' });
  });

  it('the Kling kill switch keeps it out of routing', async () => {
    const d = { ...real(all()), killSwitch: killOnly(['kling']) };
    const decision = await routeProvider(aiClip('PLUS'), d);
    expect(decision.providerId).toBe('veo');
    expect(decision.candidates[0]).toEqual({ providerId: 'kling', skipped: 'provider_disabled' });
  });

  it('Kling killed and Veo not configured → Runway', async () => {
    const d = { ...real([kling(), runway(), luma()]), killSwitch: killOnly(['kling']) };
    const decision = await routeProvider(aiClip('PLUS'), d);
    expect(decision.providerId).toBe('runway');
    expect(decision.candidates).toEqual([
      { providerId: 'kling', skipped: 'provider_disabled' },
      { providerId: 'veo', skipped: 'not_configured' },
      { providerId: 'runway' },
    ]);
  });

  it('a 10 s shot with Kling down skips Veo (8 s maximum) and goes to Runway', async () => {
    const d = real(all());
    await openBreaker(d, 'kling');
    const decision = await routeProvider(shot(10), d);
    expect(decision.providerId).toBe('runway');
    expect(decision.candidates).toEqual([
      { providerId: 'kling', skipped: 'circuit_open' },
      { providerId: 'veo', skipped: 'capability_unsupported' },
      { providerId: 'runway' },
    ]);
  });

  it('a 15 s shot is still for Kling; a 16 s shot is not', async () => {
    expect((await routeProvider(shot(15), real([kling()]))).providerId).toBe('kling');
    const err = await routeProvider(shot(16), real([kling()])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderAvailableError);
    expect((err as NoProviderAvailableError).details?.candidates).toContainEqual({
      providerId: 'kling',
      skipped: 'capability_unsupported',
    });
  });

  it('the Veo kill switch keeps it out of failover', async () => {
    const d = { ...real([kling(), veo()]), killSwitch: killOnly(['veo']) };
    await openBreaker(d, 'kling');
    await expect(routeProvider(aiClip('PLUS'), d)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('a source frame routes Kling (and Veo behind it) as image_to_video', async () => {
    const input = aiClip('PLUS', {
      need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 6, hasSourceImage: true },
      request: {
        capability: 'image_to_video',
        organisationId: 'org-1',
        prompt: 'p',
        imageUrl: 'https://cdn.example/f.png',
        durationSec: 6,
        aspectRatio: '9:16',
      },
    });
    expect(await routeProvider(input, real(all()))).toMatchObject({
      providerId: 'kling',
      capability: 'image_to_video',
    });
    const d = real(all());
    await openBreaker(d, 'kling');
    expect(await routeProvider(input, d)).toMatchObject({
      providerId: 'veo',
      capability: 'image_to_video',
    });
  });
});
