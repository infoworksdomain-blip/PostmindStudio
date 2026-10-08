import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as automationActionRoute from '../../src/app/api/studio/automations/[id]/[action]/route';
import * as automationRoute from '../../src/app/api/studio/automations/[id]/route';
import * as estimateRoute from '../../src/app/api/studio/automations/estimate/route';
import * as automationsRoute from '../../src/app/api/studio/automations/route';
import * as deckRoute from '../../src/app/api/studio/blitz/route';
import * as decisionRoute from '../../src/app/api/studio/blitz/suggestions/[id]/decision/route';
import * as angleRoute from '../../src/app/api/studio/businesses/[id]/angles/[angleId]/route';
import * as anglesRoute from '../../src/app/api/studio/businesses/[id]/angles/route';
import * as mixRoute from '../../src/app/api/studio/businesses/[id]/content-mix/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// 22.4 / 22.5 routes on Postgres: capabilities, organisation scoping, validation, audit, and that
// customers never see pence.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('22.4 / 22.5 API', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p22-${randomUUID()}`;
  const staff = { ...tenant(org, undefined, 'staff-1'), platformRole: 'staff' as const };
  const tokens = {
    owner: tenant(org),
    writer: tenant(org, ['studio:project:read', 'studio:project:write']),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-p22-other-${randomUUID()}`),
    staff,
  };
  let biz: string;
  let audits: Array<{ action: string }>;

  beforeEach(async () => {
    const installed = installApi(db, tokens);
    audits = installed.audits as Array<{ action: string }>;
    biz = `biz-${randomUUID().slice(0, 8)}`;
    await db.business.create({
      data: { id: biz, organisationId: org, name: `Bakery ${biz}`, createdByUserId: 'user-1' },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.blitzSuggestion.deleteMany({ where: { organisationId: org } });
    await db.contentAngle.deleteMany({ where: { organisationId: org } });
    await db.contentMixPreference.deleteMany({ where: { organisationId: org } });
    await db.automation.deleteMany({ where: { organisationId: org } });
    await db.business.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('angles: create (201, audited), duplicate 409, readers read, readers cannot write', async () => {
    const body = {
      title: 'Weekend bakes',
      description: 'Saturday ideas',
      targetAudience: 'families',
    };
    const created = await call(anglesRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: biz },
      body,
    });
    expect(created.status).toBe(201);
    expect(audits.some((a) => a.action === 'studio.angle.create')).toBe(true);
    const dup = await call(anglesRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: biz },
      body,
    });
    expect(dup.status).toBe(409);
    const list = await call(anglesRoute.GET, { token: 'reader', params: { id: biz } });
    expect((list.json.angles as unknown[]).length).toBe(1);
    const denied = await call(anglesRoute.POST, {
      method: 'POST',
      token: 'reader',
      params: { id: biz },
      body: { title: 'Other' },
    });
    expect(denied.status).toBe(403);
    const id = (created.json.angle as { id: string }).id;
    const retired = await call(angleRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: biz, angleId: id },
      body: { retired: true },
    });
    expect((retired.json.angle as { retired: boolean }).retired).toBe(true);
    // Another organisation cannot touch it.
    const foreign = await call(angleRoute.PATCH, {
      method: 'PATCH',
      token: 'stranger',
      params: { id: biz, angleId: id },
      body: { weight: 1 },
    });
    expect(foreign.status).toBe(404);
  });

  it('content mix: defaults (paid formats 0), validation, unknown caption styles refused', async () => {
    const mix = await call(mixRoute.GET, { token: 'owner', params: { id: biz } });
    expect(mix.json.mix).toMatchObject({
      formatWeights: { carousel: 35, slideshow: 35, ai_video: 0, ugc: 0 },
    });
    const bad = await call(mixRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: biz },
      body: { captionStyleWeights: { no_such_preset: 50 } },
    });
    expect(bad.status).toBe(400);
    const ok = await call(mixRoute.PUT, {
      method: 'PUT',
      token: 'owner',
      params: { id: biz },
      body: {
        formatWeights: { ai_video: 10 },
        captionStyleWeights: { subtitle_tiktok_classic: 60 },
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.mix).toMatchObject({ formatWeights: { ai_video: 10 } });
  });

  it('blitz deck and decisions are scoped to the organisation', async () => {
    const deck = await call(deckRoute.GET, {
      token: 'reader',
      path: `/api/studio/blitz?businessId=${biz}`,
    });
    expect(deck.status).toBe(200);
    expect((deck.json.deck as { cards: unknown[] }).cards).toEqual([]);
    const card = await db.blitzSuggestion.create({
      data: {
        organisationId: org,
        businessId: biz,
        format: 'ai_video',
        status: 'READY',
        copy: { title: 't', hook: 'h', body: ['a', 'b', 'c'], cta: '' },
        whyItWorks: 'w',
        fingerprint: randomUUID(),
      },
    });
    const foreign = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'stranger',
      params: { id: card.id },
      body: { action: 'skip' },
    });
    expect(foreign.status).toBe(404);
    const reader = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'reader',
      params: { id: card.id },
      body: { action: 'skip' },
    });
    expect(reader.status).toBe(403);
    const invalid = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: card.id },
      body: { action: 'skip', reason: 'boring' },
    });
    expect(invalid.status).toBe(400);
    const skip = await call(decisionRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: card.id },
      body: { action: 'skip', reason: 'too_salesy' },
    });
    expect(skip.status).toBe(200);
    expect((skip.json.result as { notice: unknown }).notice).toEqual({ kind: 'less_salesy' });
    expect(audits.some((a) => a.action === 'studio.blitz.skip')).toBe(true);
  });

  it('automations: create (audited), estimate without pence for customers, start needs approve rights', async () => {
    const body = {
      businessId: biz,
      cadence: { mode: 'per_week', postsPerWeek: 3 },
      duration: 'four_weeks',
      platforms: ['instagram_feed', 'tiktok'],
      costCeilingPence: 500,
    };
    const created = await call(automationsRoute.POST, { method: 'POST', token: 'owner', body });
    expect(created.status).toBe(201);
    const automation = created.json.automation as { id: string; status: string };
    expect(automation.status).toBe('DRAFT');
    expect(audits.some((a) => a.action === 'studio.automation.create')).toBe(true);
    // A customer cannot set the internal ceiling.
    const row = await db.automation.findUniqueOrThrow({ where: { id: automation.id } });
    expect(row.costCeilingPence).toBeNull();

    const estimate = await call(estimateRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        businessId: biz,
        cadence: body.cadence,
        duration: body.duration,
        platforms: body.platforms,
      },
    });
    expect(estimate.json.estimate).toMatchObject({ posts: 12, paidPosts: 0 });
    expect((estimate.json.estimate as Record<string, unknown>).estimatePence).toBeUndefined();
    const staffEstimate = await call(estimateRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: {
        businessId: biz,
        cadence: body.cadence,
        duration: body.duration,
        platforms: body.platforms,
      },
    });
    expect(typeof (staffEstimate.json.estimate as Record<string, unknown>).estimatePence).toBe(
      'number',
    );

    const writerStart = await call(automationActionRoute.POST, {
      method: 'POST',
      token: 'writer',
      params: { id: automation.id, action: 'start' },
    });
    expect(writerStart.status).toBe(403);
    const unknown = await call(automationActionRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: automation.id, action: 'explode' },
    });
    expect(unknown.status).toBe(404);
    const detail = await call(automationRoute.GET, {
      token: 'reader',
      params: { id: automation.id },
    });
    expect((detail.json.automation as { id: string }).id).toBe(automation.id);
    // 25.9: the list carries the next post time; a draft has none.
    const list = await call(automationsRoute.GET, {
      token: 'reader',
      path: `/api/studio/automations?businessId=${biz}`,
    });
    const listed = (list.json.automations as Array<{ id: string; nextPostAt: string | null }>).find(
      (a) => a.id === automation.id,
    );
    expect(listed).toMatchObject({ id: automation.id, nextPostAt: null });
    const foreign = await call(automationRoute.GET, {
      token: 'stranger',
      params: { id: automation.id },
    });
    expect(foreign.status).toBe(404);
    const invalid = await call(automationsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { ...body, cadence: { mode: 'per_day', postsPerDay: 4 } },
    });
    expect(invalid.status).toBe(400);
  });
});
