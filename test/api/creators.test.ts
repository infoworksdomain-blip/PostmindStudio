import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as creatorRoute from '../../src/app/api/studio/businesses/[id]/creators/[creatorId]/route';
import * as regenerateRoute from '../../src/app/api/studio/businesses/[id]/creators/[creatorId]/regenerate/route';
import * as retireRoute from '../../src/app/api/studio/businesses/[id]/creators/[creatorId]/retire/route';
import * as creatorsRoute from '../../src/app/api/studio/businesses/[id]/creators/route';
import * as uploadRoute from '../../src/app/api/studio/businesses/[id]/creators/upload/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { MAX_CREATORS_PER_BUSINESS } from '../../src/lib/studio/services/creators';
import { CREATOR_CONSENT_STATEMENT } from '../../src/lib/studio/services/creator-upload';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { fakePng } from '../helpers/png';

// BACKLOG 22.3 — reusable creators through the real routes and Postgres: withStudioRoute runs
// requireTenantContext → requireCapability (403 for read-only members), every query is scoped by
// organisation AND business, the portrait goes through the IMAGE_STILL route (scripted OpenAI),
// "Regenerate" makes a new portrait, uploads need the consent attestation (stored + audited), the
// real-person check refuses before anything is spent, the 20-per-business cap, and retire.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('creators API (22.3)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-creators-${randomUUID()}`;
  const other = `api-creators-other-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(other),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;

  beforeEach(async () => {
    await db.creatorPortrait.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.creator.deleteMany({ where: { organisationId: { in: [org, other] } } });
    h = createHarness(db);
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.creatorPortrait.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.creator.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.providerJob.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.$disconnect();
  });

  const input = { name: 'Maya', gender: 'woman', ageRange: '25-34', setting: 'kitchen' };
  const create = (token = 'owner', body: Record<string, unknown> = input, biz = 'biz-1') =>
    call(creatorsRoute.POST, {
      method: 'POST',
      path: `/api/studio/businesses/${biz}/creators`,
      token,
      body,
      params: { id: biz },
    });
  const list = (token = 'owner', biz = 'biz-1') =>
    call(creatorsRoute.GET, {
      path: `/api/studio/businesses/${biz}/creators`,
      token,
      params: { id: biz },
    });
  const images = () => h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image');

  it('creates a READY creator with a generated, kept portrait (audited, no cost shown)', async () => {
    const res = await create('owner', {
      ...input,
      appearance: 'short curly hair, round glasses',
      voiceTone: 'warm and upbeat',
    });
    expect(res.status).toBe(201);
    const creator = res.json.creator as Record<string, unknown>;
    expect(creator).toMatchObject({ name: 'Maya', status: 'READY', portraitSource: 'GENERATED' });
    expect(creator.portraitUrl).toEqual(expect.any(String));
    expect(JSON.stringify(creator)).not.toMatch(/costPence|s3Key|s3Bucket/);
    expect(images()).toHaveLength(1);
    expect(images()[0]).toMatchObject({ aspectRatio: '9:16' });
    expect(images()[0]?.prompt).toContain('a fictional person who does not exist');
    expect(images()[0]?.prompt).toContain('short curly hair, round glasses');
    const row = await db.creator.findUniqueOrThrow({ where: { id: creator.id as string } });
    const portrait = await db.creatorPortrait.findUniqueOrThrow({
      where: { id: row.portraitId ?? '' },
    });
    // Kept under the creator's own prefix (not a 30-day provider output), with its cost tracked.
    expect(portrait.s3Key).toMatch(new RegExp(`^orgs/${org}/creators/${row.id}/.+\\.png$`));
    expect(portrait).toMatchObject({ source: 'GENERATED', costPence: 4 });
    expect(api.audits.map((a) => a.action)).toContain('studio.creator.create');
  });

  it('requires write access, and scopes every read and write by organisation and business', async () => {
    expect((await create('reader')).status).toBe(403);
    const made = (await create()).json.creator as { id: string };
    expect((await list('owner', 'biz-2')).json.data).toEqual([]);
    expect((await list('stranger')).json.data).toEqual([]);
    const strangerRename = await call(creatorRoute.PATCH, {
      method: 'PATCH',
      token: 'stranger',
      body: { name: 'Hijack' },
      params: { id: 'biz-1', creatorId: made.id },
    });
    expect(strangerRename.status).toBe(404);
    const otherBusiness = await call(retireRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: 'biz-2', creatorId: made.id },
    });
    expect(otherBusiness.status).toBe(404);
    expect(((await list()).json.data as unknown[]).length).toBe(1);
  });

  it('refuses a real-person request before any image is generated', async () => {
    const res = await create('owner', { ...input, appearance: 'looks like Taylor Swift' });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { reason: 'ugc_real_person_refused' } });
    expect(images()).toHaveLength(0);
    expect(await db.creator.count({ where: { organisationId: org } })).toBe(0);
  });

  it(`stops at ${MAX_CREATORS_PER_BUSINESS} live creators per business; retired ones free a place`, async () => {
    await db.creator.createMany({
      data: Array.from({ length: MAX_CREATORS_PER_BUSINESS }, (_, i) => ({
        organisationId: org,
        businessId: 'biz-1',
        name: `C${i}`,
        gender: 'man',
        ageRange: '25-34',
        setting: 'desk',
        description: 'a man around thirty',
        createdByUserId: 'user-1',
      })),
    });
    const full = await create();
    expect(full.status).toBe(409);
    expect(full.json).toMatchObject({ details: { reason: 'creator_limit' } });
    expect(images()).toHaveLength(0);
    const one = await db.creator.findFirstOrThrow({ where: { organisationId: org } });
    const retired = await call(retireRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: 'biz-1', creatorId: one.id },
    });
    expect(retired.json.creator).toMatchObject({ status: 'RETIRED', isDefault: false });
    expect((await create()).status).toBe(201);
    expect(api.audits.map((a) => a.action)).toContain('studio.creator.retire');
  });

  it('a refused portrait leaves a DRAFT creator; Regenerate (with instructions) makes it READY', async () => {
    const original = h.adapters.openai.respond;
    h.adapters.openai.respond = () => ({
      state: 'failed',
      error: { class: 'content_policy', message: 'refused', retryable: false },
    });
    const draft = await create();
    expect(draft.status).toBe(201);
    expect(draft.json.creator).toMatchObject({ status: 'DRAFT', portraitError: 'content_policy' });
    const id = (draft.json.creator as { id: string }).id;
    h.adapters.openai.respond = original;
    const regenerated = await call(regenerateRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { instructions: 'a bigger smile' },
      params: { id: 'biz-1', creatorId: id },
    });
    expect(regenerated.status).toBe(200);
    expect(regenerated.json.creator).toMatchObject({ status: 'READY', portraitError: null });
    expect(images().at(-1)?.prompt).toContain('Adjustments: a bigger smile.');
    const refused = await call(regenerateRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { instructions: 'make him look like David Beckham' },
      params: { id: 'biz-1', creatorId: id },
    });
    expect(refused.status).toBe(400);
  });

  it('an upload needs the consent attestation, which is stored with who and when', async () => {
    const upload = async (fields: Record<string, string>, file?: File) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      if (file) form.set('photo', file);
      const { body, headers } = await multipart(form);
      return call(uploadRoute.POST, {
        method: 'POST',
        token: 'owner',
        body,
        headers,
        params: { id: 'biz-1' },
      });
    };
    const photo = new File([fakePng(600, 800, 1)], 'amara.png', { type: 'image/png' });
    expect((await upload(input, photo)).status).toBe(400);
    expect((await upload({ ...input, consent: 'true' })).status).toBe(400);
    const notImage = new File([new Uint8Array([1, 2, 3, 4])], 'x.png', { type: 'image/png' });
    expect((await upload({ ...input, consent: 'true' }, notImage)).status).toBe(400);
    const res = await upload({ ...input, name: 'Amara', consent: 'true' }, photo);
    expect(res.status).toBe(201);
    expect(res.json.creator).toMatchObject({ status: 'READY', portraitSource: 'UPLOAD' });
    const row = await db.creator.findFirstOrThrow({ where: { organisationId: org } });
    const portrait = await db.creatorPortrait.findUniqueOrThrow({
      where: { id: row.portraitId ?? '' },
    });
    expect(portrait).toMatchObject({
      source: 'UPLOAD',
      consentAttestedByUserId: 'user-1',
      consentStatement: CREATOR_CONSENT_STATEMENT,
    });
    expect(portrait.consentAttestedAt).toBeInstanceOf(Date);
    expect(images()).toHaveLength(0);
    const audit = api.audits.find((a) => a.action === 'studio.creator.create');
    expect(audit?.metadata).toMatchObject({ source: 'UPLOAD', consentAttestedByUserId: 'user-1' });
  });

  it('renames and makes one creator the business default', async () => {
    const a = (await create()).json.creator as { id: string };
    const b = (await create('owner', { ...input, name: 'Tom', gender: 'man' })).json.creator as {
      id: string;
    };
    const patch = (id: string, body: Record<string, unknown>) =>
      call(creatorRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        body,
        params: { id: 'biz-1', creatorId: id },
      });
    expect((await patch(a.id, { isDefault: true })).json.creator).toMatchObject({
      isDefault: true,
    });
    expect((await patch(b.id, { isDefault: true, name: 'Tommy' })).json.creator).toMatchObject({
      isDefault: true,
      name: 'Tommy',
    });
    const rows = await db.creator.findMany({ where: { organisationId: org, isDefault: true } });
    expect(rows.map((r) => r.id)).toEqual([b.id]);
    expect((await patch(a.id, {})).status).toBe(400);
  });
});
