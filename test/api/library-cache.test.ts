import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as adminBulkRoute from '../../src/app/api/studio/admin/library/videos/bulk/route';
import * as adminRetireRoute from '../../src/app/api/studio/admin/library/videos/[id]/retire/route';
import * as adminVideoRoute from '../../src/app/api/studio/admin/library/videos/[id]/route';
import * as categoriesRoute from '../../src/app/api/studio/library/categories/route';
import * as videoRoute from '../../src/app/api/studio/library/videos/[id]/route';
import * as videosRoute from '../../src/app/api/studio/library/videos/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  createLibraryCache,
  LIBRARY_VERSION_KEY,
  type LibraryCacheClient,
} from '../../src/lib/studio/library/cache';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// BACKLOG 20.15 — the library cache through real routes and Postgres: a repeated browse does not
// query the database, every staff write (edit, licence change, bulk review, retire) bumps the
// version so the next read is fresh, and GET responses carry a private Cache-Control.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

function memoryClient(): LibraryCacheClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    incr: async (key) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
  };
}

describe.skipIf(!hasDb)('library cache through the API (20.15)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-libcache-${randomUUID()}`;
  const tokens = {
    reader: tenant(org, ['studio:project:read']),
    staff: tenant(org, ['studio:project:read', 'studio:admin:library']),
  };
  const client = memoryClient();
  const ids: string[] = [];
  let categoryId = '';
  const path = `/api/studio/library/videos?category=cache${RUN}&limit=50`;

  beforeAll(async () => {
    const h = createHarness(db);
    const { deps } = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
    setApiDeps({
      ...deps,
      libraryCache: createLibraryCache({
        client,
        logger: pino({ level: 'silent' }),
        counter: { inc: vi.fn() },
      }),
    });
    const cat = await db.videoLibraryCategory.create({
      data: { slug: `cache${RUN}`, name: 'Cache', depth: 0 },
    });
    categoryId = cat.id;
    for (const key of ['a', 'b']) {
      const row = await db.videoLibraryItem.create({
        data: {
          title: `${key} ${RUN}`,
          categoryId,
          tags: ['cache-test'],
          s3Bucket: 'library',
          s3Key: `library/${RUN}-${key}.mp4`,
          thumbnailS3Key: `library/${RUN}-${key}-thumb.jpg`,
          durationSec: 15,
          aspectRatio: '9:16',
        },
      });
      await db.videoLibraryLicense.create({
        data: { libraryItemId: row.id, scenario: 'OWNED', allowedModes: ['TEMPLATE', 'INSPIRE'] },
      });
      ids.push(row.id);
    }
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: ids } } });
    await db.videoLibraryItem.deleteMany({ where: { id: { in: ids } } });
    await db.videoLibraryCategory.deleteMany({ where: { id: categoryId } });
    await db.$disconnect();
  });

  const titles = (json: Record<string, unknown>) =>
    (json.data as Array<{ id: string; title: string }>).map((d) => d.title).sort();

  it('serves a repeated browse from the cache, with a private Cache-Control', async () => {
    const first = await call(videosRoute.GET, { token: 'reader', path });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, max-age=60');
    expect(titles(first.json)).toEqual([`a ${RUN}`, `b ${RUN}`]);
    // A direct database change without a version bump is not seen: the page came from the cache.
    await db.videoLibraryItem.update({ where: { id: ids[0] }, data: { title: `raw ${RUN}` } });
    const second = await call(videosRoute.GET, { token: 'reader', path });
    expect(titles(second.json)).toEqual([`a ${RUN}`, `b ${RUN}`]);
    const cats = await call(categoriesRoute.GET, { token: 'reader' });
    expect(cats.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('a staff edit bumps the version: the next browse and detail are fresh', async () => {
    const before = Number(client.store.get(LIBRARY_VERSION_KEY) ?? '0');
    const patch = await call(adminVideoRoute.PATCH, {
      method: 'PATCH',
      token: 'staff',
      params: { id: ids[0] as string },
      body: { title: `edited ${RUN}` },
    });
    expect(patch.status).toBe(200);
    expect(Number(client.store.get(LIBRARY_VERSION_KEY))).toBe(before + 1);
    const list = await call(videosRoute.GET, { token: 'reader', path });
    expect(titles(list.json)).toEqual([`b ${RUN}`, `edited ${RUN}`]);
    const detail = await call(videoRoute.GET, {
      token: 'reader',
      params: { id: ids[0] as string },
    });
    expect((detail.json.video as { title: string }).title).toBe(`edited ${RUN}`);
  });

  it('a licence change, a bulk review and a retirement each bump the version', async () => {
    const version = () => Number(client.store.get(LIBRARY_VERSION_KEY) ?? '0');
    const v0 = version();
    await call(adminVideoRoute.PATCH, {
      method: 'PATCH',
      token: 'staff',
      params: { id: ids[1] as string },
      body: { licenseScenario: 'SCRAPED' },
    });
    expect(version()).toBe(v0 + 1);
    await call(adminBulkRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: { ids: [ids[1]], action: 'accept' },
    });
    expect(version()).toBe(v0 + 2);
    const retire = await call(adminRetireRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { id: ids[1] as string },
    });
    expect(retire.status).toBe(200);
    expect(version()).toBe(v0 + 3);
    const list = await call(videosRoute.GET, { token: 'reader', path });
    expect(titles(list.json)).toEqual([`edited ${RUN}`]);
  });
});
