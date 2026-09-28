import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bulkRoute from '../../src/app/api/studio/admin/library/videos/bulk/route';
import * as licenceAuditRoute from '../../src/app/api/studio/admin/library/licence-audit/route';
import * as reanalyseRoute from '../../src/app/api/studio/admin/library/reanalyse/route';
import * as adminVideosRoute from '../../src/app/api/studio/admin/library/videos/route';
import * as userVideosRoute from '../../src/app/api/studio/library/videos/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 15.D7 / Addendum A3.8 — staff corpus list (incl. unlicensed + retired), bulk
// categorisation review, re-analysis queueing and the licence audit: staff only, validated,
// audited. A11.1: the unlicensed row the staff list shows never reaches the user list.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
// Old ingest dates put these rows first in the audit's oldest-first problem list.
const OLD = new Date('2001-01-01T00:00:00.000Z');

type Row = {
  id: string;
  licence: { status: string; scenario: string | null };
  retiredAt: string | null;
  categoryReview: string | null;
};

describe.skipIf(!hasDb)('admin library (15.D7)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-libadmin-${randomUUID()}`;
  const tokens = {
    staff: tenant(org, ['studio:admin:library']),
    user: tenant(org, ['studio:project:read']),
  };
  let api: ReturnType<typeof installApi>;
  const ids: Record<string, string> = {};
  const cats: Record<string, string> = {};

  async function item(
    key: string,
    licence: { expires?: Date | null } | null,
    extra: { retired?: boolean } = {},
  ) {
    const row = await db.videoLibraryItem.create({
      data: {
        title: `${key} ${RUN}`,
        categoryId: cats.food as string,
        tags: [`tag${RUN}`],
        s3Bucket: 'library',
        s3Key: `library/${RUN}-${key}.mp4`,
        thumbnailS3Key: `library/${RUN}-${key}-thumb.jpg`,
        durationSec: 12,
        aspectRatio: '9:16',
        ingestedAt: OLD,
        ...(extra.retired && { retiredAt: new Date() }),
      },
    });
    if (licence)
      await db.videoLibraryLicense.create({
        data: {
          libraryItemId: row.id,
          scenario: 'LICENSED',
          allowedModes: ['TEMPLATE', 'INSPIRE'],
          licenseExpires: licence.expires ?? null,
        },
      });
    ids[key] = row.id;
  }

  beforeAll(async () => {
    api = installApi(db, tokens);
    for (const slug of ['food', 'fitness']) {
      const c = await db.videoLibraryCategory.create({
        data: { slug: `la${RUN}/${slug}`, name: slug, depth: 0 },
      });
      cats[slug] = c.id;
    }
    await item('licensed', {});
    await item('unlicensed', null);
    await item('retired', {}, { retired: true });
    await item('expired', { expires: new Date(Date.now() - DAY) });
    await item('expiring', { expires: new Date(Date.now() + 5 * DAY) });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const itemIds = Object.values(ids);
    await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
    await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
    await db.videoLibraryCategory.deleteMany({ where: { slug: { startsWith: `la${RUN}/` } } });
    await db.$disconnect();
  });

  const list = (query: string, token = 'staff') =>
    call(adminVideosRoute.GET, {
      token,
      path: `/api/studio/admin/library/videos?q=${RUN}&limit=100&${query}`,
    });
  const rows = (res: { json: Record<string, unknown> }) => res.json.data as Row[];

  describe('GET /admin/library/videos', () => {
    it('is staff only', async () => {
      expect((await list('')).status).toBe(200);
      expect((await list('', 'user')).status).toBe(403);
      expect((await call(adminVideosRoute.GET, {})).status).toBe(401);
    });

    it('lists every row with its licence status, including unlicensed and retired ones', async () => {
      const all = rows(await list(''));
      expect(all.map((r) => r.id).sort()).toEqual(Object.values(ids).sort());
      const byId = new Map(all.map((r) => [r.id, r]));
      expect(byId.get(ids.unlicensed as string)?.licence).toMatchObject({
        status: 'missing',
        scenario: null,
      });
      expect(byId.get(ids.expired as string)?.licence.status).toBe('expired');
      expect(byId.get(ids.expiring as string)?.licence.status).toBe('expiring');
      expect(byId.get(ids.licensed as string)?.licence.status).toBe('ok');
    });

    it('filters by licence=missing, scenario and retired', async () => {
      expect(rows(await list('licence=missing')).map((r) => r.id)).toEqual([ids.unlicensed]);
      expect(rows(await list('licence=OWNED'))).toEqual([]);
      expect(rows(await list('retired=true')).map((r) => r.id)).toEqual([ids.retired]);
      expect(rows(await list('retired=false')).map((r) => r.id)).not.toContain(ids.retired);
      expect((await list('licence=bogus')).status).toBe(400);
      expect((await list('limit=500')).status).toBe(400);
    });

    it('never lists the unlicensed row to users (A11.1)', async () => {
      const res = await call(userVideosRoute.GET, {
        token: 'user',
        path: `/api/studio/library/videos?category=la${RUN}&limit=100`,
      });
      expect(res.status).toBe(200);
      const userIds = (res.json.data as Array<{ id: string }>).map((v) => v.id);
      expect(userIds).toContain(ids.licensed);
      expect(userIds).not.toContain(ids.unlicensed);
    });
  });

  describe('POST /admin/library/videos/bulk', () => {
    const bulk = (body: unknown, token = 'staff') =>
      call(bulkRoute.POST, { method: 'POST', token, body });

    it('validates the action and its category', async () => {
      expect((await bulk({ ids: [ids.licensed], action: 'accept' }, 'user')).status).toBe(403);
      expect((await bulk({ ids: [ids.licensed], action: 'override' })).status).toBe(400);
      expect(
        (await bulk({ ids: [ids.licensed], action: 'accept', categoryId: cats.fitness })).status,
      ).toBe(400);
      expect((await bulk({ ids: [], action: 'accept' })).status).toBe(400);
      const tooMany = Array.from({ length: 101 }, (_, i) => `id${i}`);
      expect((await bulk({ ids: tooMany, action: 'accept' })).status).toBe(400);
      expect((await bulk({ ids: [ids.licensed], action: 'merge' })).status).toBe(400);
      expect(
        (await bulk({ ids: [ids.licensed], action: 'override', categoryId: 'nope' })).status,
      ).toBe(400);
      expect((await bulk({ ids: ['missing-1'], action: 'accept' })).status).toBe(404);
    });

    it('accepts, overrides (by id or slug) and rejects, with an audit entry', async () => {
      const accepted = await bulk({ ids: [ids.licensed, 'unknown-id'], action: 'accept' });
      expect(accepted.status).toBe(200);
      expect(accepted.json).toMatchObject({ updated: [ids.licensed], missing: ['unknown-id'] });
      expect(
        (await db.videoLibraryItem.findUniqueOrThrow({ where: { id: ids.licensed } }))
          .categoryReview,
      ).toBe('ACCEPTED');

      const overridden = await bulk({
        ids: [ids.expiring],
        action: 'override',
        category: `la${RUN}/fitness`,
      });
      expect(overridden.status).toBe(200);
      const moved = await db.videoLibraryItem.findUniqueOrThrow({ where: { id: ids.expiring } });
      expect(moved).toMatchObject({ categoryId: cats.fitness, categoryReview: 'OVERRIDDEN' });
      const byId = await bulk({
        ids: [ids.expiring],
        action: 'override',
        categoryId: cats.food,
      });
      expect(byId.json.categoryId).toBe(cats.food);

      const rejected = await bulk({ ids: [ids.expired, ids.retired], action: 'reject' });
      expect(rejected.json).toMatchObject({ retired: 1 });
      const gone = await db.videoLibraryItem.findUniqueOrThrow({ where: { id: ids.expired } });
      expect(gone.categoryReview).toBe('REJECTED');
      expect(gone.retiredAt).not.toBeNull();
      expect(
        rows(await list('review=REJECTED'))
          .map((r) => r.id)
          .sort(),
      ).toEqual([ids.expired, ids.retired].sort());

      const audits = api.audits.filter((a) => a.action === 'studio.library.bulk_review');
      expect(audits).toHaveLength(4);
      expect(audits[0]?.metadata).toMatchObject({ action: 'accept', ids: [ids.licensed] });
    });
  });

  describe('POST /admin/library/reanalyse', () => {
    it('queues one re-analysis job per known item, 202, audited', async () => {
      const before = api.queue.pending.length;
      const res = await call(reanalyseRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: { ids: [ids.licensed, ids.unlicensed, 'unknown-id'] },
      });
      expect(res.status).toBe(202);
      expect(res.json.skipped).toEqual([{ id: 'unknown-id', reason: 'unknown' }]);
      const jobs = api.queue.pending.slice(before);
      expect(jobs.map((j) => j.name)).toEqual([
        'reanalyse-library-video',
        'reanalyse-library-video',
      ]);
      expect(jobs[0]?.data).toMatchObject({ libraryItemId: ids.licensed, batch: true });
      expect(jobs[0]?.jobId).toContain(`reanalyse-library-video__${ids.licensed}__`);
      expect(api.audits.some((a) => a.action === 'studio.library.reanalyse')).toBe(true);
    });

    it('is staff only and bounded', async () => {
      const post = (body: unknown, token = 'staff') =>
        call(reanalyseRoute.POST, { method: 'POST', token, body });
      expect((await post({ ids: [ids.licensed] }, 'user')).status).toBe(403);
      expect((await post({ ids: [] })).status).toBe(400);
      expect((await post({ ids: Array.from({ length: 101 }, (_, i) => `x${i}`) })).status).toBe(
        400,
      );
      expect((await post({ ids: [ids.licensed], extra: true })).status).toBe(400);
    });
  });

  describe('GET /admin/library/licence-audit', () => {
    it('counts missing, expired and expiring licences and lists the problem rows', async () => {
      expect((await call(licenceAuditRoute.GET, { token: 'user' })).status).toBe(403);
      expect(
        (
          await call(licenceAuditRoute.GET, {
            token: 'staff',
            path: '/api/studio/admin/library/licence-audit?limit=999',
          })
        ).status,
      ).toBe(400);
      const res = await call(licenceAuditRoute.GET, {
        token: 'staff',
        path: '/api/studio/admin/library/licence-audit?limit=200',
      });
      expect(res.status).toBe(200);
      expect(res.json.missing as number).toBeGreaterThanOrEqual(1);
      expect(res.json.expiringSoon as number).toBeGreaterThanOrEqual(1);
      expect(res.json.expiringWithinDays).toBe(30);
      const problems = res.json.problems as Array<{ id: string; problem: string }>;
      expect(problems).toContainEqual(
        expect.objectContaining({ id: ids.unlicensed, problem: 'missing' }),
      );
      expect(problems).toContainEqual(
        expect.objectContaining({ id: ids.expiring, problem: 'expiring' }),
      );
      // The rejected (retired) expired row is not part of the live audit.
      expect(problems.map((p) => p.id)).not.toContain(ids.expired);
      expect(res.json.byScenario).toMatchObject({ LICENSED: expect.any(Number) });
    });
  });
});
