import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as duplicateRoute from '../../src/app/api/studio/projects/[id]/duplicate/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { ugcStyleOf } from '../../src/lib/studio/ugc/style';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 21.4 — POST /projects with the "UGC actor" style through the real route wrapper on
// real Postgres: no tier gate, short-form English briefs only, real-person refusal, product image
// check, metadata.ugc with a seed, the UGC default budget, duplicate and generate rules.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('UGC actor projects (21.4)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `ugc-${randomUUID()}`;
  const basic = { ...tenant(org), organisation: { id: org, planTier: 'BASIC' as const } };
  const plus = { ...tenant(org), organisation: { id: org, planTier: 'PLUS' as const } };
  const tokens = { owner: tenant(org), basic, plus };

  const body = (over: Record<string, unknown> = {}) => ({
    businessId: 'biz-ugc',
    brief: { rawInput: 'A friendly creator reviews our oat latte kit' },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
    ugc: {
      product: { name: 'Oat latte kit' },
      actor: { ageRange: '25-34', gender: 'woman', setting: 'kitchen' },
    },
    ...over,
  });

  beforeEach(() => {
    installApi(db, tokens);
  });
  afterAll(async () => {
    setApiDeps(undefined);
    await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('creates a UGC project with the style, a seed and the UGC default budget', async () => {
    const res = await call(projectsRoute.POST, { method: 'POST', token: 'owner', body: body() });
    expect(res.status).toBe(201);
    const project = res.json.project as { id: string; costBudgetPence: number; metadata: unknown };
    expect(project.costBudgetPence).toBe(600);
    const style = ugcStyleOf(project.metadata as never);
    expect(style).toMatchObject({
      style: 'UGC_ACTOR',
      product: { name: 'Oat latte kit', imageId: null },
      actor: { ageRange: '25-34', gender: 'woman', setting: 'kitchen' },
    });
    expect(Number.isInteger(style?.seed)).toBe(true);

    const plusRes = await call(projectsRoute.POST, { method: 'POST', token: 'plus', body: body() });
    expect((plusRes.json.project as { costBudgetPence: number }).costBudgetPence).toBe(750);
  });

  it('has no tier gate: a legacy BASIC organisation may make one too', async () => {
    const res = await call(projectsRoute.POST, { method: 'POST', token: 'basic', body: body() });
    expect(res.status).toBe(201);
  });

  it('refuses a brief that asks for a real person, with the reason the UI translates', async () => {
    const res = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: body({ brief: { rawInput: 'An actor who looks like Taylor Swift reviews our kit' } }),
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({
      error: 'validation_error',
      details: { reason: 'ugc_real_person_refused' },
    });
  });

  it.each([
    [
      'long-form',
      { targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', durationSec: 90 }] },
    ],
    ['a non-English language', { language: 'fr' }],
    ['a slideshow', { sourceType: 'SLIDESHOW', slideshow: { templateId: 't', topic: 'x' } }],
  ])('refuses %s', async (_label, over) => {
    const res = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: body(over),
    });
    expect(res.status).toBe(400);
  });

  it('checks the product image belongs to the business’s image library', async () => {
    const missing = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: body({ ugc: { product: { imageId: 'no-such-image' } } }),
    });
    expect(missing.status).toBe(400);
    const image = await db.imageLibraryItem.create({
      data: {
        organisationId: org,
        businessId: 'biz-ugc',
        source: 'UPLOAD',
        s3Bucket: 'assets',
        s3Key: `orgs/${org}/product.png`,
        widthPx: 1080,
        heightPx: 1080,
        fileSizeBytes: 1000,
        fingerprint: randomUUID(),
      },
    });
    const ok = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: body({ ugc: { product: { imageId: image.id } } }),
    });
    expect(ok.status).toBe(201);
    expect(ugcStyleOf((ok.json.project as { metadata: never }).metadata)?.product.imageId).toBe(
      image.id,
    );
  });

  it('a duplicate keeps the style and actor; an edit to French is refused', async () => {
    const created = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: body(),
    });
    const id = (created.json.project as { id: string }).id;
    const original = ugcStyleOf((created.json.project as { metadata: never }).metadata);

    const copy = await call(duplicateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
    });
    expect(ugcStyleOf((copy.json.project as { metadata: never }).metadata)).toEqual(original);

    const edit = await call(projectRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id },
      body: { language: 'fr' },
    });
    expect(edit.status).toBe(400);
  });
});
