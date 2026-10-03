import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import * as profileRoute from '../../src/app/api/studio/businesses/[id]/business-profile/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { StockHit, StockImageSource } from '../../src/lib/studio/images/stock';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { AUTO_STOCK_PER_QUERY } from '../../src/lib/studio/services/image-library';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { fakePng } from '../helpers/png';

// BACKLOG 20.26 — saving a business profile tops up a thin image library with stock photos
// (cheap: 3 queries × 6 images, once a day per business, never failing the save).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('PATCH business-profile → automatic stock refresh (20.26)', () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-autostock-${randomUUID()}`;
  const biz = `biz-${randomUUID()}`;

  afterAll(async () => {
    setApiDeps(undefined);
    await db.imageLibraryQuery.deleteMany({ where: { businessId: biz } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
    await db.businessProfile.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('queues one small refresh, stores credited Pixabay copies, then waits a day', async () => {
    const searches: Array<{ query: string; perPage: number }> = [];
    const pixabay: StockImageSource = {
      provider: 'pixabay',
      async search(input) {
        searches.push({ query: input.query, perPage: input.perPage });
        return Array.from({ length: input.perPage }, (_, n): StockHit => ({
          provider: 'pixabay',
          providerImageId: `${input.query}-${n}`,
          imageUrl: `https://pixabay.example/${encodeURIComponent(input.query)}-${n}.png`,
          width: 1280,
          height: 853,
          alt: input.query,
          pageUrl: `https://pixabay.com/photos/${n}/`,
          attribution: { name: 'Pix User', url: null },
          storable: true,
        }));
      },
      downloadUrl: async (hit) => hit.imageUrl,
    };
    let salt = 0;
    const images = (async () =>
      new Response(fakePng(1280, 853, 70_000 + (salt += 1)), {
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;
    const h = createHarness(db, { stockSources: [pixabay], pageFetch: images });
    installApi(
      db,
      { owner: tenant(org) },
      { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps },
    );
    await db.businessProfile.create({
      data: {
        organisationId: org,
        businessId: biz,
        industry: 'Software',
        subNiche: 'Meeting assistant',
        products: [],
        services: [],
        audienceKeywords: [],
        toneIndicators: [],
        regions: [],
        imageThemes: ['meetings'],
        imageSearchQueries: ['team meeting', 'office desk', 'video call', 'notebook'],
        restrictedTopics: [],
        classifierModel: 'test',
      },
    });
    const patch = (body: unknown) =>
      call(profileRoute.PATCH, { method: 'PATCH', token: 'owner', params: { id: biz }, body });

    const first = await patch({ imageThemes: ['meetings', 'teamwork'] });
    expect(first.status).toBe(200);
    expect(first.json.stockRefresh).toBe('queued');
    expect(h.queue.pending.map((j) => j.name)).toEqual(['refresh-image-library']);
    const drained = await drainInline(h.queue, h.deps);
    expect(drained.failedJobs).toEqual([]);
    expect(searches).toEqual(
      ['team meeting', 'office desk', 'video call'].map((query) => ({
        query,
        perPage: AUTO_STOCK_PER_QUERY,
      })),
    );
    const stored = await db.imageLibraryItem.findMany({ where: { organisationId: org } });
    expect(stored).toHaveLength(3 * AUTO_STOCK_PER_QUERY);
    expect(stored.every((i) => i.source === 'STOCK' && i.s3Key)).toBe(true);
    expect(stored[0]?.licenseNotes).toContain('Pixabay Content License');

    // A second save the same day does not search again; a bare confirmation never does.
    expect((await patch({ imageThemes: ['meetings'] })).json.stockRefresh).toBe('recent');
    expect((await patch({ confirmed: true })).json.stockRefresh).toBe('not_relevant');
    expect(h.queue.pending).toHaveLength(0);
  });
});
