import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as brandKitRoute from '../../src/app/api/studio/brand-kits/[id]/route';
import * as setDefaultRoute from '../../src/app/api/studio/brand-kits/[id]/set-default/route';
import * as brandKitsRoute from '../../src/app/api/studio/brand-kits/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// Covers src/lib/studio/services/brand-kits.ts + routes: CRUD, set-default (one default per
// business), tenant isolation and validation, through the real routes and Postgres (spec 8.5).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('brand kits API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-bk-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-bk-other-${randomUUID()}`),
  };

  beforeEach(() => {
    installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.brandKit.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const list = (businessId?: string, token = 'owner') =>
    call(brandKitsRoute.GET, {
      token,
      path: businessId
        ? `/api/studio/brand-kits?businessId=${businessId}`
        : '/api/studio/brand-kits',
    });
  const create = (body: unknown, token = 'owner') =>
    call(brandKitsRoute.POST, { method: 'POST', token, body });
  const get = (id: string, token = 'owner') => call(brandKitRoute.GET, { token, params: { id } });
  const patch = (id: string, body: unknown, token = 'owner') =>
    call(brandKitRoute.PATCH, { method: 'PATCH', token, body, params: { id } });
  const del = (id: string, token = 'owner') =>
    call(brandKitRoute.DELETE, { method: 'DELETE', token, params: { id } });
  const setDefault = (id: string, token = 'owner') =>
    call(setDefaultRoute.POST, { method: 'POST', token, params: { id } });

  const validKit = (overrides: Record<string, unknown> = {}) => ({
    businessId: 'biz-1',
    name: 'Leeds Sourdough',
    colourPalette: ['#112233', '#AABBCC'],
    fontPrimary: 'Inter',
    fontSecondary: null,
    toneKeywords: ['warm', 'confident'],
    audienceProfile: 'Leeds professionals 25-40',
    ctaTemplates: [{ label: 'Shop', template: 'Shop now at {url}' }],
    restrictedTopics: ['politics'],
    ...overrides,
  });

  it('creates the first kit of a business as the default automatically', async () => {
    const res = await create(validKit());
    expect(res.status).toBe(201);
    const kit = res.json.brandKit as Record<string, unknown>;
    expect(kit.isDefault).toBe(true);
    expect(kit.businessId).toBe('biz-1');

    const got = await get(kit.id as string);
    expect(got.status).toBe(200);
    expect((got.json.brandKit as Record<string, unknown>).name).toBe('Leeds Sourdough');
  });

  it('lists kits for a business, defaults ordered first, and supports the unfiltered list', async () => {
    const first = (await create(validKit({ businessId: 'biz-2', name: 'Kit A' }))).json
      .brandKit as { id: string };
    const second = (await create(validKit({ businessId: 'biz-2', name: 'Kit B', isDefault: true })))
      .json.brandKit as { id: string };

    const listed = await list('biz-2');
    expect(listed.status).toBe(200);
    const data = listed.json.data as Array<{ id: string; isDefault: boolean }>;
    expect(data.map((d) => d.id)).toEqual([second.id, first.id]);
    expect(data[0]?.isDefault).toBe(true);
    expect(data[1]?.isDefault).toBe(false);

    const unfiltered = await list();
    expect(unfiltered.status).toBe(200);
    expect((unfiltered.json.data as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('setting a new kit as default atomically clears the previous default', async () => {
    const a = (await create(validKit({ businessId: 'biz-3', name: 'A' }))).json.brandKit as {
      id: string;
      isDefault: boolean;
    };
    expect(a.isDefault).toBe(true);
    const b = (await create(validKit({ businessId: 'biz-3', name: 'B' }))).json.brandKit as {
      id: string;
      isDefault: boolean;
    };
    expect(b.isDefault).toBe(false);

    const switched = await setDefault(b.id);
    expect(switched.status).toBe(200);
    expect((switched.json.brandKit as { isDefault: boolean }).isDefault).toBe(true);

    const kits = await list('biz-3');
    const data = kits.json.data as Array<{ id: string; isDefault: boolean }>;
    expect(data.filter((d) => d.isDefault)).toHaveLength(1);
    expect(data.find((d) => d.id === b.id)?.isDefault).toBe(true);
    expect(data.find((d) => d.id === a.id)?.isDefault).toBe(false);
  });

  it('updates fields and rejects an empty patch', async () => {
    const kit = (await create(validKit({ businessId: 'biz-4' }))).json.brandKit as {
      id: string;
    };
    const patched = await patch(kit.id, { name: 'Renamed', toneKeywords: ['bold'] });
    expect(patched.status).toBe(200);
    const body = patched.json.brandKit as Record<string, unknown>;
    expect(body.name).toBe('Renamed');
    expect(body.toneKeywords).toEqual(['bold']);

    const empty = await patch(kit.id, {});
    expect(empty.status).toBe(400);

    const unknownField = await patch(kit.id, { notAField: 'x' });
    expect(unknownField.status).toBe(400);
  });

  it('deletes a kit that is not in use, and refuses one that is', async () => {
    const kit = (await create(validKit({ businessId: 'biz-5' }))).json.brandKit as {
      id: string;
    };
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz-5',
        createdByUserId: 'user-1',
        name: 'Uses the kit',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        brandKitId: kit.id,
      },
    });

    const blocked = await del(kit.id);
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.json)).toContain('active project');

    await db.videoProject.update({ where: { id: project.id }, data: { state: 'PUBLISHED' } });
    const allowed = await del(kit.id);
    expect(allowed.status).toBe(200);
    expect(allowed.json.deleted).toBe(true);
    // 15.B1 spec 8.5: a soft delete — the row stays, marked deleted.
    expect((await db.brandKit.findUnique({ where: { id: kit.id } }))?.deletedAt).toBeInstanceOf(
      Date,
    );

    await db.videoProject.delete({ where: { id: project.id } });
  });

  it('validates colours, font names and array limits', async () => {
    expect((await create(validKit({ colourPalette: ['red'] }))).status).toBe(400);
    expect((await create(validKit({ fontPrimary: 'Bad<Font>' }))).status).toBe(400);
    expect((await create(validKit({ colourPalette: Array(9).fill('#000000') }))).status).toBe(400);
    expect(await create({ businessId: 'biz-6' })).toHaveProperty('status'); // name required
    const missingName = await create({ businessId: 'biz-6' });
    expect(missingName.status).toBe(400);
  });

  it('enforces tenant isolation: another org gets 404, not the kit', async () => {
    const kit = (await create(validKit({ businessId: 'biz-7' }))).json.brandKit as {
      id: string;
    };
    expect((await get(kit.id, 'stranger')).status).toBe(404);
    expect((await patch(kit.id, { name: 'Nope' }, 'stranger')).status).toBe(404);
    expect((await del(kit.id, 'stranger')).status).toBe(404);
    expect((await setDefault(kit.id, 'stranger')).status).toBe(404);
    expect((await list('biz-7', 'stranger')).json.data).toEqual([]);
  });

  it('enforces capability checks: read requires project:read, writes require project:write', async () => {
    const readOnly = tenant(org, []);
    const tokensWithNone: Record<string, typeof readOnly> = { none: readOnly };
    Object.assign(tokens, tokensWithNone);
    installApi(db, tokens);

    expect((await list(undefined, 'none')).status).toBe(403);
    expect((await create(validKit({ businessId: 'biz-8' }), 'none')).status).toBe(403);

    // reader has project:read but not project:write
    expect((await list(undefined, 'reader')).status).toBe(200);
    expect((await create(validKit({ businessId: 'biz-9' }), 'reader')).status).toBe(403);
  });

  it('a not-found id on get/patch/delete/set-default returns 404 for a valid tenant', async () => {
    const missing = randomUUID();
    expect((await get(missing)).status).toBe(404);
    expect((await patch(missing, { name: 'x' })).status).toBe(404);
    expect((await del(missing)).status).toBe(404);
    expect((await setDefault(missing)).status).toBe(404);
  });
});
