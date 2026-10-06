import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ProviderError, RateDeferredError } from '../../errors';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import type { PipelineDeps } from '../pipeline/deps';
import type { ProviderRunResult } from '../pipeline/provider-run';
import {
  ACTOR_PORTRAIT_ROLE,
  actorImageOf,
  actorPortraitPrompt,
  type ActorImageState,
  ensureActorPortrait,
  nextPortraitStep,
  PORTRAIT_CLAIM_STALE_MS,
  PORTRAIT_DEFER_ID,
  type PortraitStore,
} from './portrait';
import { checkRealPersonRequest } from './real-person';
import { actorDescription, newUgcStyle } from './style';

// BACKLOG 21.4a — the project's one actor portrait: made once (under a claim, so parallel actor
// shots never make two), reused by every clip and every regenerated clip, never of a real person,
// and its absence never stops the video. Provider calls are mocked; no real API is called.

const runProvider = vi.hoisted(() => vi.fn());
vi.mock('../pipeline/provider-run', async (original) => ({
  ...(await original<typeof import('../pipeline/provider-run')>()),
  runProvider,
}));

const style = newUgcStyle(
  {
    product: { name: 'Taylor Swift tour mug', imageId: 'img-1' },
    actor: { ageRange: '25-34', gender: 'woman', setting: 'desk' },
  },
  42,
);
const description = actorDescription(style);
const NOW = 1_800_000_000_000;

/** metadata.ugc.actorImage in memory, with the same compare-and-set rule as the SQL. */
function memoryStore(initial: ActorImageState | null = null) {
  let value: Prisma.JsonValue | null = initial;
  const writes: Array<ActorImageState | null> = [];
  const store: PortraitStore = {
    read: vi.fn(async () => {
      const raw = value === null ? null : (JSON.parse(JSON.stringify(value)) as Prisma.JsonValue);
      return actorImageOf({ ugc: { actorImage: raw } } as Prisma.JsonObject);
    }),
    compareAndSet: vi.fn(async (_id, expected, next) => {
      if (JSON.stringify(expected) !== JSON.stringify(value)) return false;
      value = next;
      writes.push(next);
      return true;
    }),
  };
  return { store, writes, current: () => value };
}

function deps(overrides: { assetExists?: boolean } = {}) {
  const { storage, objects } = memoryStorage();
  const created: Array<Record<string, unknown>> = [];
  const d = {
    db: {
      videoAsset: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          overrides.assetExists === false && !created.some((c) => c.id === where.id)
            ? null
            : { id: where.id, s3Bucket: 'assets', s3Key: `orgs/org-1/${where.id}.png` },
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, id: `asset-${created.length + 1}` };
          created.push(row);
          return { id: row.id };
        }),
      },
      providerJob: { findUnique: vi.fn(async () => ({ costPence: 6 })) },
    },
    storage: {
      ...storage,
      signedUrl: vi.fn(
        async (bucket: string, key: string) => `https://signed.test/${bucket}/${key}`,
      ),
    },
    config: { assetsBucket: 'assets' },
    fetch: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
  } as unknown as PipelineDeps;
  return { d, created, objects };
}

function imageRun(metadata: Record<string, unknown>, url?: string): ProviderRunResult {
  return {
    decision: { providerId: 'openai', candidates: [], decidedAt: new Date(NOW) },
    providerJobRowId: 'job-1',
    output: { ...(url && { url }), metadata },
  } as unknown as ProviderRunResult;
}

const input = (store: PortraitStore, runId = 'run-1') => ({
  projectId: 'p1',
  organisationId: 'org-1',
  runId,
  planTier: 'STANDARD' as const,
  style,
  shotId: 's1',
  store,
});

beforeEach(() => runProvider.mockReset());

describe('actor portrait prompt (21.4a)', () => {
  it('is built from the stored presets only: fictional person, head and shoulders, no product, no text', () => {
    const prompt = actorPortraitPrompt(style);
    expect(prompt).toContain(`a fictional person who does not exist: ${description}`);
    expect(prompt).toContain('a tidy home-office desk by a window');
    expect(prompt).toContain('Head and shoulders, facing the camera');
    expect(prompt).toContain('not anyone famous and not any real, identifiable person');
    expect(prompt).toContain('Nothing in their hands. No text');
    // Owner text (here a product naming a celebrity) never reaches the portrait.
    expect(prompt).not.toContain('Taylor');
    expect(checkRealPersonRequest(prompt).refused).toBe(false);
  });
});

describe('nextPortraitStep', () => {
  const at = { description, runId: 'run-1', now: NOW };
  it.each<[string, ActorImageState | null, string]>([
    ['nothing stored', null, 'claim'],
    ['ready', { state: 'ready', description, assetId: 'a1' }, 'use'],
    [
      'ready for an older look',
      { state: 'ready', description: 'someone else', assetId: 'a1' },
      'claim',
    ],
    [
      'being made now',
      { state: 'generating', description, claimedAt: NOW - 1_000, claimId: 'c' },
      'wait',
    ],
    [
      'a stale claim (crashed worker)',
      { state: 'generating', description, claimedAt: NOW - PORTRAIT_CLAIM_STALE_MS, claimId: 'c' },
      'claim',
    ],
    [
      'unavailable this run',
      { state: 'unavailable', description, runId: 'run-1', reason: 'x' },
      'none',
    ],
    [
      'unavailable last run',
      { state: 'unavailable', description, runId: 'run-0', reason: 'x' },
      'claim',
    ],
  ])('%s', (_label, state, kind) => {
    expect(nextPortraitStep(state, at).kind).toBe(kind);
  });

  it('ignores a malformed stored value (treated as nothing stored)', () => {
    expect(actorImageOf({ ugc: { actorImage: { state: 'ready' } } }).state).toBeNull();
    expect(actorImageOf(null)).toEqual({ raw: null, state: null });
  });
});

describe('ensureActorPortrait (21.4a)', () => {
  it('the first shot generates it once through the IMAGE_STILL route, records cost, marks it ready', async () => {
    const { store, current } = memoryStore();
    const { d, created } = deps();
    runProvider.mockResolvedValue(
      imageRun({ s3Bucket: 'assets', s3Key: 'orgs/org-1/p1/openai-1.png', model: 'gpt-image-2' }),
    );
    const portrait = await ensureActorPortrait(d, input(store));
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(runProvider.mock.calls[0]?.[0]).toEqual({
      need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: 5 },
      planTier: 'STANDARD',
      request: {
        capability: 'text_to_image',
        organisationId: 'org-1',
        projectId: 'p1',
        prompt: actorPortraitPrompt(style),
        aspectRatio: '9:16',
      },
    });
    expect(created[0]).toMatchObject({
      organisationId: 'org-1',
      projectId: 'p1',
      shotId: null,
      kind: 'IMAGE',
      source: 'openai:gpt-image-2',
      providerJobId: 'job-1',
      costPence: 6,
      metadata: { role: ACTOR_PORTRAIT_ROLE, description, prompt: actorPortraitPrompt(style) },
    });
    expect(current()).toEqual({ state: 'ready', description, assetId: 'asset-1' });
    expect(portrait).toEqual({
      assetId: 'asset-1',
      url: 'https://signed.test/assets/orgs/org-1/asset-1.png',
    });
  });

  it('every later clip (and a regenerated clip) reuses the stored portrait without a new image', async () => {
    const { store } = memoryStore({ state: 'ready', description, assetId: 'a9' });
    const { d } = deps();
    const first = await ensureActorPortrait(d, input(store));
    const regenerated = await ensureActorPortrait(d, input(store, 'run-2'));
    expect(runProvider).not.toHaveBeenCalled();
    expect(first).toEqual(regenerated);
    expect(first?.assetId).toBe('a9');
  });

  it('a shot that finds the portrait being made waits (deferred, no attempt used)', async () => {
    const { store } = memoryStore({
      state: 'generating',
      description,
      claimedAt: NOW - 2_000,
      claimId: 'other',
    });
    const err = await ensureActorPortrait(deps().d, input(store)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateDeferredError);
    expect(err).toMatchObject({ providerId: PORTRAIT_DEFER_ID });
    expect(runProvider).not.toHaveBeenCalled();
  });

  it('a stale claim is taken over and the portrait made', async () => {
    const { store, current } = memoryStore({
      state: 'generating',
      description,
      claimedAt: NOW - PORTRAIT_CLAIM_STALE_MS - 1,
      claimId: 'dead',
    });
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'k.png' }));
    await ensureActorPortrait(deps().d, input(store));
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(current()).toMatchObject({ state: 'ready' });
  });

  it('losing the claim race to another shot means waiting, not a second image', async () => {
    const mem = memoryStore();
    const other: ActorImageState = {
      state: 'generating',
      description,
      claimedAt: NOW,
      claimId: 'other-shot',
    };
    // Another shot claims between our read and our compare-and-set.
    let first = true;
    const racing: PortraitStore = {
      read: mem.store.read,
      compareAndSet: async (id, expected, next) => {
        if (first) {
          first = false;
          await mem.store.compareAndSet(id, null, other);
        }
        return mem.store.compareAndSet(id, expected, next);
      },
    };
    await expect(ensureActorPortrait(deps().d, input(racing))).rejects.toBeInstanceOf(
      RateDeferredError,
    );
    expect(runProvider).not.toHaveBeenCalled();
  });

  it('a new actor look (another description) makes a new portrait', async () => {
    const { store } = memoryStore({ state: 'ready', description: 'old look', assetId: 'old' });
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'new.png' }));
    const portrait = await ensureActorPortrait(deps().d, input(store));
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(portrait?.assetId).toBe('asset-1');
  });

  it('a deleted portrait asset is made again', async () => {
    const { store } = memoryStore({ state: 'ready', description, assetId: 'gone' });
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'again.png' }));
    const portrait = await ensureActorPortrait(deps({ assetExists: false }).d, input(store));
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(portrait?.assetId).toBe('asset-1');
  });

  it.each([
    [
      'a refusal',
      new ProviderError('openai', 'content_policy', 'moderation_blocked', false),
      'content_policy',
    ],
    ['no image provider', new NoProviderAvailableError('none'), 'not_configured'],
    [
      'an account problem',
      new ProviderError('openai', 'insufficient_credits', 'no credit', false),
      'insufficient_credits',
    ],
  ])('%s: the run goes on without a portrait, asked once per run', async (_l, error, reason) => {
    const { store, current } = memoryStore();
    runProvider.mockRejectedValue(error);
    const { d } = deps();
    expect(await ensureActorPortrait(d, input(store))).toBeNull();
    expect(current()).toEqual({ state: 'unavailable', description, runId: 'run-1', reason });
    // The other clips of the run do not ask again…
    expect(await ensureActorPortrait(d, input(store))).toBeNull();
    expect(runProvider).toHaveBeenCalledTimes(1);
    // …a later run does.
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'later.png' }));
    expect(await ensureActorPortrait(d, input(store, 'run-2'))).not.toBeNull();
  });

  it('a transient failure frees the claim and rethrows, so the retried job makes it', async () => {
    const { store, current } = memoryStore();
    const transient = new ProviderError('openai', 'provider_unavailable', '503', true);
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'k.png' }));
    const { d } = deps();
    let thrown = false;
    d.db.videoAsset.create = (() => {
      thrown = true;
      return Promise.reject(transient);
    }) as unknown as typeof d.db.videoAsset.create;
    const err = await ensureActorPortrait(d, input(store)).catch((e: unknown) => e);
    expect(thrown).toBe(true);
    expect(err === transient).toBe(true);
    expect(current()).toBeNull();
  });

  it('copies a provider URL into the assets bucket; a non-PNG/JPEG image is not used (Veo takes PNG/JPEG)', async () => {
    const { store, current } = memoryStore();
    const { d, objects } = deps();
    (d.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } }),
    );
    runProvider.mockResolvedValue(imageRun({ model: 'flux' }, 'https://fal.test/out.webp'));
    expect(await ensureActorPortrait(d, input(store))).toBeNull();
    expect(objects.size).toBe(1);
    expect(current()).toMatchObject({ state: 'unavailable', reason: 'unsupported_image_type' });
  });
});

describe('ensureActorPortrait with a reusable creator (22.3)', () => {
  const creator = {
    id: 'cr-1',
    portraitId: 'crp-1',
    description: 'a woman around thirty, short curly hair',
    voiceTone: 'warm',
    ageRange: '25-34' as const,
    gender: 'woman' as const,
    setting: 'kitchen' as const,
  };
  const withCreator = newUgcStyle({}, 42, creator);

  function creatorDeps(found: boolean) {
    const { d } = deps();
    const findFirst = vi.fn(async () =>
      found ? { id: 'crp-1', s3Bucket: 'assets', s3Key: 'orgs/org-1/creators/cr-1/a.png' } : null,
    );
    (d.db as unknown as Record<string, unknown>).creatorPortrait = { findFirst };
    return { d, findFirst };
  }

  it('uses the pinned creator portrait for every clip and every regenerated clip: nothing is generated', async () => {
    const { store } = memoryStore();
    const { d, findFirst } = creatorDeps(true);
    const clip = await ensureActorPortrait(d, { ...input(store), style: withCreator });
    const again = await ensureActorPortrait(d, { ...input(store, 'run-2'), style: withCreator });
    expect(runProvider).not.toHaveBeenCalled();
    expect(clip).toEqual({
      assetId: 'crp-1',
      url: 'https://signed.test/assets/orgs/org-1/creators/cr-1/a.png',
      creatorId: 'cr-1',
    });
    expect(again).toEqual(clip);
    // Scoped by organisation, creator and the pinned portrait (a retired creator still works).
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'crp-1', organisationId: 'org-1', creatorId: 'cr-1' },
      }),
    );
    expect(store.compareAndSet).not.toHaveBeenCalled();
  });

  it('describes the creator in clip prompts (look text and voice note), never the seed’s look', () => {
    expect(actorDescription(withCreator)).toBe(
      'a woman around thirty, short curly hair, speaking in a warm way',
    );
    expect(withCreator.actor).toEqual({ ageRange: '25-34', gender: 'woman', setting: 'kitchen' });
  });

  it('a creator portrait that is gone falls back to a one-off portrait of the same description', async () => {
    const { store } = memoryStore();
    const { d } = creatorDeps(false);
    runProvider.mockResolvedValue(imageRun({ s3Bucket: 'assets', s3Key: 'fallback.png' }));
    const portrait = await ensureActorPortrait(d, { ...input(store), style: withCreator });
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(portrait?.creatorId).toBeUndefined();
  });

  it('a stored "creator" actor image reads back and only ever means "claim" in the state machine', () => {
    const state: ActorImageState = {
      state: 'creator',
      description,
      creatorId: 'cr-1',
      portraitId: 'crp-1',
    };
    expect(actorImageOf({ ugc: { actorImage: state } }).state).toEqual(state);
    expect(nextPortraitStep(state, { description, runId: 'r', now: NOW }).kind).toBe('claim');
  });
});
