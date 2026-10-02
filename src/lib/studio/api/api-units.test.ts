import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { buildIdeationPrompt } from '../pipeline/ideation';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import { createProviderRegistry } from '../providers/registry';
import { routeProvider } from '../providers/router';
import { StubAdapter } from '../providers/test-adapter';
import { toPlanTier, toStoredFormats } from '../services/catalog';
import {
  createMemoryIdempotencyStore,
  hashBody,
  idempotencyScope,
  isValidIdempotencyKey,
} from './idempotency';
import { jsonResponse, parseBody, parseQuery } from './route';

describe('catalog', () => {
  it('maps Core plan tiers case-insensitively and defaults unknown tiers to BASIC', () => {
    expect(toPlanTier('Enterprise')).toBe('ENTERPRISE');
    expect(toPlanTier(' plus ')).toBe('PLUS');
    expect(toPlanTier('platinum')).toBe('BASIC');
    expect(toPlanTier(undefined)).toBe('BASIC');
  });

  it('stores formats in the spec 7.3 shape', () => {
    expect(toStoredFormats([{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }])).toEqual(
      [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
    );
  });
});

describe('idempotency', () => {
  it('validates keys and scopes them per org, user, method and path', () => {
    expect(isValidIdempotencyKey('a1b2c3d4')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('has space here')).toBe(false);
    expect(
      idempotencyScope({ organisationId: 'o', userId: 'u', method: 'POST', path: '/p', key: 'k' }),
    ).toBe('studio:idem:o:u:POST:/p:k');
  });

  it('reserves before execution, replays completed responses, and releases on failure', async () => {
    let now = 0;
    const store = createMemoryIdempotencyStore(() => now);
    expect(await store.reserve('k', 'h1')).toEqual({ reserved: true });
    expect(await store.reserve('k', 'h1')).toEqual({
      reserved: false,
      existing: { state: 'processing', bodyHash: 'h1' },
    });
    await store.complete('k', 'h1', { status: 201, body: { ok: true } });
    expect(await store.reserve('k', 'h1')).toMatchObject({
      reserved: false,
      existing: { state: 'complete', response: { status: 201 } },
    });
    now = 24 * 60 * 60 * 1000;
    expect(await store.reserve('k', 'h1')).toEqual({ reserved: true });
    await store.release('k');
    expect(await store.reserve('k', 'h2')).toEqual({ reserved: true });
  });

  it('hashes request bodies deterministically', () => {
    expect(hashBody('{"a":1}')).toBe(hashBody('{"a":1}'));
    expect(hashBody('{"a":1}')).not.toBe(hashBody('{"a":2}'));
  });
});

describe('route helpers', () => {
  it('serialises BigInt values', async () => {
    const res = jsonResponse({ size: 10n }, { status: 201 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ size: '10' });
  });

  it('parses bodies and queries with schema errors as 400s', async () => {
    const schema = z.object({ n: z.number() });
    await expect(
      parseBody(new Request('http://x', { method: 'POST', body: '{"n":1}' }), schema),
    ).resolves.toEqual({ n: 1 });
    await expect(
      parseBody(new Request('http://x', { method: 'POST', body: '' }), z.object({})),
    ).resolves.toEqual({});
    await expect(
      parseBody(new Request('http://x', { method: 'POST', body: '{"n":"x"}' }), schema),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      parseQuery(new Request('http://x?limit=5'), z.object({ limit: z.coerce.number() })),
    ).toEqual({ limit: 5 });
    expect(() =>
      parseQuery(new Request('http://x?limit=a'), z.object({ limit: z.coerce.number() })),
    ).toThrow(ValidationError);
  });
});

describe('preferred provider routing (shot regenerate)', () => {
  const deps = (adapters: StubAdapter[]) => ({
    registry: createProviderRegistry(adapters),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: { check: async () => ({ killed: false as const }) },
    budget: { hasBudget: async () => true },
  });
  const request = {
    capability: 'text_to_video' as const,
    organisationId: 'o',
    prompt: 'p',
    durationSec: 5,
    aspectRatio: '9:16' as const,
  };
  const need = { kind: 'shot' as const, visualTreatment: 'AI_CLIP' as const, durationSec: 5 };

  it('moves an eligible preferred provider to the front', async () => {
    const adapters = [
      new StubAdapter('luma', ['text_to_video']),
      new StubAdapter('runway', ['text_to_video']),
    ];
    const decision = await routeProvider(
      { need, planTier: 'STANDARD', organisationId: 'o', request, preferredProviderId: 'runway' },
      deps(adapters),
    );
    expect(decision.providerId).toBe('runway');
  });

  it('never adds a provider outside the tier candidate list', async () => {
    const adapters = [
      new StubAdapter('luma', ['text_to_video']),
      new StubAdapter('pika', ['text_to_video']),
    ];
    const decision = await routeProvider(
      { need, planTier: 'STANDARD', organisationId: 'o', request, preferredProviderId: 'pika' },
      deps(adapters),
    );
    expect(decision.providerId).toBe('luma');
    expect(decision.candidates.map((c) => c.providerId)).not.toContain('pika');
  });
});

describe('ideation hints', () => {
  it('includes the owner audience and CTA when provided', () => {
    const prompt = buildIdeationPrompt({
      rawInput: 'x',
      targetPlatforms: ['tiktok'],
      hints: { targetAudience: 'UK creators', callToAction: 'Comment GUIDE' },
    });
    expect(prompt).toContain("Owner's intended audience: UK creators");
    expect(prompt).toContain("Owner's call to action: Comment GUIDE");
  });
});
