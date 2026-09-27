import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as extractRoute from '../../src/app/api/studio/brand-kits/extract/route';
import * as onboardingRoute from '../../src/app/api/studio/onboarding/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';

// BACKLOG 13.14 — GET|PATCH /onboarding (per user, per organisation) and POST
// /brand-kits/extract (palette from a logo with sharp).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('onboarding + brand-kit palette extraction', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-onboard-${randomUUID()}`;
  const busy = `api-onboard-busy-${randomUUID()}`;
  const tokens = {
    alice: tenant(org, ['studio:project:read', 'studio:project:write'], 'alice'),
    bob: tenant(org, ['studio:project:read'], 'bob'),
    veteran: tenant(busy, ['studio:project:read'], 'vera'),
    none: tenant(org, [], 'zed'),
  };
  let projectId: string;

  beforeAll(async () => {
    installApi(db, tokens);
    const project = await db.videoProject.create({
      data: {
        organisationId: busy,
        businessId: 'biz',
        createdByUserId: 'vera',
        name: 'Existing',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.onboardingState.deleteMany({ where: { organisationId: { in: [org, busy] } } });
    await db.videoProject.deleteMany({ where: { organisationId: busy } });
    await db.$disconnect();
  });

  const get = (token: string) => call(onboardingRoute.GET, { token });
  const patch = (token: string, body: unknown) =>
    call(onboardingRoute.PATCH, { method: 'PATCH', token, body });

  it('a new user of an empty organisation starts at connect and is pointed at /welcome', async () => {
    const res = await get('alice');
    expect(res.status).toBe(200);
    expect(res.json.onboarding).toMatchObject({
      step: 'connect',
      completed: [],
      firstVideoProjectId: null,
      suggested: true,
    });
    // An organisation that already has projects is not nagged.
    expect((await get('veteran')).json.onboarding).toMatchObject({ suggested: false });
  });

  it('PATCH saves progress per user (ordered, deduplicated)', async () => {
    const res = await patch('alice', {
      completed: ['brand_kit', 'connect', 'connect'],
      step: 'first_video',
    });
    expect(res.status).toBe(200);
    expect(res.json.onboarding).toMatchObject({
      step: 'first_video',
      completed: ['connect', 'brand_kit'],
      suggested: true,
    });
    expect((await get('bob')).json.onboarding).toMatchObject({ step: 'connect', completed: [] });
  });

  it('validates steps and project ids (tenant-scoped)', async () => {
    expect((await patch('alice', { step: 'nope' })).status).toBe(400);
    expect((await patch('alice', {})).status).toBe(400);
    expect((await patch('alice', { firstVideoProjectId: projectId })).status).toBe(400);
    expect((await get('none')).status).toBe(403);
  });

  it('finishing or dismissing stops the suggestion', async () => {
    expect((await patch('bob', { dismissed: true })).json.onboarding).toMatchObject({
      suggested: false,
      dismissedAt: expect.any(String),
    });
    expect(
      (
        await patch('alice', {
          step: 'done',
          completed: ['connect', 'brand_kit', 'first_video', 'celebrate'],
        })
      ).json.onboarding,
    ).toMatchObject({ step: 'done', suggested: false });
  });

  it('POST /brand-kits/extract returns the logo palette', async () => {
    const logo = await sharp({
      create: { width: 100, height: 100, channels: 4, background: '#C6452D' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('logo', new File([new Uint8Array(logo)], 'logo.png', { type: 'image/png' }));
    const { body, headers } = await multipart(form);
    const res = await call(extractRoute.POST, { method: 'POST', token: 'alice', body, headers });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ palette: ['#C6452D'], suggestedFont: null });

    const bad = new FormData();
    bad.append('logo', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
    const badBody = await multipart(bad);
    expect(
      (await call(extractRoute.POST, { method: 'POST', token: 'alice', ...badBody })).status,
    ).toBe(400);
    const empty = await multipart(new FormData());
    expect(
      (await call(extractRoute.POST, { method: 'POST', token: 'alice', ...empty })).status,
    ).toBe(400);
    expect(
      (await call(extractRoute.POST, { method: 'POST', token: 'bob', body, headers })).status,
    ).toBe(403);
  });
});
