import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as searchRoute from '../../src/app/api/studio/library/search/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { vectorLiteral } from '../../src/lib/studio/images/ingest';
import { vectorSql } from '../../src/lib/studio/vector-sql';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { fakeEmbedding } from '../helpers/png';

// BACKLOG 13.8 — POST /library/search: the query is embedded through the provider router (the
// harness's scripted OpenAI adapter returns bag-of-words vectors), ranked by pgvector cosine
// similarity + keyword boost; retired and unlicensed items never appear; cursor paging.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!hasDb)('POST /library/search', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-libsearch-${randomUUID()}`;
  const tokens = { reader: tenant(org, ['studio:project:read']), none: tenant(org, []) };
  const ids: Record<string, string> = {};
  let h: ReturnType<typeof createHarness>;

  async function item(
    key: string,
    input: { title: string; text: string; tags?: string[]; category: string; licensed?: boolean },
  ) {
    const row = await db.videoLibraryItem.create({
      data: {
        title: input.title,
        categoryId: input.category,
        tags: input.tags ?? [],
        s3Bucket: 'library',
        s3Key: `library/${RUN}-${key}.mp4`,
        thumbnailS3Key: `library/${RUN}-${key}-thumb.jpg`,
        durationSec: 15,
        aspectRatio: '9:16',
      },
    });
    if (input.licensed !== false)
      await db.videoLibraryLicense.create({
        data: { libraryItemId: row.id, scenario: 'OWNED', allowedModes: ['TEMPLATE', 'INSPIRE'] },
      });
    const v = await vectorSql(db);
    await db.$executeRaw`
      INSERT INTO studio.video_library_embeddings (id, "libraryItemId", embedding, "embeddingModel")
      VALUES (${randomUUID()}, ${row.id}, ${vectorLiteral(fakeEmbedding(input.text))}${v.cast}, 'test')`;
    ids[key] = row.id;
    return row;
  }

  beforeAll(async () => {
    h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
    const food = await db.videoLibraryCategory.create({
      data: { slug: `t${RUN}/food`, name: 'Food', depth: 0 },
    });
    const fit = await db.videoLibraryCategory.create({
      data: { slug: `t${RUN}/fitness`, name: 'Fitness', depth: 0 },
    });
    await item('bakery', {
      title: 'POV: 5am at the bakery',
      text: 'moody early bakery bread oven dawn pov',
      tags: ['bakery', 'pov'],
      category: food.id,
    });
    await item('bread', {
      title: 'Sourdough shaping',
      text: 'bread dough bakery shaping hands',
      category: food.id,
    });
    await item('gym', {
      title: 'Leg day',
      text: 'gym squat workout fitness',
      category: fit.id,
    });
    const retired = await item('retired', {
      title: 'Retired bakery pov',
      text: 'moody early bakery bread oven dawn pov',
      category: food.id,
    });
    await db.videoLibraryItem.update({
      where: { id: retired.id },
      data: { retiredAt: new Date() },
    });
    await item('unlicensed', {
      title: 'Unlicensed bakery pov',
      text: 'moody early bakery bread oven dawn pov',
      category: food.id,
      licensed: false,
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const itemIds = Object.values(ids);
    await db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ANY(${itemIds})`;
    await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
    await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
    await db.videoLibraryCategory.deleteMany({ where: { slug: { startsWith: `t${RUN}/` } } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const search = (body: unknown, token = 'reader') =>
    call(searchRoute.POST, { method: 'POST', token, body });

  it('ranks by similarity + keyword boost, hides retired and unlicensed items', async () => {
    const res = await search({ q: 'moody 5am bakery pov', categorySlug: `t${RUN}`, limit: 10 });
    expect(res.status).toBe(200);
    const data = res.json.data as Array<{
      id: string;
      similarity: number;
      score: number;
      thumbnailUrl: string;
    }>;
    const order = data.map((d) => d.id);
    expect(order[0]).toBe(ids.bakery);
    expect(order).not.toContain(ids.retired);
    expect(order).not.toContain(ids.unlicensed);
    expect(order.indexOf(ids.bread as string)).toBeLessThan(order.indexOf(ids.gym as string));
    const top = data[0];
    expect(top?.score).toBeGreaterThan(top?.similarity ?? 1); // title + tag boost
    expect(top?.thumbnailUrl).toContain('https://');
    // The query went through the provider router (tracked provider job for the organisation).
    expect(await db.providerJob.count({ where: { organisationId: org } })).toBeGreaterThan(0);
  });

  it('filters by category prefix and pages with a cursor', async () => {
    const fitness = await search({ q: 'workout', categorySlug: `t${RUN}/fitness` });
    expect((fitness.json.data as Array<{ id: string }>).map((d) => d.id)).toEqual([ids.gym]);
    const first = await search({ q: 'bakery bread', categorySlug: `t${RUN}`, limit: 1 });
    expect((first.json.data as unknown[]).length).toBe(1);
    expect(first.json.nextCursor).toBe('1');
    const second = await search({
      q: 'bakery bread',
      categorySlug: `t${RUN}`,
      limit: 1,
      cursor: first.json.nextCursor,
    });
    const a = (first.json.data as Array<{ id: string }>)[0]?.id;
    const b = (second.json.data as Array<{ id: string }>)[0]?.id;
    expect(b).toBeDefined();
    expect(b).not.toBe(a);
  });

  it('validates the body and needs studio:project:read', async () => {
    expect((await search({ q: '' })).status).toBe(400);
    expect((await search({ q: 'x', limit: 500 })).status).toBe(400);
    expect((await search({ q: 'x', cursor: 'abc' })).status).toBe(400);
    expect((await search({ q: 'x', unknown: 1 })).status).toBe(400);
    expect((await search({ q: 'bread' }, 'none')).status).toBe(403);
    expect((await call(searchRoute.POST, { method: 'POST', body: { q: 'x' } })).status).toBe(401);
  });
});
