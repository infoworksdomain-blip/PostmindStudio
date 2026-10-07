import type { ImageSource, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { AssetStorage } from '../storage';
import type { ImageLoader, RelevanceGate } from './image-relevance';
import {
  LIBRARY_CHECK_CANDIDATES,
  OWN_IMAGE_SOURCES,
  relevantLibraryImage,
  type LibraryRelevanceDeps,
} from './library-relevance';

// 25.x follow-up — library matches must fit the slide (production re-run 2026-10-07: the gym's
// pre-fix puppies photo, stored in its library, kept coming back).

const scope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'STANDARD' as const };
type Row = {
  id: string;
  source: ImageSource;
  s3Bucket: string;
  s3Key: string;
  publicUrl: string | null;
};

const row = (id: string, source: ImageSource, hotlink = false): Row => ({
  id,
  source,
  s3Bucket: hotlink ? '' : 'assets',
  s3Key: hotlink ? '' : `lib/${id}.jpg`,
  publicUrl: hotlink ? `https://images.unsplash.example/${id}` : null,
});

function deps(rows: Row[]) {
  const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    rows.filter((r) => where.id.in.includes(r.id)),
  );
  const storage = {
    size: vi.fn(async () => 3),
    readRange: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const fetchImpl = vi.fn(
    async () => new Response(new Uint8Array([9, 9]), { status: 200 }),
  ) as unknown as typeof fetch;
  const d: LibraryRelevanceDeps = {
    db: { imageLibraryItem: { findMany } } as unknown as PrismaClient,
    storage: storage as unknown as AssetStorage,
    providers: {} as unknown as ProviderRunDeps,
    fetchImpl,
    logger: { warn: vi.fn() },
  };
  return { d, findMany, storage, fetchImpl };
}

/** A gate that keeps only the listed ids and records what it was asked to judge. */
function gate(keep: string[] | 'all') {
  const seen: Array<{ ids: string[]; what: string; loaders: ImageLoader[] }> = [];
  const g: RelevanceGate = {
    async screen(_query, items, loader, what) {
      const list = items as unknown as Row[];
      seen.push({ ids: list.map((r) => r.id), what, loaders: items.map(loader) });
      return keep === 'all' ? [...items] : items.filter((_, i) => keep.includes(list[i]!.id));
    },
  };
  return { g, seen };
}

describe('relevantLibraryImage', () => {
  it('trusts the business’s own pictures (UPLOAD, SCRAPED) without a check', async () => {
    expect([...OWN_IMAGE_SOURCES].sort()).toEqual(['SCRAPED', 'UPLOAD']);
    const { d } = deps([row('own', 'UPLOAD'), row('stock', 'STOCK')]);
    const { g, seen } = gate([]);
    expect(
      await relevantLibraryImage(d, scope, { query: 'gym coach', ids: ['own', 'stock'], gate: g }),
    ).toBe('own');
    expect(seen).toHaveLength(0);
  });

  it('a rejected auto-stored STOCK match falls through (undefined → stock search)', async () => {
    const { d } = deps([row('puppies', 'STOCK'), row('truck', 'GENERATED')]);
    const { g, seen } = gate([]);
    expect(
      await relevantLibraryImage(d, scope, {
        query: 'gym coach',
        ids: ['puppies', 'truck'],
        gate: g,
      }),
    ).toBeUndefined();
    expect(seen).toEqual([expect.objectContaining({ ids: ['puppies', 'truck'], what: 'library' })]);
  });

  it('keeps similarity order: a rejected stock top hit, then an own picture or a passing one', async () => {
    const { d } = deps([row('puppies', 'STOCK'), row('coach', 'STOCK'), row('own', 'SCRAPED')]);
    const pass = gate(['coach']);
    expect(
      await relevantLibraryImage(d, scope, {
        query: 'q',
        ids: ['puppies', 'coach', 'own'],
        gate: pass.g,
      }),
    ).toBe('coach');
    expect(pass.seen[0]!.ids).toEqual(['puppies', 'coach']); // own pictures are never sent

    const none = gate([]);
    expect(
      await relevantLibraryImage(d, scope, { query: 'q', ids: ['puppies', 'own'], gate: none.g }),
    ).toBe('own');
  });

  it('an outage or the cap (gate passes items unchanged) accepts the best match', async () => {
    const { d } = deps([row('puppies', 'STOCK')]);
    expect(
      await relevantLibraryImage(d, scope, { query: 'q', ids: ['puppies'], gate: gate('all').g }),
    ).toBe('puppies');
  });

  it(`judges at most ${LIBRARY_CHECK_CANDIDATES} candidates, scoped to the business`, async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => row(id, 'STOCK'));
    const { d, findMany } = deps(rows);
    const { g, seen } = gate([]);
    await relevantLibraryImage(d, scope, { query: 'q', ids: ['a', 'b', 'c', 'd'], gate: g });
    expect(seen[0]!.ids).toEqual(['a', 'b', 'c']);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ['a', 'b', 'c'] }, organisationId: 'org-1', businessId: 'biz-1' },
    });
  });

  it('stored pictures are read from storage; hotlinked ones are downloaded', async () => {
    const { d, storage, fetchImpl } = deps([row('stored', 'STOCK'), row('hot', 'STOCK', true)]);
    const { g, seen } = gate([]);
    await relevantLibraryImage(d, scope, { query: 'q', ids: ['stored', 'hot'], gate: g });
    const [stored, hot] = seen[0]!.loaders;
    expect(await stored!()).toEqual(new Uint8Array([1, 2, 3]));
    expect(storage.readRange).toHaveBeenCalledWith('assets', 'lib/stored.jpg', 0, 2);
    expect(await hot!()).toEqual(new Uint8Array([9, 9]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no candidates → no query', async () => {
    const { d, findMany } = deps([]);
    expect(
      await relevantLibraryImage(d, scope, { query: 'q', ids: [], gate: gate([]).g }),
    ).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});
