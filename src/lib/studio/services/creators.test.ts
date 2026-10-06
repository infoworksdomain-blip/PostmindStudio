import type { Creator, PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, RateLimitError, ValidationError } from '../../errors';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { withDefaultCreator } from './content-plan-run';
import {
  createCreator,
  defaultCreatorId,
  MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY,
  MAX_CREATORS_PER_BUSINESS,
  regenerateCreator,
  resolveProjectCreator,
  type CreatorDeps,
} from './creators';

// BACKLOG 22.3 — the creators service without a database: the checks that run before anything
// is generated (real-person refusal, the per-business cap, the per-day portrait cap), retired
// creators, which creators a project may use, and the month-plan default. The DB-backed path is
// test/api/creators.test.ts.

// The image generation itself (ugc/creator-portrait.ts → runProvider) is mocked at the router.
const portraitMock = vi.hoisted(() => vi.fn());
vi.mock('../pipeline/provider-run', async (original) => ({
  ...(await original<typeof import('../pipeline/provider-run')>()),
  runProvider: portraitMock,
}));

const tenant = {
  organisationId: 'org-1',
  userId: 'user-1',
  organisation: { id: 'org-1', planTier: 'STANDARD' },
};
const input = {
  name: 'Maya',
  gender: 'woman',
  ageRange: '25-34',
  setting: 'kitchen',
} as const;

function row(over: Partial<Creator> = {}): Creator {
  return {
    id: 'cr-1',
    organisationId: 'org-1',
    businessId: 'biz-1',
    name: 'Maya',
    gender: 'woman',
    ageRange: '25-34',
    setting: 'kitchen',
    appearance: null,
    voiceTone: null,
    description: 'a woman around thirty',
    status: 'READY',
    portraitId: 'crp-1',
    isDefault: false,
    useCount: 0,
    lastUsedAt: null,
    portraitError: null,
    createdByUserId: 'user-1',
    retiredAt: null,
    retiredByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function fakeDeps(counts: { live?: number; today?: number; found?: Creator | null } = {}) {
  const db = {
    creator: {
      count: vi.fn(async () => counts.live ?? 0),
      create: vi.fn(async ({ data }: { data: Partial<Creator> }) =>
        row({ ...data, status: 'DRAFT' }),
      ),
      findFirst: vi.fn(async () => (counts.found === undefined ? row() : counts.found)),
      update: vi.fn(async ({ data }: { data: Partial<Creator> }) => row(data)),
    },
    creatorPortrait: { count: vi.fn(async () => counts.today ?? 0) },
  };
  const deps: CreatorDeps = {
    db: db as unknown as PrismaClient,
    storage: memoryStorage().storage,
    bucket: 'assets',
    providers: {} as ProviderRunDeps,
    now: () => 1_800_000_000_000,
  };
  return { deps, db };
}

beforeEach(() => portraitMock.mockReset());

describe('creating and regenerating (22.3)', () => {
  it('refuses a real-person request before counting, creating or generating anything', async () => {
    const { deps, db } = fakeDeps();
    for (const bad of [
      { ...input, appearance: 'a Taylor Swift look-alike' },
      { ...input, voiceTone: 'sounds like David Attenborough' },
      { ...input, name: 'Celebrity twin' },
      // A creator's look notes describe the person themself: no "a person who" is needed.
      { ...input, appearance: 'looks like Taylor Swift' },
      { ...input, appearance: 'make her resemble Zendaya Coleman' },
    ]) {
      await expect(createCreator(deps, tenant, 'biz-1', bad)).rejects.toMatchObject({
        details: { reason: 'ugc_real_person_refused' },
      });
    }
    expect(db.creator.count).not.toHaveBeenCalled();
    expect(db.creator.create).not.toHaveBeenCalled();
    expect(portraitMock).not.toHaveBeenCalled();
  });

  it(`allows at most ${MAX_CREATORS_PER_BUSINESS} live creators per business`, async () => {
    const { deps, db } = fakeDeps({ live: MAX_CREATORS_PER_BUSINESS });
    await expect(createCreator(deps, tenant, 'biz-1', input)).rejects.toBeInstanceOf(ConflictError);
    expect(db.creator.count).toHaveBeenCalledWith({
      where: { organisationId: 'org-1', businessId: 'biz-1', status: { not: 'RETIRED' } },
    });
    expect(portraitMock).not.toHaveBeenCalled();
  });

  it(`caps generated portraits at ${MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY} per organisation per day`, async () => {
    const { deps } = fakeDeps({ today: MAX_CREATOR_PORTRAITS_PER_ORG_PER_DAY });
    await expect(createCreator(deps, tenant, 'biz-1', input)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await expect(regenerateCreator(deps, tenant, 'biz-1', 'cr-1', {})).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(portraitMock).not.toHaveBeenCalled();
  });

  it('a retired creator cannot be regenerated', async () => {
    const { deps } = fakeDeps({ found: row({ status: 'RETIRED' }) });
    await expect(regenerateCreator(deps, tenant, 'biz-1', 'cr-1', {})).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('using creators in projects and month plans (22.3)', () => {
  const scope = { organisationId: 'org-1', businessId: 'biz-1' };

  it('a project may only use a READY creator with a portrait, of the same business', async () => {
    for (const found of [
      null,
      row({ status: 'DRAFT' }),
      row({ status: 'RETIRED' }),
      row({ portraitId: null }),
    ]) {
      const { db } = fakeDeps({ found });
      await expect(
        resolveProjectCreator(db as unknown as PrismaClient, scope, 'cr-1'),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    const { db } = fakeDeps();
    await expect(
      resolveProjectCreator(db as unknown as PrismaClient, scope, 'cr-1'),
    ).resolves.toEqual({
      id: 'cr-1',
      portraitId: 'crp-1',
      description: 'a woman around thirty',
      voiceTone: null,
      gender: 'woman',
      ageRange: '25-34',
      setting: 'kitchen',
    });
    expect(db.creator.findFirst).toHaveBeenCalledWith({ where: { id: 'cr-1', ...scope } });
  });

  it('month-plan UGC items get the business default (else most used) creator; others are unchanged', async () => {
    const { db } = fakeDeps();
    const asDb = db as unknown as PrismaClient;
    expect(await defaultCreatorId(asDb, scope)).toBe('cr-1');
    expect(db.creator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...scope, status: 'READY', portraitId: { not: null } },
        orderBy: [{ isDefault: 'desc' }, { useCount: 'desc' }, { createdAt: 'asc' }],
      }),
    );
    const ugcItem = { businessId: 'biz-1', sourceType: 'BRIEF', ugc: {} } as Parameters<
      typeof withDefaultCreator
    >[2];
    expect((await withDefaultCreator(asDb, 'org-1', ugcItem)).ugc).toEqual({ creatorId: 'cr-1' });
    const video = { businessId: 'biz-1', sourceType: 'BRIEF' } as Parameters<
      typeof withDefaultCreator
    >[2];
    expect(await withDefaultCreator(asDb, 'org-1', video)).toBe(video);
    const none = fakeDeps({ found: null }).db as unknown as PrismaClient;
    expect(await withDefaultCreator(none, 'org-1', ugcItem)).toBe(ugcItem);
  });
});
